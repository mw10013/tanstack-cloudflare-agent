# Auth.ts Introduction Spike Research

Goal: pick a small, low-risk production area to start introducing `Auth.ts` while keeping `auth-service.ts` fully intact.

## Is Your Assumption Correct?

Mostly yes.

Code evidence:

```ts
// src/worker.ts
async fetch(request, env, _ctx) {
  const authService = createAuthService({ ... });
  const runEffect = makeRunEffect(env);
  ...
}
```

`createAuthService(...)` and `makeRunEffect(env)` are created inside `fetch`, so request-scoped.

Both implementations persist auth/session/org/subscription data in D1 via Better Auth adapter:

```ts
// src/lib/auth-service.ts
database: d1Adapter(db),
```

```ts
// src/lib/Auth.ts
database: d1Adapter(db),
```

So yes: both implementations can coexist and read/write the same persisted state.

Important caveats:

- They must keep config parity (`secret`, schema model names, plugin order including `tanstackStartCookies()` last).
- Old auth uses `createD1SessionService(...).getSession()`; current `Auth.ts` uses `D1` service (env D1). This is fine for your current spike direction, but it is a behavior difference.
- Server-memory is still ephemeral for correctness, but isolates may be reused; correctness should rely on D1/KV, not in-memory assumptions.

## Current Auth Surface in App

Auth usage is concentrated in `authService.api.*` and `/api/auth/$` handler.

Method frequency from code scan:

```txt
6 getSession
2 listActiveSubscriptions
2 hasPermission
... (all others single-call sites)
```

High-risk areas to avoid for first spike:

- `src/routes/api/auth/$.tsx` (all Better Auth HTTP endpoints)
- `src/worker.ts` `authService.api.getSession(...)` in request bootstrap and agent guards

## Best First Production Slice

Recommendation: migrate only `getSession` in `src/routes/app.$organizationId.index.tsx` loader.

Why this slice:

- Single auth call in loader:

```ts
// src/routes/app.$organizationId.index.tsx
const session = await authService.api.getSession({ headers: request.headers });
```

- Read-only auth operation (no cookie mutation, no auth write).
- Easy to exercise repeatedly with normal app navigation.
- Keeps all mutating auth operations (`acceptInvitation`, `rejectInvitation`) on existing implementation for now.

Why not start with `/api/auth/$`:

```ts
// src/routes/api/auth/$.tsx
return context.authService.handler(request);
```

This is full auth blast radius (login, callbacks, subscription hooks, webhook paths). Too large for first introduction.

## Secondary Small Slice (after first)

`src/routes/api/google/callback.tsx` session check:

```ts
const session = await context.authService.api.getSession({ headers: request.headers });
```

Very small and read-only, but less ideal as first slice because it is harder to exercise quickly (requires OAuth callback path).

## Suggested Spike Sequence

1. Keep existing dedicated spike route (`/app/$organizationId/auth`) as service sanity check.
2. Migrate `app.$organizationId.index.tsx` loader `getSession` to `Auth.ts`.
3. If stable, migrate `api/google/callback.tsx` `getSession`.
4. Then move read-only auth calls in other loaders (`members` loader first).
5. Leave `/api/auth/$`, sign-in, sign-out, impersonation, subscription mutations for later phase.

## Spike Success Criteria

- Organization home (`/app/:organizationId`) still loads for logged-in user.
- `userEmail` derived from session remains correct.
- No cookie/redirect regressions (none expected for read-only `getSession`).
- No D1 schema mismatch errors.

## Practical Notes for Next Implementation Step

- Use `context.runEffect(...)` + `yield* Auth`.
- Keep request headers source unchanged (`getRequest().headers`).
- Do not remove `authService` from context yet; run dual mode.
