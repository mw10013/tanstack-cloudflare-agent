# Effect 4 Loader Refactoring

Refactored all GET server function handlers (loaders/beforeLoad) across route files to use `runEffect` with `Effect.gen`, following Effect 4 idioms.

## Scope

- **In scope**: GET server functions used as loaders or beforeLoad guards
- **Out of scope**: POST/mutation server functions
- **Skipped**: Two trivially synchronous handlers (`__root.tsx`, `_mkt.tsx`) that only destructure `env`/`session` from context with no async logic — wrapping in `runEffect` would add overhead for no benefit

## Refactored Files (19 total)

### Session Guards (beforeLoad)

| File             | Services | Pattern                                              |
| ---------------- | -------- | ---------------------------------------------------- |
| `app.tsx`        | —        | `if (!session) Effect.die(redirect(...))`            |
| `admin.tsx`      | —        | Session + admin role guard                           |
| `app.index.tsx`  | —        | `Effect.fromNullishOr` + `Effect.die(redirect(...))` |
| `magic-link.tsx` | —        | Role-based redirect via `Effect.die`                 |

### CloudflareEnv Access

| File        | Services      | Pattern                                 |
| ----------- | ------------- | --------------------------------------- |
| `login.tsx` | CloudflareEnv | `yield* CloudflareEnv` for env bindings |

### Repository Service

| File                            | Services   | Pattern                                                 |
| ------------------------------- | ---------- | ------------------------------------------------------- |
| `admin.users.tsx`               | Repository | `yield* Repository` → `yield* repository.getUsers(...)` |
| `admin.sessions.tsx`            | Repository | `yield* repository.getSessions(...)`                    |
| `admin.subscriptions.tsx`       | Repository | `yield* repository.getSubscriptions(...)`               |
| `admin.customers.tsx`           | Repository | `yield* repository.getCustomers(...)`                   |
| `app.$organizationId.index.tsx` | Repository | `fromNullishOr` + `filterOrFail` + Repository           |

### Auth Service

| File                                  | Services | Pattern                                                                       |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `app.$organizationId.tsx`             | Auth     | `fromNullishOr` + `tryPromise(auth.api.*)` + `die(notFound())`                |
| `app.$organizationId.invitations.tsx` | Auth     | `tryPromise(auth.api.hasPermission)` + `tryPromise(auth.api.listInvitations)` |
| `app.$organizationId.members.tsx`     | Auth     | `fromNullishOr` + multiple `tryPromise`                                       |
| `app.$organizationId.billing.tsx`     | Auth     | `tryPromise(auth.api.listActiveSubscriptions)`                                |

### Stripe Service

| File               | Services | Pattern                                      |
| ------------------ | -------- | -------------------------------------------- |
| `_mkt.pricing.tsx` | Stripe   | `yield* Stripe` → `yield* stripe.getPlans()` |

### Env-Heavy Routes (DO stubs, R2, S3)

| File                                | Services      | Pattern                                                  |
| ----------------------------------- | ------------- | -------------------------------------------------------- |
| `app.$organizationId.workflow.tsx`  | CloudflareEnv | `yield* CloudflareEnv` → DO stub via `tryPromise`        |
| `app.$organizationId.inspector.tsx` | CloudflareEnv | DO stub with `Promise.all` for 7 parallel calls          |
| `app.$organizationId.upload.tsx`    | CloudflareEnv | Session guard + DO stub + R2 S3 signing via `tryPromise` |

## Effect 4 Patterns and Idioms

### `runEffect` infrastructure

`makeRunEffect` in `src/lib/effect-services.ts` provides the app layer, runs via `Effect.runPromiseExit`, handles TanStack `redirect`/`notFound` control flow by detecting them in the defect channel via `Cause.squash` and re-throwing, and normalizes errors for SSR serialization.

```ts
const getLoaderData = createServerFn({ method: "GET" }).handler(
  async ({ context: { runEffect } }) => {
    return runEffect(
      Effect.gen(function* () {
        // ...
      }),
    );
  },
);
```

### Service access via `yield*`

Effect 4's Yieldable trait lets you yield services directly:

```ts
const repository = yield * Repository;
const auth = yield * Auth;
const stripe = yield * Stripe;
const env = yield * CloudflareEnv;
```

### `Effect.fromNullishOr` for null/undefined guards

Replaces `invariant(value, msg)`. Returns `Effect<NonNullable<A>, NoSuchElementError>`.

```ts
// Before
invariant(session, "Missing session");

// After
const validSession = yield * Effect.fromNullishOr(session);
```

### `Effect.filterOrFail` for conditional validation

Chains with `fromNullishOr` for multi-step guards:

```ts
yield *
  Effect.fromNullishOr(session).pipe(
    Effect.filterOrFail(
      (s) => s.session.activeOrganizationId === organizationId,
      () => new Cause.NoSuchElementError(),
    ),
  );
```

### `Effect.die` for TanStack redirect/notFound

TanStack's `redirect()` and `notFound()` are control flow objects, not real errors. Place them in the defect channel via `Effect.die` so `runEffect` can re-throw them:

```ts
if (!session) {
  yield * Effect.die(redirect({ to: "/login" }));
}
```

Do NOT use `Effect.fail` for these — `runEffect` only catches them from the defect channel.

### `Effect.tryPromise` for imperative async APIs

Wraps promise-returning APIs (better-auth, DO stubs, R2) into Effect:

```ts
// Auth API
const members =
  yield *
  Effect.tryPromise(() =>
    auth.api.listMembers({ headers, query: { organizationId } }),
  );

// DO stub
const uploads = yield * Effect.tryPromise(() => stub.getUploads());
```

### `Effect.all` for parallel execution

```ts
const [users, orgs] =
  yield * Effect.all([repository.getUsers(), repository.getOrganizations()]);
```

### Simple guard pattern over combinator chains

For session guards that redirect, direct `if` checks inside `Effect.gen` with `Effect.die(redirect(...))` produce cleaner types than `filterOrFail` + `catch` combinator chains, which can cause `unknown` return type issues.

```ts
// Preferred for redirect guards
return runEffect(
  Effect.gen(function* () {
    if (!session) {
      return yield* Effect.die(redirect({ to: "/login" }));
    }
    // ...
  }),
);
```

### Effect v4 renames

- `Effect.catchAll` → `Effect.catch`
- `NoSuchElementException` → `Cause.NoSuchElementError`
- `Effect.filterOrFail` defaults to `NoSuchElementError` when no error constructor is provided

## What Remains: POST/Mutation Handlers

17 POST server functions across 8 files remain imperative (not wrapped in `runEffect`). These use `invariant`, `authService.api.*`, `env.*`, and `throw redirect()`/`throw notFound()` directly.

### Auth-heavy handlers (14 functions)

| File                                  | Functions                                                    | Summary                              |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| `app.$organizationId.index.tsx`       | `acceptInvitation`, `rejectInvitation`                       | Accept/reject org invitations        |
| `app.$organizationId.members.tsx`     | `removeMember`, `leaveOrganization`, `updateMemberRole`      | Org member management                |
| `app.$organizationId.invitations.tsx` | `invite`, `cancelInvitation`                                 | Send/cancel invitations              |
| `app.$organizationId.billing.tsx`     | `manageBilling`, `cancelSubscription`, `restoreSubscription` | Stripe billing portal/sub management |
| `admin.users.tsx`                     | `banUser`, `unbanUser`, `impersonateUser`                    | Admin user management                |
| `_mkt.pricing.tsx`                    | `upgradeSubscriptionServerFn`                                | Stripe checkout session creation     |

### Env-heavy handlers (3 functions)

| File                             | Functions                    | Summary                            |
| -------------------------------- | ---------------------------- | ---------------------------------- |
| `app.$organizationId.upload.tsx` | `uploadFile`, `deleteUpload` | R2 put/delete + queue notification |
| `app.$organizationId.google.tsx` | `beginGoogleConnect`         | Google OAuth flow initiation       |

### Refactoring considerations for POST handlers

1. **Auth service**: Most POST handlers call `authService.api.*` methods. Pattern: `yield* Auth` → `Effect.tryPromise(() => auth.api.someMethod(...))`.

2. **TanStack redirect/notFound**: POST handlers currently `throw redirect(...)` and `throw notFound()` directly. In Effect: `Effect.die(redirect(...))` and `Effect.die(notFound())`.

3. **`invariant` replacement**: `invariant(value, msg)` → `Effect.fromNullishOr(value)` or `Effect.filterOrFail(...)`.

4. **R2/Queue/DO stubs**: Wrap in `Effect.tryPromise` after `yield* CloudflareEnv`.

5. **Multi-step mutations**: POST handlers that do conditional logic (find plan → check subscription → upgrade) are good candidates for `Effect.gen` composition but require care with error types since mutations surface errors to the UI.

6. **Error handling difference**: Loaders fail the route. Mutations surface errors to `useMutation.error`. Ensure `runEffect` error normalization produces serializable error messages suitable for mutation error display.
