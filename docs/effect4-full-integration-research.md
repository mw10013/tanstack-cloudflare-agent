# Effect 4 Full Integration Research

Date: 2026-03-02

## Objective

Define practical next steps to integrate Effect 4 more fully in this codebase, with minimal risk and clear scope.

## Scope For This Iteration

In scope:

1. make route/server-fn usage of `runEffect` fully consistent,
2. improve Better Auth hook/callback integration with Effect,
3. clarify `decodeUnknownSync` policy vs effectful decode,
4. simplify layer composition readability without changing semantics.

Deferred (explicitly):

1. broad `organization-agent.ts` refactor,
2. Google/OAuth service extraction and caching redesign,
3. full migration away from all `Effect.runPromise` across all domains.

## Baseline

Runtime and request context are already Effect-first.

From `src/lib/effect-services.ts`:

```ts
const exit = await Effect.runPromiseExit(Effect.provide(effect, appLayer));
if (Exit.isSuccess(exit)) return exit.value;
```

From `src/worker.ts`:

```ts
const response = await serverEntry.fetch(request, {
  context: {
    env,
    runEffect,
    session: session ?? undefined,
  },
});
```

So the foundation is solid: request-scoped app layer + normalized Effect error boundary.

## Findings

### 1) Route/server-fn consistency gap is small and concrete

All `server.handlers` route endpoints already use `runEffect`.

Only two `createServerFn` handlers in routes do not:

1. `src/routes/_mkt.tsx`
2. `src/routes/__root.tsx`

Examples:

```ts
const beforeLoadServerFn = createServerFn().handler(
  ({ context: { session } }) => ({ sessionUser: session?.user }),
)
```

```ts
const getAnalyticsToken = createServerFn({ method: "GET" }).handler(
  ({ context: { env } }) => ({ analyticsToken: env.ANALYTICS_TOKEN ?? "" }),
)
```

Implication: full consistency is low-effort.

### 2) `decodeUnknownSync` concern: client risk is lower than assumed

Current usage count is:

- `src/organization-agent.ts`: 17
- `src/lib/google-oauth-client.ts`: 2
- `src/routes/app.$organizationId.upload.tsx`: 1

Key point: TanStack Start executes `inputValidator` on the server path.

From `refs/tan-start/packages/start-client-core/src/createServerFn.ts`:

```ts
if (
  'inputValidator' in nextMiddleware.options &&
  nextMiddleware.options.inputValidator &&
  env === 'server'
) {
  ctx.data = await execValidator(...)
}
```

And compiler behavior removes validator call from client build:

From `refs/tan-start/packages/start-plugin-core/src/start-compiler-plugin/handleCreateServerFn.ts`:

```ts
if (context.env === 'client') {
  stripMethodCall(inputValidator.callPath)
}
```

Practical policy:

1. `decodeUnknownSync` is acceptable in server-only synchronous edges.
2. inside Effect pipelines, prefer `Schema.decodeUnknownEffect` to keep typed errors in Effect channel.

Let's get this fixed for upload.

### 3) `ManagedRuntime` is optional here, not mandatory

`ManagedRuntime` is valid, but not required for current goals.

From `refs/effect4/packages/effect/src/ManagedRuntime.ts`:

```ts
readonly dispose: () => Promise<void>
```

```ts
dispose(): Promise<void> { return Effect.runPromise(self.disposeEffect) }
```

So it adds explicit lifecycle management.

Given existing request-scoped `runEffect` in worker context, a simpler path is better now:

- keep request-scoped `runEffect`,
- use `Effect.services` + `Effect.runPromiseWith(services)` in callback-heavy areas.

From `refs/effect4/packages/effect/src/Effect.ts`:

```ts
export const services: <R>() => Effect<ServiceMap.ServiceMap<R>, never, R>
export const runPromiseWith: <R>(services: ServiceMap.ServiceMap<R>) => ...
```

### 4) Better Auth hooks are the highest-value in-scope integration target

Current `Auth.ts` has 5 inline `Effect.runPromise(...)` in Better Auth callbacks.

Locations: `src/lib/Auth.ts:117,162,192,292,304`.

Better Auth docs model hooks/databaseHooks as async lifecycle callbacks.

From `refs/better-auth/docs/content/docs/concepts/hooks.mdx`:

- before hooks run before endpoint execution,
- after hooks run after endpoint execution.

From `refs/better-auth/docs/content/docs/concepts/database.mdx`:

- database hooks are lifecycle hooks for `user`/`session`/`account`.

Recommended integration pattern in `Auth.make`:

1. capture services once via `yield* Effect.services<...>()`,
2. create `const run = Effect.runPromiseWith(services)`,
3. reuse `run(...)` in all Better Auth callbacks.

This removes repeated ad-hoc runners while avoiding ManagedRuntime lifecycle overhead.

Research different approaches. I want to see what other options there are. Also see if there is a way to pass runEffect or access runEffect from the database hook or the surrounding closure at construction time. I would prefer to get and use runEffect somehow, but I'm not sure there is a way.

### 5) Layer composition readability can improve, but semantics matter

Current `makeAppLayer` nested `Layer.provideMerge(...)` is hard to read.

Naively flattening with `Layer.mergeAll(...)` alone is unsafe for dependent layers.

From `refs/effect4/packages/effect/src/Layer.ts`:

```ts
export const mergeAll ... : Layer<Success<...>, Error<...>, Services<...>>
```

`mergeAll` combines outputs; it does not automatically satisfy inter-layer dependencies unless composition is structured correctly.

Recommended refactor style:

1. define named intermediate layers,
2. keep dependency wiring explicit with `Layer.provide` / `Layer.provideMerge`,
3. reduce nesting using `pipe(...)` + intermediate constants.

Need details on what that would look like.

## Recommended Plan

### Phase 1 (now)

1. convert 2 remaining `createServerFn` handlers to `runEffect`:
   - `src/routes/_mkt.tsx`
   - `src/routes/__root.tsx`
2. in `src/lib/Auth.ts`, replace 5 inline `Effect.runPromise(...)` callback calls with shared local runner based on `Effect.runPromiseWith(services)`.

### Phase 2

1. refactor `makeAppLayer` readability with named intermediate layers,
2. preserve existing dependency wiring semantics,
3. no behavior change.

### Phase 3 (deferred by scope)

1. `organization-agent.ts` decode/error/runtime cleanup,
2. Google/OAuth service extraction and cache design.

## Success Criteria

1. every route-level `createServerFn` handler runs through `runEffect`,
2. Better Auth callbacks no longer have scattered inline `Effect.runPromise(...)` calls,
3. decode policy documented and applied consistently:
   - sync decode allowed only at server-only sync boundaries,
   - effectful decode inside Effect pipelines.

## Evidence Snapshot

- total `Effect.runPromise(` in `src`: 9
- `Effect.runPromise(` in `src/lib/Auth.ts`: 5
- `Schema.decodeUnknownSync` in `src`: 20
- route `createServerFn` handlers not using `runEffect`: 2 files (`_mkt`, `__root`)
