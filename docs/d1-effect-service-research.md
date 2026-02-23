# D1 Effect Service - Migration Research

Bringing `refs/cerr/functions/shared/src/D1.ts` into our codebase using Effect 4 idioms.

## Source Analysis

cerr D1.ts (Effect 3) provides:

1. `D1Error` -- typed error via `Data.TaggedError`
2. `D1` service -- gets D1Database from env via `ConfigEx.object('D1')`, wraps ops with retry/error handling
3. `bind` dual helper -- pipe-friendly bind for prepared statements

Surface area: `prepare`, `batch`, `run`, `first`

## Effect 3 -> Effect 4 Key Translations

| Effect 3 (cerr)                                     | Effect 4 (ours)                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `Effect.Service<D1>()('D1', { accessors, effect })` | `ServiceMap.Service<D1, Shape>()('D1', { make })`                         |
| `ConfigEx.object('D1')`                             | `yield* CloudflareEnv` then `.D1`                                         |
| `Cause.isUnknownException(e)`                       | `Cause.isUnknownError(e)` -- renamed, cause in `Error.cause` not `.error` |
| `Effect.catchAll`                                   | `Effect.catch`                                                            |
| Auto-generated `.Default` layer                     | No auto layer -- define `layer` export explicitly                         |
| `accessors: true`                                   | Removed -- use `yield* D1` or `D1.use(...)`                               |

### `Cause.isUnknownError` (Effect 4)

Confirmed exists: `Cause.isUnknownError` is the Effect 4 replacement for `Cause.isUnknownException`. The type is `Cause.UnknownError` with `_tag: "UnknownError"`. Original cause stored in standard `Error.cause` (not `.error` like Effect 3's `UnknownException`). `Effect.tryPromise` without `catch` defaults to wrapping in `Cause.UnknownError`.

### `@effect/sql-d1` -- Not Using

Official D1Client has no `batch` support. It wraps D1 with SqlClient interface (single-statement execute/executeRaw/executeValues). We need `batch` for multi-statement atomic operations. Also depends on `effect/unstable/sql/*` + `Reactivity`.

## Decisions (from annotations)

1. **D1 session/bookmark support** -- Defer
2. **Return types** -- Raw D1 types, no Schema decoding in the service
3. **`bind` dual helper** -- Keep
4. **`tryD1` error mapping** -- Use `Cause.isUnknownError` + `Error.cause`. Will iterate later.

## The Core Problem

We want:

- D1 in the ServiceMap (so other services can `yield* D1`)
- D1's construction to `yield* CloudflareEnv` (proper service dependency)
- A general pattern that works for any service with effectful construction

`ServiceMap.add(tag, value)` takes a **plain value**, not an Effect. Building D1 requires `yield*` (effectful). This is the fundamental tension.

## Key Discovery: `Effect.provide` Accepts Layers (with auto-memoization)

Deep scan of `refs/effect4` revealed:

1. **`Effect.provide(layer)`** accepts a Layer (not just a ServiceMap). See `refs/effect4/packages/effect/src/internal/layer.ts:8-22`.
2. **In Effect 4, layers are auto-memoized across `Effect.provide` calls** via a fiber-level shared `MemoMap`. This is NEW vs Effect 3 where each `provide` call had its own memo scope. See `refs/effect4/migration/layer-memoization.md`.
3. **`Layer.effect(tag)(effectThatBuildsService)`** creates a Layer from an Effect that can `yield*` other services. See `refs/effect4/packages/effect/src/Layer.ts:764-783`.

This means: define your service construction as a Layer, provide it via `Effect.provide`, and it's automatically lazy + cached. No ManagedRuntime needed. No lifecycle to manage. Layer is just the declarative recipe.

```ts
// From refs/effect4/migration/layer-memoization.md
const MyServiceLayer = Layer.effect(MyService)(
  Effect.gen(function* () {
    yield* Console.log("Building MyService"); // logged ONCE even across multiple provide calls
    return { value: "hello" };
  }),
);

const program = Effect.gen(function* () {
  const a = yield* MyService;
  return a.value;
}).pipe(Effect.provide(MyServiceLayer));
```

### How `Effect.provide(layer)` works internally

```ts
// refs/effect4/packages/effect/src/internal/layer.ts:8-22
const provideLayer = (self, layer, options?) =>
  effect.scopedWith((scope) =>
    effect.flatMap(
      options?.local
        ? Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope)
        : Layer.buildWithScope(layer, scope), // uses fiber's shared MemoMap
      (context) => effect.provideServices(self, context),
    ),
  );
```

`Layer.buildWithScope` pulls the MemoMap from the current fiber (`CurrentMemoMap.getOrCreate(fiber.services)`) -- so all `Effect.provide(layer)` calls in the same fiber share the same cache. The layer's Effect runs once, result is cached.

### Other mechanisms found (not recommended for our case)

- **`Effect.provideServiceEffect`** -- no caching, rebuilds every call (`flatMap` internally)
- **`Effect.cached`** -- manual memoization wrapper, adds nesting complexity
- **`ManagedRuntime.make(layer)`** -- full lifecycle management with dispose(), overkill
- **`Layer.fresh(layer)`** / `Effect.provide(layer, { local: true })` -- opt OUT of memoization

## Shared Code (all approaches use this)

```ts
// src/lib/d1.ts
import { Cause, Data, Effect, Schedule, ServiceMap } from "effect";
import { dual } from "effect/Function";
import { CloudflareEnv } from "./effect-services";

export class D1Error extends Data.TaggedError("D1Error")<{
  readonly message: string;
  readonly cause: Error;
}> {}

interface D1Shape {
  readonly prepare: (query: string) => D1PreparedStatement;
  readonly batch: (
    statements: D1PreparedStatement[],
  ) => Effect.Effect<D1Result[], D1Error>;
  readonly run: (
    statement: D1PreparedStatement,
  ) => Effect.Effect<D1Result, D1Error>;
  readonly first: <T>(
    statement: D1PreparedStatement,
  ) => Effect.Effect<T | null, D1Error>;
}

export const D1 = ServiceMap.Service<D1Shape>("D1");

const NON_RETRYABLE = [
  "SQLITE_CONSTRAINT",
  "SQLITE_ERROR",
  "SQLITE_MISMATCH",
] as const;

const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => {
      const cause = Cause.isUnknownError(error) ? error.cause : error;
      const underlying =
        cause instanceof Error ? cause : new Error(String(cause));
      return new D1Error({ message: underlying.message, cause: underlying });
    }),
    Effect.tapError((error) => Effect.log(error)),
    Effect.retry({
      while: (error) => !NON_RETRYABLE.some((p) => error.message.includes(p)),
      times: 2,
      schedule: Schedule.exponential("1 second"),
    }),
  );

export const bind = dual<
  (
    ...values: unknown[]
  ) => <E, R>(
    self: Effect.Effect<D1PreparedStatement, E, R>,
  ) => Effect.Effect<D1PreparedStatement, E, R>,
  <E, R>(
    ...args: [Effect.Effect<D1PreparedStatement, E, R>, ...unknown[]]
  ) => Effect.Effect<D1PreparedStatement, E, R>
>(
  (args) => Effect.isEffect(args[0]),
  (self, ...values) => Effect.map(self, (stmt) => stmt.bind(...values)),
);
```

## Approach D: `Layer.effect` + `Effect.provide` (recommended)

Layer as declarative recipe. `Effect.provide` at the runner wires it in with auto-memoization. No ManagedRuntime, no lifecycle management.

```ts
// src/lib/d1.ts (additional exports)
const make = Effect.gen(function* () {
  const { D1: d1 } = yield* CloudflareEnv;
  return D1.of({
    prepare: (query) => d1.prepare(query),
    batch: (statements) => tryD1(() => d1.batch(statements)),
    run: (statement) => tryD1(() => statement.run()),
    first: <T>(statement: D1PreparedStatement) =>
      tryD1(() => statement.first<T>()),
  });
});

export const layer = Layer.effect(D1)(make);
```

```ts
// src/lib/effect-services.ts
import { ConfigProvider, Effect, Layer, ServiceMap } from "effect";
import * as D1Mod from "./d1";

export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

export const makeRunEffect = (env: Env) => {
  const baseServices = ServiceMap.make(CloudflareEnv, env)
    .pipe(
      ServiceMap.add(Greeting, {
        greet: () => "Hello from Effect 4 ServiceMap!",
      }),
    )
    .pipe(
      ServiceMap.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    );

  const run = Effect.runPromiseWith(baseServices);

  return <A, E>(effect: Effect.Effect<A, E>) =>
    run(effect.pipe(Effect.provide(D1Mod.layer)));
};
```

```ts
// Consumer usage -- D1 just works
import { D1 } from "./d1";

const program = Effect.gen(function* () {
  const d1 = yield* D1;
  const stmt = d1.prepare("select * from User where id = ?").bind(userId);
  return yield* d1.first<{ id: string; email: string }>(stmt);
});
runEffect(program); // D1 provided automatically
```

**How it works**:

1. `layer = Layer.effect(D1)(make)` -- declarative: "to build D1, run this Effect"
2. `effect.pipe(Effect.provide(D1Mod.layer))` -- tells the runtime to provide D1 via the layer
3. Internally, `Effect.provide` calls `Layer.buildWithScope` which uses the fiber's shared `MemoMap`
4. First call builds D1 (runs `make`, which `yield*`s CloudflareEnv from `baseServices`). Subsequent calls in the same fiber reuse the cached result.
5. `Effect.provide` eliminates `D1` from the `R` type. `baseServices` (via `runPromiseWith`) satisfies `CloudflareEnv`.

**Why this is the general pattern**:

- Works for ANY service with effectful construction -- just `Layer.effect(Tag)(makeEffect)`
- `makeEffect` can `yield*` any other service (proper dependency graph)
- Auto-memoized -- no manual caching, no `Effect.cached` wrapping
- No ManagedRuntime lifecycle to manage
- Adding services = adding layers, composable: `Effect.provide([D1Mod.layer, AuthMod.layer, ...])`
- Layer composition via `Layer.provide` for inter-layer dependencies

**Scaling to multiple services**:

```ts
import * as AuthMod from "./auth";

// In makeRunEffect -- provide all layers
return <A, E>(effect: Effect.Effect<A, E>) =>
  run(effect.pipe(Effect.provide([D1Mod.layer, AuthMod.layer])));

// Or compose layers that depend on each other
const appLayer = Layer.mergeAll(D1Mod.layer, AuthMod.layer).pipe(
  Layer.provide(SomeSharedDep.layer),
);
return <A, E>(effect: Effect.Effect<A, E>) =>
  run(effect.pipe(Effect.provide(appLayer)));
```

<!-- annotate: D -->

---

### Previous approaches (superseded by D)

<details>
<summary>Approach A: provideServiceEffect (no caching)</summary>

Used `Effect.provideServiceEffect(D1, makeD1)` in `makeRunEffect`. Problem: `provideServiceEffect` is just `flatMap(acquire, provideService)` -- no memoization, rebuilds every call. `Effect.cached` can fix it but adds nesting. Approach D is strictly better -- same effectful construction, but with auto-memoization via Layer.

</details>

<details>
<summary>Approach B: ManagedRuntime + Layer (lifecycle overhead)</summary>

Used `ManagedRuntime.make(appLayer)`. Gets Layer's memoization but adds lifecycle management (`dispose()`) that we don't need. Approach D uses the same Layer mechanism but without ManagedRuntime.

</details>

<details>
<summary>Approach C: Eager pure build (no yield*)</summary>

Used `makeD1Shape(env.D1)` -- pure function, no Effect. Works for D1 specifically but doesn't generalize. Services needing effectful construction can't use this pattern.

</details>

## Layer Naming Convention (Effect 4)

From `refs/effect4/migration/services.md:196-199`:

> v4 adopts the convention of naming layers with `layer` (e.g. `Logger.layer`) instead of v3's `Default` or `Live`. Use `layer` for the primary layer and descriptive suffixes for variants (e.g. `layerTest`, `layerConfig`).

| Purpose            | Name             | Example                                             |
| ------------------ | ---------------- | --------------------------------------------------- |
| Primary/production | `layer`          | `export const layer = Layer.effect(D1)(make)`       |
| Test/mock          | `layerTest`      | `export const layerTest = Layer.succeed(D1)({...})` |
| Variant            | `layer{Variant}` | `layerPosix`, `layerConfig`, `layerClient`          |

Consumers use namespace imports so names read as `D1Mod.layer`, `Auth.layer`, etc.

### Examples from Effect 4 source

Module-level exports:

```ts
// refs/effect4/packages/platform-node-shared/src/NodeFileSystem.ts:640
export const layer: Layer.Layer<FileSystem> = Layer.effect(FileSystem.FileSystem)(makeFileSystem)

// refs/effect4/packages/platform-node-shared/src/NodePath.ts:37,48
export const layerPosix: Layer.Layer<Path> = ...
export const layerWin32: Layer.Layer<Path> = ...

// refs/effect4/packages/platform-node/src/NodeHttpServer.ts:411
export const layerTest: Layer.Layer<...>

// refs/effect4/packages/ai/openai/src/OpenAiClient.ts:270
export const layer = (options: Options): Layer.Layer<OpenAiClient, ...>
```

Static members on ServiceMap.Service classes (same convention, just on a class):

```ts
// refs/effect4/packages/effect/test/cluster/TestEntity.ts:67
static layer = Layer.effect(this)(this.make)

// refs/effect4/packages/sql/d1/test/utils.ts:14,31
static layer = Layer.effect(this)(...)
static layerClient = Layer.unwrap(...)
```

The v3 `Live` suffix still appears in some test fixtures and JSDoc examples (`JsonPlaceholderLive`, `AuthLive`) but the migration guide explicitly moves away from it.

## `Layer.unwrap` -- Effect that produces a Layer

`Layer.unwrap` converts `Effect<Layer<A, E1, R1>, E, R>` into `Layer<A, E | E1, R1 | R>`.

Signature from `refs/effect4/packages/effect/src/Layer.ts:869-874`:

```ts
export const unwrap = <A, E1, R1, E, R>(
  self: Effect<Layer<A, E1, R1>, E, R>
): Layer<A, E | E1, R1 | Exclude<R, Scope.Scope>>
```

Use case: when your effectful construction produces a **Layer** (not a service value). This happens when you need to `yield*` to get config/dependencies, then use those to call another function that returns a Layer.

### Examples from Effect 4 source

```ts
// refs/effect4/packages/sql/d1/test/utils.ts:31-37
// Need to yield* D1Miniflare to get the db, then call D1Client.layer({ db }) which returns a Layer
static layerClient = Layer.unwrap(
  Effect.gen(function*() {
    const miniflare = yield* D1Miniflare
    const db: D1Database = yield* Effect.tryPromise(() => miniflare.getD1Database("DB"))
    return D1Client.layer({ db })   // <-- returns a Layer, not a service value
  })
).pipe(Layer.provide(this.layer))

// refs/effect4/packages/platform-node/src/NodeClusterHttp.ts:129-136
// Need to yield* config to determine which server layer to return
export const layerHttpServer = Effect.gen(function*() {
  const config = yield* ShardingConfig.ShardingConfig
  const listenAddress = config.runnerListenAddress ?? config.runnerAddress
  return NodeHttpServer.layer(createServer, listenAddress)  // <-- returns a Layer
}).pipe(Layer.unwrap)

// refs/effect4/packages/platform-node/test/NodeRedis.test.ts:8-21
// Need to yield* (acquire a container), then use its host/port to make a Layer
const RedisLayer = Layer.unwrap(
  Effect.gen(function*() {
    const container = yield* Effect.acquireRelease(
      Effect.promise(() => new RedisContainer("redis:alpine").start()),
      (container) => Effect.promise(() => container.stop())
    )
    return NodeRedis.layer({ host: container.getHost(), port: container.getMappedPort(6379) })
  })
)
```

### `Layer.effect` vs `Layer.unwrap`

|                | `Layer.effect(tag)(effect)`          | `Layer.unwrap(effect)`                        |
| -------------- | ------------------------------------ | --------------------------------------------- |
| Effect returns | service value (`D1Shape`)            | a Layer (`Layer<D1, ...>`)                    |
| Use when       | you're building the service directly | you're calling something that returns a Layer |
| Our D1         | yes -- we build D1Shape directly     | no -- not needed                              |

`Layer.unwrap` is not needed for our D1 service since `make` returns the service value directly. It would be relevant if, say, we were wrapping `D1Client.layer({ db })` from `@effect/sql-d1` (which returns a Layer) after fetching `db` effectfully.

## `bind` Helper

Kept from cerr. Enables piped bind syntax:

```ts
// import * as D1Ns from './D1'
// import { D1 } from './D1'
yield *
  D1.prepare("select userId, email from users where userId = ?").pipe(
    D1Ns.bind(3),
  );
```

Note: `D1.prepare(...)` returns a plain `D1PreparedStatement` (not an Effect), so the `bind` dual wraps an `Effect<D1PreparedStatement>`. This is useful when chaining effectful operations but for simple cases, `d1.prepare(query).bind(value)` works directly.

## File Structure

```
src/lib/
  d1.ts                  # D1Error, D1 service tag, D1Shape, tryD1, bind, + approach-specific exports
  effect-services.ts     # CloudflareEnv, makeRunEffect (wires D1 into ServiceMap)
```
