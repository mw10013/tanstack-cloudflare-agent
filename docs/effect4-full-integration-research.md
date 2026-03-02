# Effect 4 Full Integration Research

Date: 2026-03-02

## TL;DR

Effect 4 is already core to this app (`ServiceMap.Service`, `Layer.effect`, `Config`, `runEffect`). Biggest remaining gap is not route handlers; it's imperative islands (mainly `organization-agent.ts` + Better Auth plugin callbacks) where errors/decoding/runtime are still ad-hoc.

Highest leverage path:

1. move sync schema decoding and thrown `Error` into Effect error channels,

Above needs much more research because schemas are used on the client where we won't be running effects.

2. centralize non-route Effect execution via a managed runtime bridge,

More details needed here. Also, we should convert all routes, no matter how trivial to use runEffect for consistency.

3. turn Google/OAuth + agent integration into services/layers (instead of direct `Effect.runPromise` and module-level mutable cache).

I think I want to defer this for now since can of worms

## Current State (What Is Already Good)

### 1) V4 service model is in place

`src/lib/effect-services.ts` composes app dependencies with layers and `ServiceMap`:

```ts
const makeAppLayer = (env: Env) =>
  Layer.provideMerge(
    Auth.layer,
    Layer.provideMerge(
      Stripe.layer,
      Layer.provideMerge(
        Repository.layer,
        Layer.provideMerge(
          D1.layer,
          Layer.provideMerge(
            FetchHttpClient.layer,
            Layer.succeedServices(
              ServiceMap.make(CloudflareEnv, env)
```

This waterfall looks dreadful. Any way to simplify?

### 2) Route/API handlers mostly run in Effect

`runEffect(...)` is consistently used across server fns/routes (`src/routes/**`, `src/worker.ts`).

We want all route/api handlers to use effect.

### 3) HTTP client migration started and is idiomatic

We can defer this for now.

`src/lib/google-client.ts` already uses Effect HTTP modules and typed error mapping:

```ts
HttpClient.execute(request).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  Effect.catchTag("HttpClientError", toGoogleApiError),
)
```

## Gaps To “More Fully Integrated” Effect 4

### A) Sync schema decode + throw-heavy paths still common outside route layer

The google stuff is out of scope for now. sync schema decode requires more investigation since some schemas are used in browser where we are not running effects. That said, in general, we want schemas to decode within effect and use effects error channel.

Repo snapshot:

- `Schema.decodeUnknownSync` in `src`: 20 occurrences.
- many in `src/organization-agent.ts`.
- still in OAuth module (`src/lib/google-oauth-client.ts`).

Examples:

```ts
const predictions = Schema.decodeUnknownSync(ResnetPredictions)(response)
```

```ts
return Schema.decodeUnknownSync(GoogleTokenResponse)(tokenResponse)
```

Impact: decode failures become thrown exceptions, bypassing typed error channels (`Effect.catchTag`, cause-based handling).

### B) Multiple imperative `Effect.runPromise(...)` islands

google stuff is out of scope. also, agent for now. however, we need to figure out better effect integration for better-auth database hooks

Repo snapshot:

- `Effect.runPromise(` in `src`: 9 occurrences.
- concentrated in `organization-agent.ts` + `Auth.ts` callback wiring.

Examples:

```ts
const data = await Effect.runPromise(
  Effect.provide(listDriveSpreadsheetsRequest(accessToken), FetchHttpClient.layer),
)
```

```ts
await Effect.runPromise(stripe.ensureBillingPortalConfiguration())
```

Impact: runtime bridging pattern is duplicated; error normalization differs by callsite.

### C) Runtime/layer boundary not explicit for non-route execution

Route edge has `makeRunEffect`, but agent methods and 3rd-party callbacks run ad-hoc.

Effect docs call out `ManagedRuntime` as the integration boundary for non-Effect frameworks.

Are you really advocating ManagedRuntime? Is it necessary in our case? Its lifecycle would need to be managed (dispose), which is easy to forget. I'm wondering if runEffect fn that has all the deps baked in would suffice, but needs to be reseearched deeply


From `refs/effect4/ai-docs/src/03_integration/10_managed-runtime.ts`:

```ts
export const runtime = ManagedRuntime.make(TodoRepo.layer, {
  memoMap: appMemoMap
})
```

From `refs/effect4/packages/effect/src/ManagedRuntime.ts`:

```ts
readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>, ...) => Promise<A>
```

### D) Manual mutable caching in OAuth discovery

Out of scope for now..

`src/lib/google-oauth-client.ts` uses module mutable state:

```ts
let cachedConfig: Oidc.Configuration | undefined;
let cachedConfigKey: string | undefined;
```

Effect-native cache primitives (`Effect.cached`, `Ref`) would keep this in Effect model.

## Relevant Effect 4 Guidance (Docs Excerpts)

From `refs/effect4/migration/services.md`:

- “all of these have been replaced by `ServiceMap.Service`”
- “Prefer `yield*` over `use` in most cases.”
- “compose layers before providing is still the recommended pattern” (paired with memoization doc below).

From `refs/effect4/migration/layer-memoization.md`:

- v4 memoizes layers across `Effect.provide` calls,
- but still: “composing layers before providing is still the recommended pattern”.

From `refs/effect4/migration/yieldable.md`:

- `Config` and `ServiceMap.Service` are `Yieldable`, intended for `yield*` in `Effect.gen`.

From `refs/effect4/MIGRATION.md`:

- `effect/unstable/*` modules are expected in v4 beta (already true in this repo for HTTP).

## Recommended Target Architecture

### 1) One runtime bridge per execution boundary

Keep current `runEffect` for TanStack Start context. Add explicit managed runtime bridge(s) for:

- `OrganizationAgent` internals,    This is out of scope for now.
- Better Auth plugin callbacks.     Can runEffect be used somehow?

Goal: stop scattering `Effect.runPromise` callsites.

### 2) Convert “imperative hot spots” into services

Candidate services:

These are out of scope for now

- `GoogleOAuth` service (discovery, exchange, refresh, cache).
- `OrganizationAgentRepository` service (all SQL decode/write operations).
- optional `OrganizationWorkflowService` for workflow orchestration + error mapping.

### 3) Normalize decoding + errors into typed channels

- Replace `decodeUnknownSync` with `decodeUnknownEffect` at async boundaries.
- Replace plain `new Error(...)` throws in domain flow with tagged errors (like existing `D1Error`, `StripeError`, `AuthError`, `GoogleApiError`).

### 4) HTTP client provisioning consistency

`FetchHttpClient.layer` is already in app layer. Avoid re-providing it ad-hoc in agent methods; provide once at runtime/service boundary.

## Phased Plan

### Phase 1 (Low risk, high ROI)

1. Create `OrganizationAgentError` tagged errors for known failures (`invalid_event_time`, `google_not_connected`, `token_refresh_failed`, etc.).
2. Replace `decodeUnknownSync` in `organization-agent.ts` and `google-oauth-client.ts` with effectful decode in typed pipelines.
3. Introduce one local runtime helper for agent methods; replace direct `Effect.runPromise(...)` usages.

### Phase 2 (Service extraction)

1. Add `GoogleOAuth` service/layer; move discovery cache into `Effect.cached`/`Ref`.
2. Add `GoogleSheets` service exposing Effect-returning operations used by agent callables.
3. Refactor `Auth.ts` callback internals to call shared runtime bridge helper (instead of raw `Effect.runPromise` inline).

### Phase 3 (Observability/testability)

1. Wrap core service methods with `Effect.fn("...")` naming + `Effect.withSpan` on key workflows.
2. Add layer-based tests for services (swap test layers for DB/HTTP where possible).

## Concrete Backlog (File-by-file)

1. `src/organization-agent.ts`
- remove direct `Effect.runPromise(...)` + `Effect.provide(...FetchHttpClient.layer)` callsites.
- replace all `Schema.decodeUnknownSync(...)` with effectful decode at async boundaries.
- replace thrown `Error` in domain paths with tagged errors.

2. `src/lib/google-oauth-client.ts`
- replace `Schema.decodeUnknownSync` with `Schema.decodeUnknownEffect`.
- move `cachedConfig` mutable module state to Effect-native cache service.

3. `src/lib/Auth.ts`
- isolate callback-time Effect execution in shared bridge helper/runtime.
- keep plugin API Promise interface, but remove repeated inline runtime wiring.

4. `src/lib/effect-services.ts`
- optionally expose a reusable managed runtime constructor if you want one style for all non-route Effect execution.

## Suggested Success Criteria

1. `Schema.decodeUnknownSync` reduced to UI-only/form edge cases, not domain orchestration.
2. no direct `Effect.runPromise` in domain modules (`organization-agent`, auth callback internals).
3. all non-trivial domain failures represented by tagged errors.
4. one documented runtime bridge pattern used consistently.

## Risks / Tradeoffs

1. Agent framework APIs are Promise-based; some bridge code remains necessary.
2. `effect/unstable/http/*` is beta/unstable; pin versions and isolate wrappers.
3. Full service extraction is structural work; do in phases to avoid large regressions.

## Appendix: Quick Evidence Snapshot

- `Schema.decodeUnknownSync` count in `src`: 20
- `Effect.runPromise(` count in `src`: 9
- `FetchHttpClient.layer` re-provided ad-hoc in agent: 3 callsites

Key files:

- `src/lib/effect-services.ts`
- `src/organization-agent.ts`
- `src/lib/google-client.ts`
- `src/lib/google-oauth-client.ts`
- `src/lib/Auth.ts`
