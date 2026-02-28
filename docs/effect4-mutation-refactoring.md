# Effect 4 Mutation Handler Refactoring

Refactored all route-level `POST` server functions to use `runEffect` + `Effect.gen` with Effect 4 services.

This completes the "What Remains: POST/Mutation Handlers" section from `docs/effect4-loader-refactoring.md`.

## Scope

- In scope: route module `createServerFn({ method: "POST" })` handlers in `src/routes/`
- Out of scope: route `server.handlers` API endpoints, worker `fetch/queue/scheduled`, legacy service construction

## Refactored Handlers (17 total, 8 files)

| File | POST handlers |
| --- | --- |
| `src/routes/app.$organizationId.index.tsx` | `acceptInvitation`, `rejectInvitation` |
| `src/routes/app.$organizationId.members.tsx` | `removeMember`, `leaveOrganization`, `updateMemberRole` |
| `src/routes/app.$organizationId.invitations.tsx` | `invite`, `cancelInvitation` |
| `src/routes/app.$organizationId.billing.tsx` | `manageBilling`, `cancelSubscription`, `restoreSubscription` |
| `src/routes/admin.users.tsx` | `banUser`, `unbanUser`, `impersonateUser` |
| `src/routes/_mkt.pricing.tsx` | `upgradeSubscriptionServerFn` |
| `src/routes/app.$organizationId.upload.tsx` | `uploadFile`, `deleteUpload` |
| `src/routes/app.$organizationId.google.tsx` | `beginGoogleConnect` |

## Effect 4 Idioms and Patterns Used

### 1) Wrap mutation handlers with `runEffect(Effect.gen(...))`

Pattern used in every refactored POST handler:

```ts
const fn = createServerFn({ method: "POST" }).handler(({ context: { runEffect } }) =>
  runEffect(
    Effect.gen(function* () {
      // mutation logic
    }),
  ),
);
```

Code refs:
- `src/routes/app.$organizationId.members.tsx`
- `src/routes/app.$organizationId.billing.tsx`
- `src/routes/admin.users.tsx`

### 2) Access services via `yield* ServiceTag`

Used `yield* Auth`, `yield* Stripe`, `yield* Repository`, `yield* CloudflareEnv` instead of context-level legacy services.

```ts
const auth = yield* Auth;
const stripe = yield* Stripe;
const repository = yield* Repository;
const env = yield* CloudflareEnv;
```

Code refs:
- `src/routes/_mkt.pricing.tsx` (`Auth`, `Stripe`)
- `src/routes/app.$organizationId.invitations.tsx` (`Auth`, `Repository`)
- `src/routes/app.$organizationId.upload.tsx` / `google.tsx` (`CloudflareEnv`)

### 3) Use `Effect.tryPromise` for Promise APIs

Used for better-auth API calls, R2 operations, queue sends, and OAuth helpers.

Doc excerpt (`refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts`):
- "`Effect.tryPromise` wraps Promise-based APIs that can reject or throw."

Examples:
- `auth.api.*` calls in `billing.tsx`, `members.tsx`, `index.tsx`, `invitations.tsx`, `admin.users.tsx`, `_mkt.pricing.tsx`
- `env.R2.put/delete`, `env.R2_UPLOAD_QUEUE.send` in `upload.tsx`
- `buildGoogleAuthorizationRequest`, `stub.beginGoogleOAuth` in `google.tsx`

### 4) Replace `invariant(...)` null checks with `Effect.fromNullishOr(...)`

Used for session / organization / env value guards.

Doc excerpt (`refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts`):
- "`Effect.fromNullishOr` turns nullable values into a typed effect."

Examples:
- `_mkt.pricing.tsx`: `activeOrganizationId`
- `upload.tsx`: `session`, `activeOrganizationId`
- `google.tsx`: `session`, `activeOrganizationId`, Google OAuth env vars

### 5) Use `Effect.die` for TanStack control flow (`redirect`, `notFound`)

Mutations now route control flow through defect channel so `runEffect` can rethrow TanStack control objects.

```ts
return yield* Effect.die(redirect({ to: "/app" }));
return yield* Effect.die(notFound());
```

Code refs:
- `src/routes/admin.users.tsx` (`impersonateUser`)
- `src/routes/_mkt.pricing.tsx` (`login redirect`, `notFound`)

### 6) Keep business/user-facing failures in error channel (`Effect.fail`)

For mutation errors meant for `useMutation().error` display, used regular failures:

```ts
return yield* Effect.fail(new Error("Forbidden"));
```

Code ref:
- `src/routes/_mkt.pricing.tsx`

## Behavioral Notes

- Return shapes kept unchanged for all handlers.
- Existing logging preserved (pricing + invitation workaround).
- Existing schema validators preserved.
- Existing UI mutation flows unchanged (invalidate/navigate/redirect behavior preserved).

## Validation

- `pnpm typecheck` passed
- `pnpm lint` passed

## Remaining Work For Full Effect 4 Conversion

### A) Remaining imperative route `POST` server fn

Still uses legacy context services directly:

- `src/routes/login.tsx` -> `login` handler uses `context: { authService, env }` and direct `await`

### B) API route handlers still imperative (`server.handlers`)

These do not use `runEffect` yet and still use legacy context + `invariant`:

- `src/routes/api/google/callback.tsx`
- `src/routes/api/org.$organizationId.upload-image.$name.tsx`
- `src/routes/api/e2e/delete/user/$email.tsx`
- `src/routes/api/auth/$.tsx` (proxying `authService.handler`)

### C) Worker context still constructs and injects legacy service stack

`src/worker.ts` still creates and injects:
- `repository` from `src/lib/repository-service.ts`
- `authService` from `src/lib/auth-service.ts`
- `stripeService` from `src/lib/stripe-service.ts`

`runEffect` is in place, but full migration implies shrinking/removing this parallel legacy service path.

### D) Duplicate service stacks still coexist

Both stacks exist now:
- Effect 4: `src/lib/Auth.ts`, `src/lib/Repository.ts`, `src/lib/Stripe.ts`
- Legacy Promise services: `src/lib/auth-service.ts`, `src/lib/repository-service.ts`, `src/lib/stripe-service.ts`

Full conversion means choosing one runtime path for server logic.

### E) Optional/non-critical remaining simplifications

- `src/routes/__root.tsx` and `src/routes/_mkt.tsx` have trivial sync server fns; still acceptable as-is.
- Admin route loader redirect throws in route loaders (`admin.users/sessions/customers/subscriptions`) are outside server fn `runEffect`; can remain unless you want uniform Effect style everywhere.

## Suggested Next Migration Order

1. Refactor `src/routes/login.tsx` POST handler to `runEffect`.
2. Refactor API `server.handlers` to Effect style (especially Google callback + upload-image + e2e delete user).
3. Replace legacy service usage in `src/worker.ts` paths not covered by `runEffect`.
4. Decommission `auth-service.ts` / `repository-service.ts` / `stripe-service.ts` once consumers are migrated.
