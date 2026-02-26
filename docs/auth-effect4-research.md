# Auth.ts Effect 4 Research

Goal: design `src/lib/Auth.ts` as an Effect 4 service equivalent of `src/lib/auth-service.ts`, while keeping `auth-service.ts` unchanged.

## Current Auth Contract

`auth-service.ts` builds a Better Auth instance with:

- D1 adapter
- hooks (`createAuthMiddleware`)
- plugins (`magicLink`, `admin`, `organization`, `stripe`, `tanstackStartCookies`)
- Better Auth `api`, `handler`, `$Infer`

Core shape:

```ts
// src/lib/auth-service.ts
export type AuthService = ReturnType<typeof createAuthService>;

export function createAuthService(...) {
  const auth = betterAuth(createBetterAuthOptions(...));
  return auth;
}
```

Better Auth type confirms this shape:

```ts
// better-auth dist/types/auth.d.mts
type Auth<Options extends BetterAuthOptions = BetterAuthOptions> = {
  handler: (request: Request) => Promise<Response>;
  api: InferAPI<...>;
  options: Options;
  $ERROR_CODES: ...;
  $context: Promise<AuthContext>;
  $Infer: ...;
};
```

## Runtime Surface Actually Used

From app call-sites, required methods are:

- `handler(request)`
- `api.getSession`
- `api.signOut`
- `api.signInMagicLink`
- `api.listOrganizations`
- `api.listActiveSubscriptions`
- `api.upgradeSubscription`
- `api.createBillingPortal`
- `api.cancelSubscription`
- `api.restoreSubscription`
- `api.listMembers`
- `api.removeMember`
- `api.leaveOrganization`
- `api.updateMemberRole`
- `api.hasPermission`
- `api.listInvitations`
- `api.createInvitation`
- `api.cancelInvitation`
- `api.acceptInvitation`
- `api.rejectInvitation`
- `api.banUser`
- `api.unbanUser`
- `api.impersonateUser`

Also consumed for typing:

- `AuthService["$Infer"]["Session"]`
- `AuthService["$Infer"]["Organization"]`

## Hard Constraints (Parity)

From `src/lib/auth-service.ts`:

1. `tanstackStartCookies()` must remain last plugin.
2. Stripe plugin workaround must remain:
   - use `priceId` + `annualDiscountPriceId` from Stripe plans.
3. Hook behavior must remain:
   - before subscription paths, call `stripeService.ensureBillingPortalConfiguration()`.
4. DB hooks must remain:
   - on user create (role=user) create personal organization
   - on session create attach `activeOrganizationId` from D1 query
5. For `Auth.ts`, dependency is `D1` Effect service; read-replica/session split is out of scope.

Direction lock: there will be two independent Better Auth implementations:

- existing: `auth-service.ts` (unchanged)
- new: `Auth.ts` Effect 4 service (separate config/build path)

Key code excerpts driving constraints:

```ts
// src/lib/auth-service.ts
// [BUG]: Stripe plugin does not handle lookupKey...
// Workaround: populate `priceId`.
plans: async () => {
  const plans = await stripeService.getPlans();
  return plans.map((plan) => ({
    name: plan.name,
    priceId: plan.monthlyPriceId,
    annualDiscountPriceId: plan.annualPriceId,
  }));
}
```

```ts
// src/lib/auth-service.ts
// Must be last so it sees final response headers.
tanstackStartCookies(),
```

```ts
// src/lib/auth-service.ts
databaseHookSessionCreateBefore: async (session) => {
  const activeOrganizationId =
    (await options.db
      .prepare("select id from Organization where id in ...")
      .bind(session.userId)
      .first<number>("id")) ?? undefined;
  return { data: { ...session, activeOrganizationId } };
},
```

The existing implementation uses request-scoped session today; new `Auth.ts` is intentionally independent per direction.

## Effect 4 Patterns To Match

Local pattern (already used):

```ts
export class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () { ... }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

```ts
export class Stripe extends ServiceMap.Service<Stripe>()("Stripe", {
  make: Effect.gen(function* () { ... }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

Effect docs:

```md
// refs/effect4/migration/services.md
In v4, `ServiceMap.Service` with `make` ... Define layers explicitly using `Layer.effect`.
```

```md
// refs/effect4/migration/services.md
Prefer `yield*` over `use` in most cases.
```

Config/layer construction pattern:

```ts
// refs/effect4/packages/ai/openai/src/OpenAiClient.ts
export const layer = (options: Options) =>
  Layer.effect(OpenAiClient, make(options))
```

```ts
// refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts
static readonly layer = Layer.unwrap(
  Effect.gen(function*() {
    // decide concrete layer from config
  })
)
```

## Proposed Auth.ts Design

## 1) Error model

Single error type (match current project direction in `D1.ts` / `Stripe.ts`):

```ts
export class AuthError extends Data.TaggedError("AuthError")<{
  readonly op: string;
  readonly message: string;
  readonly cause: Error;
}> {}
```

`tryAuth(op, evaluate)` wraps Promise APIs via `Effect.tryPromise`.

## 2) Service dependencies

`Auth` needs:

- `D1` service
- `Stripe` service (effect Stripe)
- `CloudflareEnv` for env settings (`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `STRIPE_WEBHOOK_SECRET`, etc)

Then:

```ts
export class Auth extends ServiceMap.Service<Auth>()("Auth", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;
    const stripe = yield* Stripe;
    const env = yield* CloudflareEnv;
    ...
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

This keeps service style identical to `D1` / `Repository` / `Stripe`.

## 3) Service shape

Independent Better Auth instance (not wrapper):

```ts
const auth = betterAuth({
  // full config implemented directly in Auth.ts
  database: d1Adapter(/* from D1 service */),
  hooks: { ... },
  plugins: [magicLink(...), admin(), organization(...), stripe(...), tanstackStartCookies()],
});

return {
  auth, // raw Better Auth object (for $Infer + escape hatch)
  handler: (request) => tryAuth("Auth.handler", () => auth.handler(request)),
  api: auth.api,
};
```

## 4) Construction strategy (recommended)

Do not call `createAuthService` from `Auth.ts`.

Reason:

- requirement is two independent implementations
- avoids hidden coupling with legacy service
- allows Effect-native evolution without touching existing auth path

## Better Auth-Specific Notes To Preserve

From Better Auth TanStack docs:

```md
plugins: [tanstackStartCookies()] // make sure this is the last plugin in the array
```

From Better Auth options docs:

```md
hooks: {
  before: createAuthMiddleware(async (ctx) => { ... }),
  after: createAuthMiddleware(async (ctx) => { ... })
}
```

`auth-service.ts` already follows both, should be preserved exactly.

## Suggested Implementation Phases

1. `Auth.ts` standalone Effect service:
   - depends on `D1`, `Stripe`, `CloudflareEnv`
   - builds its own Better Auth options inline (independent)
   - exports `AuthError`, `Auth` service
2. Add thin Effect helpers for app-used API methods listed above.
3. Migrate new Effect programs to use `yield* Auth`.
4. Keep `auth-service.ts` + existing route code until each call-site is moved.

## Biggest Risks

1. Behavior drift between the two Better Auth implementations.
2. Type explosion:
   - Better Auth `api` generic types are large; keep wrappers scoped to app-used methods.
3. Hook closure correctness:
   - current file relies on `auth` closure (`databaseHookUserCreateAfter` calls `auth.api.createOrganization`).
   - preserve this exact initialization behavior.

## Recommendation

Implement `Auth.ts` as a standalone Better Auth Effect service that depends on `D1`, `Stripe`, and `CloudflareEnv`, with config duplicated intentionally from `auth-service.ts` and evolved independently.

No blocking questions.
