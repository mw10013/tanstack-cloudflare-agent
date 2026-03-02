# Effect 4 Full Integration Research

Date: 2026-03-02

## Objective

Define concrete, low-risk steps to integrate Effect 4 more fully across route handlers, auth callbacks, decode boundaries, and layer composition.

## Scope For This Iteration

In scope:

1. make route/server-fn usage of `runEffect` fully consistent,
2. improve Better Auth hook/callback integration with Effect,
3. resolve upload decode boundary policy,
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

Foundation is solid: request-scoped `runEffect`, app-layer provisioning, normalized Effect failure boundary.

## Findings

### 1) Route/server-fn consistency gap is small and concrete

All `server.handlers` route endpoints already use `runEffect`.

Only two `createServerFn` handlers in routes do not:

1. `src/routes/_mkt.tsx`
2. `src/routes/__root.tsx`

Current examples:

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

### 2) Upload decode boundary: validator is server-only, but decode should move into Effect pipeline

Current `Schema.decodeUnknownSync` usage:

- `src/organization-agent.ts`: 17
- `src/lib/google-oauth-client.ts`: 2
- `src/routes/app.$organizationId.upload.tsx`: 1

TanStack Start behavior confirms `inputValidator` executes only on server path.

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

From `refs/tan-start/packages/start-plugin-core/src/start-compiler-plugin/handleCreateServerFn.ts`:

```ts
if (context.env === 'client') {
  stripMethodCall(inputValidator.callPath)
}
```

Current upload validator (`src/routes/app.$organizationId.upload.tsx`):

```ts
.inputValidator((data) => {
  if (!(data instanceof FormData)) throw new Error("Expected FormData");
  return Schema.decodeUnknownSync(uploadFormSchema)(Object.fromEntries(data));
})
```

Recommendation for upload:

1. keep validator as minimal shape gate (`FormData`),
2. move schema decode into handler Effect via `Schema.decodeUnknownEffect(...)`,
3. keep failures typed in Effect channel and handled through `runEffect`.

Show me what the code would look like.

### 3) Better Auth callback integration: options

`src/lib/Auth.ts` has 5 inline callback calls to `Effect.runPromise(...)` (`117, 162, 192, 292, 304`).

Better Auth model is async lifecycle callbacks.

From `refs/better-auth/docs/content/docs/concepts/hooks.mdx`:

- before hooks run before endpoint execution,
- after hooks run after endpoint execution.

From `refs/better-auth/docs/content/docs/reference/options.mdx`:

- `databaseHooks` define async lifecycle hooks per model/event.

Effect runner options:

1. keep inline `Effect.runPromise(...)` (current),
2. use one closure-scoped runner from `Effect.services` + `Effect.runPromiseWith(...)`,
3. use `Effect.runPromiseExitWith(...)` where callback needs explicit exit/error mapping,
4. use `ManagedRuntime` for explicit lifecycle/disposal.

Relevant Effect APIs (`refs/effect4/packages/effect/src/Effect.ts`):

```ts
export const services: <R>() => Effect<ServiceMap.ServiceMap<R>, never, R>
export const runPromiseWith: <R>(services: ServiceMap.ServiceMap<R>) => ...
export const runPromiseExitWith: <R>(services: ServiceMap.ServiceMap<R>) => ...
```

Recommended now: option 2 as default, optional option 3 for callbacks that need explicit `Exit`-based error translation.

Sketch in `Auth.make`:

```ts
const services = yield* Effect.services();
const run = Effect.runPromiseWith(services);
const runExit = Effect.runPromiseExitWith(services);
```

Use `run(...)` in all callback/hook sites.

Rename run to runEffect.

### 4) Can `runEffect` be passed/accessed in Better Auth database hooks?

Short answer: not directly in current architecture.

Evidence:

1. `runEffect` is created in `src/worker.ts` per request and injected into TanStack Start request context (`serverEntry.fetch(..., { context: { runEffect, ... }})`).
2. Better Auth hooks/database hooks in `src/lib/Auth.ts` are closures configured at `betterAuth(...)` construction time.
3. Better Auth database hook signatures are `(entity, context: GenericEndpointContext | null)` (from `@better-auth/core` types).
4. `GenericEndpointContext` contains Better Auth `AuthContext`, not app request context fields like `runEffect`.
5. Better Auth internally allows null hook context:

From `node_modules/better-auth/dist/db/with-hooks.mjs`:

```ts
const context = await getCurrentAuthContext().catch(() => null);
```

Conclusion:

1. no stable path to worker `runEffect` inside database hooks,
2. closure-scoped local runner in `Auth.make` is the right integration point,
3. request-context tunneling into Better Auth hooks is possible only with high-coupling custom plumbing and not recommended for this scope.

### 5) Layer composition readability: concrete refactor shape

Current `makeAppLayer` nested `Layer.provideMerge(...)` is correct but hard to read.

Naive flattening with only `Layer.mergeAll(...)` is not enough for dependent layers.

From `refs/effect4/packages/effect/src/Layer.ts`:

```ts
export const mergeAll = <Layers ...>(...layers: Layers): Layer<..., Services<Layers[number]>>
```

`mergeAll` merges outputs; it does not feed outputs into dependency inputs. Keep explicit wiring with `Layer.provide` / `Layer.provideMerge`.

Concrete no-behavior-change shape:

```ts
const envLayer = Layer.succeedServices(
  ServiceMap.make(CloudflareEnv, env)
    .pipe(ServiceMap.add(Greeting, { greet: () => "Hello from Effect 4 ServiceMap!" }))
    .pipe(
      ServiceMap.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
);

const runtimeLayer = Layer.mergeAll(FetchHttpClient.layer, envLayer);
const d1Layer = D1.layer.pipe(Layer.provide(runtimeLayer));
const repositoryLayer = Repository.layer.pipe(Layer.provide(d1Layer));
const stripeLayer = Stripe.layer.pipe(Layer.provide(runtimeLayer));
const authLayer = Auth.layer.pipe(
  Layer.provide(Layer.mergeAll(runtimeLayer, d1Layer, stripeLayer)),
);

const appLayer = Layer.mergeAll(
  runtimeLayer,
  d1Layer,
  repositoryLayer,
  stripeLayer,
  authLayer,
);
```

## Recommended Plan

### Phase 1 (now)

1. convert 2 remaining route `createServerFn` handlers to `runEffect`:
   - `src/routes/_mkt.tsx`
   - `src/routes/__root.tsx`
2. upload route: keep `FormData` gate in validator, move schema decode into Effect pipeline.
3. `src/lib/Auth.ts`: replace 5 inline `Effect.runPromise(...)` calls with one closure-scoped runner via `Effect.runPromiseWith(services)`.

### Phase 2

1. add `runPromiseExitWith` only where callback-level explicit error mapping is useful,
2. refactor `makeAppLayer` to named intermediate layers,
3. preserve exact dependency wiring semantics.

### Phase 3 (deferred)

1. `organization-agent.ts` decode/error/runtime cleanup,
2. Google/OAuth service extraction and cache design.

## Success Criteria

1. every route-level `createServerFn` handler runs through `runEffect`,
2. upload decode follows policy (minimal validator + Effect decode in handler),
3. Better Auth callbacks no longer have scattered inline `Effect.runPromise(...)`,
4. layer composition is readable while preserving behavior.

## Evidence Snapshot

- total `Effect.runPromise(` in `src`: 9
- `Effect.runPromise(` in `src/lib/Auth.ts`: 5
- `Schema.decodeUnknownSync` in `src`: 20
- route files with `createServerFn` and no `runEffect`: `_mkt`, `__root`
