# Effect v4 + TanStack Start Server Fn Error Handling

## Current Problem

`runEffect` (`src/lib/effect-services.ts:46-47`) calls `Effect.runPromise`, which on failure calls `causeSquash(cause)` and throws the **raw error value** — e.g. `Effect.fail("kaboom!")` throws the string `"kaboom!"`.

TanStack Start serializes thrown values via seroval and on the client checks `if (result instanceof Error) throw result`. A raw string isn't an `Error`, so the error path falls through to a generic "unexpected error occurred" message.

### Current `runEffect`

```ts
// src/lib/effect-services.ts
export const makeRunEffect = (env: Env) => {
  const appLayer = makeAppLayer(env);
  return <A, E>(effect: Effect.Effect<A, E, AppR>) =>
    Effect.runPromise(Effect.provide(effect, appLayer));
};
```

Bring in the implementation of runPromise from refs/effect4 and any other bits and pieces so I can see how it is implemented and how it handles errors. Create a mermaid diagram if helpful.

---

## Approach 1: `runPromiseExit` in `runEffect`

Change `runEffect` to use `runPromiseExit` so it never rejects with a raw value. Inspect the `Exit` and throw a proper `Error` instance.

### Implementation

```ts
// src/lib/effect-services.ts
import { Cause, Effect, Exit, Layer, ServiceMap } from "effect";

export const makeRunEffect = (env: Env) => {
  const appLayer = makeAppLayer(env);
  return async <A, E>(effect: Effect.Effect<A, E, AppR>): Promise<A> => {
    const exit = await Effect.runPromiseExit(Effect.provide(effect, appLayer));
    if (Exit.isSuccess(exit)) return exit.value;
    throw new Error(Cause.pretty(exit.cause));
  };
};
```

Bring in the implementation of runPromiseExit and the awaited type of what it returns. Need to understand what is exit.cause and how it is populated.

### Optional: Custom error class for richer `errorComponent` handling

Remove this optional section.

```ts
// src/lib/effect-error.ts
import type { Cause } from "effect";

export class EffectError extends Error {
  readonly _tag = "EffectError";
  constructor(public readonly effectCause: Cause.Cause<unknown>) {
    super(Cause.pretty(effectCause));
    this.name = "EffectError";
  }
}
```

```ts
// Then in runEffect:
throw new EffectError(exit.cause);
```

```tsx
// In a route's errorComponent:
errorComponent: ({ error }) => {
  if (error instanceof Error && error.name === "EffectError") {
    return <div>{error.message}</div>;
  }
  return <ErrorComponent error={error} />;
};
```

### Pros

- Single-file change fixes serialization for all server fns
- No per-fn boilerplate
- `errorComponent` receives a proper `Error` with a readable message

### Cons

- Loses typed error information at the boundary (everything becomes `Error` with a message string)
- Can't do `redirect`/`notFound` from within Effect unless you add special handling

---

## Approach 2: Hybrid — structured `runEffect` with TanStack escape hatches

Build on Approach 1 but detect `redirect`/`notFound` objects that were placed in the defect channel via `Effect.die`, passing them through to TanStack's control flow.

What are the type definitions of redirect and notFound? Are they instances of Error?

### Implementation

```ts
// src/lib/effect-services.ts
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { Cause, Effect, Exit, Layer, ServiceMap } from "effect";

export const makeRunEffect = (env: Env) => {
  const appLayer = makeAppLayer(env);
  return async <A, E>(effect: Effect.Effect<A, E, AppR>): Promise<A> => {
    const exit = await Effect.runPromiseExit(Effect.provide(effect, appLayer));
    if (Exit.isSuccess(exit)) return exit.value;
    const squashed = Cause.squash(exit.cause);
    if (isRedirect(squashed) || isNotFound(squashed)) throw squashed;
    throw squashed instanceof Error
      ? squashed
      : new Error(Cause.pretty(exit.cause));
  };
};
```

### Usage in effect pipelines

Use `Effect.die` to escape to TanStack control flow — appropriate because `redirect`/`notFound` are control flow, not recoverable errors:

```ts
import { notFound, redirect } from "@tanstack/react-router";

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(({ data: { organizationId }, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const validSession = yield* Effect.fromNullishOr(session).pipe(
          Effect.catch(() => Effect.die(redirect({ to: "/login" }))),
        );
        const repository = yield* Repository;
        return yield* repository.getAppDashboardData({
          userEmail: validSession.user.email,
          organizationId,
        });
      }),
    ),
  );
```

### Per-fn domain error handling via `catchTag`/`catchTags`

Combine with Effect's typed error handling for domain-specific responses:

```ts
Effect.gen(function* () {
  // ... business logic with typed errors ...
}).pipe(
  Effect.catchTags({
    NotFound: () => Effect.die(notFound()),
    Unauthorized: () => Effect.die(redirect({ to: "/login" })),
  }),
);
```

This looks like too much boilerplate to attach to every gen. Do you think we should remove this section?

### Pros

- Centralized error→Error conversion for all server fns
- TanStack `redirect`/`notFound` work from within Effect pipelines
- Domain errors can be handled per-fn with `catchTag`/`catchTags`

### Cons

- Using `Effect.die` for control flow is unconventional in Effect
- Slightly more complex `runEffect`

---

## Key Reference: How `causeSquash` Works

`Effect.runPromise` throws via `causeSquash`, which returns (in priority order):

1. First `Fail` reason's `.error` (the raw `E` value)
2. First `Die` reason's `.defect` (the raw `unknown` value)
3. `Error("All fibers interrupted without error")`
4. `Error("Empty cause")`

This is why `Effect.fail("kaboom!")` throws the string `"kaboom!"` — it's the raw `E` from the first `Fail` reason.

## Key Reference: TanStack Start Server Fn Error Flow

```
handler throws
  → caught by middleware try/catch
  → serialized via seroval (toCrossJSONAsync)
  → sent as HTTP 500 with X_TSS_SERIALIZED header
  → client deserializes via fromCrossJSON
  → if (result instanceof Error) throw result  ← string fails this check
  → error propagates to router loader catch
  → route.onError?.(error)
  → match.status = 'error'
  → route.errorComponent renders with { error, reset }
```

I don't understand what happens with

```
const validSession = yield* Effect.fromNullishOr(null);
```

I think this may fail the effect with NoSuchElementError. However, not sure what that is and how that comes out of runPromise. The browser seems to show An unexpected error occurred. which is too opaque
