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

## Extended Spike Sequence

Scope rule for early phases: only move read-only auth calls first (`getSession`, read queries). Keep all cookie-mutating and auth-mutating operations on `auth-service.ts` until late phase.

Phase 0: Baseline and guardrails

1. Keep `/app/$organizationId/auth` as a control route to confirm `Auth.ts` resolves and returns session in production-like requests.
2. Define rollback switch: any regression means revert only the specific migrated call-site, not global auth wiring.
3. Log baseline behavior for key pages (`/app/:organizationId`, `/app/:organizationId/members`, `/api/google/callback`) before any migration.

Phase 1: Single low-risk read in a core page

4. Migrate only `getSession` in `src/routes/app.$organizationId.index.tsx` loader to `Auth.ts` via `runEffect`.
5. Keep invitation mutations (`acceptInvitation`, `rejectInvitation`) on `authService`.
6. Verify: app home loads, invitation cards render, `memberCount/pendingInvitationCount` unchanged.

Phase 2: Another isolated read-only endpoint

7. Migrate `getSession` in `src/routes/api/google/callback.tsx` to `Auth.ts`.
8. Keep OAuth token exchange and durable object calls unchanged.
9. Verify: unauthorized callback still returns 401, valid callback still redirects to `.../google?google=connected|error|denied` correctly.

Phase 3: Read-heavy organization screens

10. Migrate `getSession` in `src/routes/app.$organizationId.members.tsx` loader.
11. Keep `hasPermission`, `listMembers`, and mutations (`removeMember`, `leaveOrganization`, `updateMemberRole`) on existing `authService`.
12. Verify: members list loads, role badges match previous behavior, leave/remove/update still work (still served by old auth path).

Phase 4: Additional read-only getSession consumers

13. Evaluate migrating worker-level read checks one by one:
    - `onBeforeConnect` session check in `src/worker.ts`
    - `onBeforeRequest` session check in `src/worker.ts`
    - request bootstrap `session` injection in `src/worker.ts`
14. Do these separately (not one PR) because worker regressions affect all routes/agents.
15. Verify agent auth (`401`/`403`) behavior is unchanged.

Phase 5: Read operations beyond getSession

16. Start migrating read-only auth API calls in route loaders/beforeLoad:
    - `listOrganizations` in `src/routes/app.$organizationId.tsx`
    - `listInvitations` / permission checks in invitations flow (read path only where possible)
17. Keep write operations and cookie-sensitive actions on old service.

Phase 6: Cookie-mutating operations (higher risk)

18. Migrate one mutation that does not redefine auth routing first (example: `signOut` server fn), then validate cookie clearing and redirect behavior.
19. Migrate `impersonateUser` after sign-out proves stable, because it also mutates auth cookies.
20. Verify via browser session transitions, not only API assertions.

Phase 7: Better Auth handler boundary

21. Migrate `/api/auth/$` handler from `context.authService.handler(request)` to `Auth.ts` only after all major API calls are already proven.
22. Validate magic-link verify, subscription webhook allowlist paths, billing callbacks, and auth endpoint status codes.

Phase 8: Convergence and deprecation

23. Remove remaining `authService` call-sites after parity checks pass.
24. Remove `createAuthService` usage from `worker.ts`.
25. Remove `src/lib/auth-service.ts` and associated old typings once no references remain.

Recommended batching rule:

- Batch size: one migrated call-site per spike PR in Phases 1-4.
- Promote to two call-sites per PR only after 2-3 clean spikes.
- Never mix worker-level changes and route-level changes in the same spike PR.

## Spike Success Criteria

- Organization home (`/app/:organizationId`) still loads for logged-in user.
- `userEmail` derived from session remains correct.
- No cookie/redirect regressions (none expected for read-only `getSession`).
- No D1 schema mismatch errors.

## Practical Notes for Next Implementation Step

- Use `context.runEffect(...)` + `yield* Auth`.
- Keep request headers source unchanged (`getRequest().headers`).
- Do not remove `authService` from context yet; run dual mode.
