# D1 Effect Service - Migration Research

Bringing `refs/cerr/functions/shared/src/D1.ts` into our codebase using Effect 4 idioms.

## Source: cerr D1.ts (Effect 3)

```ts
import {
  Cause,
  Config,
  ConfigError,
  Data,
  Effect,
  Either,
  Predicate,
  Schedule,
} from "effect";
import { dual } from "effect/Function";
import * as ConfigEx from "./ConfigEx";

export class D1Error extends Data.TaggedError("D1Error")<{
  message: string;
  cause: Error;
}> {}

export class D1 extends Effect.Service<D1>()("D1", {
  accessors: true,
  effect: Effect.gen(function* () {
    const d1 = yield* ConfigEx.object("D1").pipe(
      Config.mapOrFail((object) =>
        "prepare" in object &&
        typeof object.prepare === "function" &&
        "batch" in object &&
        typeof object.batch === "function"
          ? Either.right(object as D1Database)
          : Either.left(
              ConfigError.InvalidData(
                [],
                `Expected a D1 database but received ${object}`,
              ),
            ),
      ),
    );
    const tryPromise = <A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) =>
      Effect.tryPromise(evaluate).pipe(
        Effect.mapError((error) =>
          Cause.isUnknownException(error) &&
          Predicate.isError(error.error) &&
          error.error.message.startsWith("D1_")
            ? new D1Error({ message: error.error.message, cause: error.error })
            : error,
        ),
        Effect.tapError((error) => Effect.log(error)),
        Effect.retry({
          while: (error) =>
            Predicate.isTagged(error, "D1Error") &&
            !["SQLITE_CONSTRAINT", "SQLITE_ERROR", "SQLITE_MISMATCH"].some(
              (pattern) => error.message.includes(pattern),
            ),
          times: 2,
          schedule: Schedule.exponential("1 second"),
        }),
      );
    return {
      prepare: (query: string) => d1.prepare(query),
      batch: (statements: D1PreparedStatement[]) =>
        tryPromise(() => d1.batch(statements)),
      run: (statement: D1PreparedStatement) =>
        tryPromise(() => statement.run()),
      first: <T>(statement: D1PreparedStatement) =>
        tryPromise(() => statement.first<T>()),
    };
  }),
}) {}
```

## What cerr D1.ts Does

1. **Gets D1Database from env** via `ConfigEx.object('D1')` -- pulls the `D1` binding from Cloudflare env, validates it has `prepare`/`batch` methods
2. **Wraps D1 operations** with `tryPromise` that:
   - Maps Cloudflare D1 errors (prefixed `D1_`) to typed `D1Error`
   - Logs errors via `Effect.tapError`
   - Retries transient errors (exponential backoff, 2 retries) -- skips `SQLITE_CONSTRAINT`, `SQLITE_ERROR`, `SQLITE_MISMATCH`
3. **Exposes**: `prepare`, `batch`, `run`, `first`

## Effect 3 -> Effect 4 Translation Issues

### 1. `Effect.Service` -> `ServiceMap.Service`

cerr uses Effect 3's `Effect.Service<D1>()('D1', { accessors: true, effect: ... })`.

Effect 4 equivalent: `ServiceMap.Service` with `make` option, then explicit `Layer.effect`.

```ts
// Effect 3
class D1 extends Effect.Service<D1>()('D1', {
  accessors: true,
  effect: Effect.gen(function* () { ... })
}) {}
// D1.Default auto-generated layer

// Effect 4
class D1 extends ServiceMap.Service<D1, D1Shape>()('D1', {
  make: Effect.gen(function* () { ... })
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(/* dependencies */)
  )
}
```

Key differences:

- `accessors: true` removed -- use `D1.use(d1 => d1.prepare(...))` or `yield* D1` in generators
- `effect` option -> `make` option
- No auto-generated `.Default` layer -- define `.layer` explicitly
- `dependencies` option removed -- use `Layer.provide()`

### 2. `ConfigEx.object('D1')` -> `CloudflareEnv` Service

cerr uses `ConfigEx` to pull the D1 binding from Cloudflare env via Config system. We don't have `ConfigEx`. Our codebase already has:

```ts
// src/lib/effect-services.ts
export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");
```

Instead of pulling D1 from Config, we yield CloudflareEnv and access `.D1` directly:

```ts
// Effect 3 (cerr)
const d1 = yield* ConfigEx.object('D1').pipe(Config.mapOrFail(...))

// Effect 4 (ours)
const env = yield* CloudflareEnv
const d1 = env.D1
```

This is simpler and fully typed -- `Env` from `worker-configuration.d.ts` already has `D1: D1Database`.

### 3. Error Handling Changes

| Effect 3                          | Effect 4                                                |
| --------------------------------- | ------------------------------------------------------- |
| `Cause.isUnknownException(error)` | TBD -- check if `Cause.isUnknownException` still exists |
| `Effect.catchAll`                 | `Effect.catch`                                          |
| `Effect.catchAllCause`            | `Effect.catchCause`                                     |
| `Data.TaggedError`                | Still exists in Effect 4                                |
| `Predicate.isTagged`              | Still exists                                            |
| `Schedule.exponential`            | Still exists                                            |
| `Effect.retry`                    | Still exists                                            |

### 4. `dual` from `effect/Function`

Still exists in Effect 4 -- no change needed for the `bind` helper.

## Proposed Effect 4 D1 Service

### Approach A: Lightweight (match cerr's surface area)

Keeps the same simple API (`prepare`, `batch`, `run`, `first`) but uses our `CloudflareEnv` service.

```ts
import { Data, Effect, Layer, Predicate, Schedule, ServiceMap } from "effect";

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

class D1 extends ServiceMap.Service<D1, D1Shape>()("D1", {
  make: Effect.gen(function* () {
    const env = yield* CloudflareEnv;
    const d1 = env.D1;

    const tryD1 = <A>(evaluate: () => Promise<A>) =>
      Effect.tryPromise({ try: evaluate, catch: (e) => e }).pipe(
        Effect.mapError((error) =>
          error instanceof Error && error.message.startsWith("D1_")
            ? new D1Error({ message: error.message, cause: error })
            : new D1Error({
                message: String(error),
                cause:
                  error instanceof Error ? error : new Error(String(error)),
              }),
        ),
        Effect.tapError((error) => Effect.log(error)),
        Effect.retry({
          while: (error) =>
            !["SQLITE_CONSTRAINT", "SQLITE_ERROR", "SQLITE_MISMATCH"].some(
              (p) => error.message.includes(p),
            ),
          times: 2,
          schedule: Schedule.exponential("1 second"),
        }),
      );

    return D1.of({
      prepare: (query) => d1.prepare(query),
      batch: (statements) => tryD1(() => d1.batch(statements)),
      run: (statement) => tryD1(() => statement.run()),
      first: <T>(statement: D1PreparedStatement) =>
        tryD1(() => statement.first<T>()),
    });
  }),
}) {
  static layer = Layer.effect(this, this.make);
  // CloudflareEnv must be provided when this layer is built
}
```

Usage:

```ts
const program = Effect.gen(function* () {
  const d1 = yield* D1;
  const stmt = d1.prepare("select * from User where id = ?").bind(userId);
  const user = yield* d1.first<{ id: string; email: string }>(stmt);
  return user;
});

// Run with:
runEffect(program.pipe(Effect.provide(D1.layer)));
```

### Approach B: Use official @effect/sql-d1 pattern

Check if supports batch. If not, reduce this section saying we're not using due to no batch support.

The official `D1Client` from `refs/effect4/packages/sql/d1/src/D1Client.ts` provides:

- `SqlClient` interface with prepared statement caching
- Column name transforms
- Span attributes for tracing
- `Reactivity` integration

BUT: it requires `effect/unstable/sql/*` modules which may not be available in `effect@4.0.0-beta.5`. Also heavier -- we'd need to adopt the full `SqlClient` interface.

```ts
import * as D1Client from "effect/unstable/sql-d1/D1Client";

const D1Layer = D1Client.layer({ db: env.D1 });
```

### Recommendation: Approach A

- Matches cerr's surface area which is what the codebase actually needs
- Simpler, no dependency on unstable sql modules
- Uses our existing `CloudflareEnv` service directly
- Easy to extend later

## Integration with Existing Codebase

### Current D1 usage (non-Effect)

```ts
// worker.ts
const d1SessionService = createD1SessionService({ d1: env.D1, request, ... })
const repository = createRepository({ db: d1SessionService.getSession() })
```

### With Effect D1 service

The D1 service provides effectful wrappers around raw D1 calls. It doesn't replace the repository pattern but could be used inside repository functions for retry/error handling.

Two integration paths:

**Path 1: D1 service inside existing repository** -- Repository functions use `yield*` D1 service internally. Repository itself becomes an Effect service.

**Path 2: D1 service alongside repository** -- New effectful code paths use D1 service directly. Existing repository stays as-is.

## Open Questions

<!-- annotate below -->

1. Do we want D1 session (bookmark) support in the Effect D1 service? Currently `d1-session-service.ts` wraps D1 with `withSession(bookmark)` for read-after-write consistency.

Defer

2. Should the D1 service return raw `D1Result` types or decode with Effect Schema?

Raw

3. Do we want the `bind` dual helper from cerr? It lets you pipe bind values:

   ```ts
   yield *
     D1.prepare("select * from User where id = ?").pipe(D1Ns.bind(userId));
   ```

Keep

4. Should `tryD1` error mapping be more granular? cerr checks `Cause.isUnknownException` which may not exist in Effect 4.

Check if that exists in Effect 4. We'll probably need to iterate on tryD1 later.

5. Layer wiring: should `D1.layer` be pre-provided with `CloudflareEnv` in `makeRunEffect`, or provided at call site?

How can we do this without layer? Prefer to use CloudflareEnv service directly to get 
D1 binding.
