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
| Auto-generated `.Default` layer                     | No auto layer -- but we're skipping layers entirely (see below)           |
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
5. **No Layer** -- Use `CloudflareEnv` service directly, no `Layer.effect`

## The Core Problem

We want:

- D1 in the ServiceMap (so other services can `yield* D1`)
- D1's construction to `yield* CloudflareEnv` (proper service dependency)

But: `ServiceMap.add(tag, value)` takes a **plain value**, not an Effect. Building D1 requires `yield*` (effectful). This is the fundamental tension.

After scanning `refs/effect4` exhaustively (ServiceMap.ts, Effect.ts, ManagedRuntime.ts, internal/effect.ts, tests, specs, patterns):

- **ServiceMap is purely synchronous** -- no effectful construction API
- **Layer is the bridge** from effectful construction to ServiceMap
- **`Effect.provideServiceEffect`** is the only layer-free way to wire "service A needs service B"

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

## Approach A: `provideServiceEffect` in `makeRunEffect`

D1's `make` is an Effect that `yield*`s CloudflareEnv. The runner wraps every program with `provideServiceEffect` so D1 is transparently available.

```ts
// src/lib/d1.ts (additional export)
export const makeD1 = Effect.gen(function* () {
  const { D1: d1 } = yield* CloudflareEnv;
  return D1.of({
    prepare: (query) => d1.prepare(query),
    batch: (statements) => tryD1(() => d1.batch(statements)),
    run: (statement) => tryD1(() => statement.run()),
    first: <T>(statement: D1PreparedStatement) =>
      tryD1(() => statement.first<T>()),
  });
});
```

```ts
// src/lib/effect-services.ts
import { D1, makeD1 } from "./d1";

export const makeRunEffect = (env: Env) => {
  const baseRun = Effect.runPromiseWith(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
  );
  return <A, E>(effect: Effect.Effect<A, E /* D1 | CloudflareEnv | ... */>) =>
    baseRun(effect.pipe(Effect.provideServiceEffect(D1, makeD1)));
};
```

```ts
// Consumer usage -- D1 just works
const program = Effect.gen(function* () {
  const d1 = yield* D1;
  const stmt = d1.prepare("select * from User where id = ?").bind(userId);
  return yield* d1.first<{ id: string; email: string }>(stmt);
});
runEffect(program); // D1 provided automatically
```

**How it works**: `provideServiceEffect(D1, makeD1)` says "when something needs D1, run `makeD1` to build it". `makeD1` yields CloudflareEnv which is in the base ServiceMap. The `provideServiceEffect` call eliminates `D1` from the `R` type of the effect, so `baseRun` (which has CloudflareEnv) can satisfy the remaining requirement.

**Tradeoffs**:

- D1 is available as a proper service tag -- consumers `yield* D1`
- D1 `yield*`s CloudflareEnv (proper dependency)
- D1 is rebuilt on every `runEffect` call (no caching). Fine -- construction is cheap (just wrapping `env.D1`).
- Each new dependent service needs another `provideServiceEffect` in `makeRunEffect`
- Type signature of `makeRunEffect` return gets wider as services are added

<!-- annotate: A -->

## Approach B: `ManagedRuntime` + Layer

Uses the official `Layer` -> `ManagedRuntime` pattern. D1 is a layer that depends on CloudflareEnv layer.

```ts
// src/lib/d1.ts (additional export)
export const makeD1 = Effect.gen(function* () {
  const { D1: d1 } = yield* CloudflareEnv;
  return D1.of({
    prepare: (query) => d1.prepare(query),
    batch: (statements) => tryD1(() => d1.batch(statements)),
    run: (statement) => tryD1(() => statement.run()),
    first: <T>(statement: D1PreparedStatement) =>
      tryD1(() => statement.first<T>()),
  });
});

export const D1Layer = Layer.effect(D1)(makeD1);
```

```ts
// src/lib/effect-services.ts
import { Layer, ManagedRuntime } from "effect";
import { D1Layer } from "./d1";

export const makeRunEffect = (env: Env) => {
  const appLayer = Layer.mergeAll(
    Layer.succeed(CloudflareEnv)(env),
    D1Layer,
    Layer.succeed(ConfigProvider.ConfigProvider)(
      ConfigProvider.fromUnknown(env),
    ),
  ).pipe(Layer.provide(Layer.succeed(CloudflareEnv)(env)));
  const runtime = ManagedRuntime.make(appLayer);
  return runtime.runPromise;
};
```

```ts
// Consumer usage -- identical
const program = Effect.gen(function* () {
  const d1 = yield* D1;
  return yield* d1.first<{ id: string; email: string }>(stmt);
});
runEffect(program);
```

**Tradeoffs**:

- D1 is in the ServiceMap, proper service tag, `yield*`s CloudflareEnv
- Layer caches D1 construction (only built once per runtime)
- ManagedRuntime provides `runPromise`, `runSync`, `runFork` etc.
- ManagedRuntime has `dispose()` for cleanup (relevant for scoped resources)
- Adding services = adding layers, composable via `Layer.mergeAll` / `Layer.provide`
- More boilerplate than Approach A
- Involves Layer (which you said you wanted to avoid)

<!-- annotate: B -->

## Approach C: Eager pure build (no `yield*` on CloudflareEnv)

D1 construction is actually pure -- `env.D1` is a synchronous binding. Build D1Shape directly from `D1Database` without needing an Effect.

```ts
// src/lib/d1.ts (additional export -- pure function, not an Effect)
export const makeD1Shape = (d1: D1Database): D1Shape => ({
  prepare: (query) => d1.prepare(query),
  batch: (statements) => tryD1(() => d1.batch(statements)),
  run: (statement) => tryD1(() => statement.run()),
  first: <T>(statement: D1PreparedStatement) =>
    tryD1(() => statement.first<T>()),
});
```

```ts
// src/lib/effect-services.ts
import { D1, makeD1Shape } from "./d1";

export const makeRunEffect = (env: Env) =>
  Effect.runPromiseWith(
    ServiceMap.make(CloudflareEnv, env)
      .pipe(ServiceMap.add(D1, makeD1Shape(env.D1)))
      .pipe(
        ServiceMap.add(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(env),
        ),
      ),
  );
```

```ts
// Consumer usage -- identical
const program = Effect.gen(function* () {
  const d1 = yield* D1;
  return yield* d1.first<{ id: string; email: string }>(stmt);
});
runEffect(program);
```

**Tradeoffs**:

- D1 is in the ServiceMap, proper service tag, consumers `yield* D1`
- Simplest -- no Layer, no `provideServiceEffect` chain
- D1 does NOT `yield*` CloudflareEnv -- takes `D1Database` directly as a function arg
- `makeRunEffect` passes `env.D1` explicitly, coupling the wiring site to knowing env shape
- Works well when D1 construction is trivially derived from env (which it is)
- If D1 construction later needs effectful setup (connection pooling, etc.), would need to switch to A or B

<!-- annotate: C -->

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
