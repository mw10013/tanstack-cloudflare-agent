# Removing Legacy Service Files: auth-service.ts, stripe-service.ts, repository-service.ts

## Summary

All three legacy service files have Effect 4 replacements already in use. Two can be deleted immediately; one requires two type import changes first.

| Legacy File | Effect 4 Replacement | Imports in Source | Action |
|---|---|---|---|
| `stripe-service.ts` | `Stripe.ts` | 0 (only from auth-service.ts) | Delete immediately |
| `repository-service.ts` | `Repository.ts` | 0 | Delete immediately |
| `auth-service.ts` | `Auth.ts` | 2 files (type-only) | Migrate types, then delete |

## Detailed Analysis

### stripe-service.ts → Stripe.ts

**Zero active imports.** Only imported by `auth-service.ts` itself.

`Stripe.ts` (Effect Service) provides the same API surface:
- `stripe` — Stripe client instance
- `getPlans()` — plan fetching with KV cache
- `ensureBillingPortalConfiguration()` — billing portal setup

Already consumed by `Auth.ts` line 13, 57, 110, 148.

### repository-service.ts → Repository.ts

**Zero active imports.**

`Repository.ts` (Effect Service) provides all the same methods but returns `Effect<...>` instead of `Promise<...>`. Already used in `worker.ts:125`.

### auth-service.ts → Auth.ts

**Two files import `AuthService` type** (type-only, no runtime usage):

#### 1. `src/worker.ts:1,31`

```ts
import type { AuthService } from "@/lib/auth-service";
// ...
session?: AuthService["$Infer"]["Session"];
```

The `session` value comes from `auth.getSession(headers)` at `worker.ts:102-106`, which returns Better Auth's inferred session type. The `ServerContext.session` type must match this return type.

**Replacement options:**

- **Option A: Export `BetterAuth` type from `Auth.ts`** — Add a type export like `export type BetterAuth = typeof auth` from inside the service, then use `BetterAuth["$Infer"]["Session"]`. Keeps exact type parity with the runtime value.
- **Option B: Use `Awaited<ReturnType<Auth["Service"]["getSession"]>>["Value"]`** — Derives type from the Effect service's return type. Verbose but no new exports needed.
- **Option C: Use `Domain.Session` + inline user shape** — The `$Infer` Session is `{ session: {...}, user: {...} }`. `Domain.Session` and `Domain.User` exist but are decoded Effect schemas (e.g., `Date` fields), while Better Auth returns raw strings for dates. **Type mismatch risk.**

**Recommendation: Option A.** Export a type alias from `Auth.ts` for the underlying Better Auth instance, then reference `$Infer` from it.

#### 2. `src/routes/app.$organizationId.tsx:1,116-117,384-385`

```ts
import type { AuthService } from "@/lib/auth-service";
// ...
organization: AuthService["$Infer"]["Organization"];
organizations: AuthService["$Infer"]["Organization"][];
```

Used in `AppSidebar` and `OrganizationSwitcher` component prop types.

**Replacement options:**

Same options as above. With Option A, these become `BetterAuth["$Infer"]["Organization"]`.

Alternatively, since `Domain.Organization` has decoded `Date` fields while Better Auth's `$Infer` Organization has string dates, using Domain types would require ensuring the data passed to these components matches the decoded schema. The data originates from Better Auth's `listOrganizations` API, so Better Auth's own `$Infer` type is the correct choice.

## Migration Plan

### Phase 1: Delete zero-import files
1. Delete `src/lib/stripe-service.ts`
2. Delete `src/lib/repository-service.ts`

### Phase 2: Migrate auth-service.ts types
1. In `src/lib/Auth.ts`, export a type for the Better Auth instance:
   ```ts
   type BetterAuthInstance = ReturnType<typeof betterAuth<ReturnType<typeof createBetterAuthOptions>>>;
   export type { BetterAuthInstance as BetterAuth };
   ```
   Note: The exact approach depends on whether `betterAuth()` generic inference works with the options factory. May need to extract the type differently — e.g., storing the auth options type or using a type-level helper.

2. In `src/worker.ts`:
   - Replace `import type { AuthService } from "@/lib/auth-service"` → `import type { BetterAuth } from "@/lib/Auth"`
   - Replace `AuthService["$Infer"]["Session"]` → `BetterAuth["$Infer"]["Session"]`

3. In `src/routes/app.$organizationId.tsx`:
   - Replace `import type { AuthService } from "@/lib/auth-service"` → `import type { BetterAuth } from "@/lib/Auth"`
   - Replace `AuthService["$Infer"]["Organization"]` → `BetterAuth["$Infer"]["Organization"]`

4. Delete `src/lib/auth-service.ts`

### Phase 3: Verify
- `pnpm typecheck` — confirm no type errors
- `pnpm lint` — confirm no unused imports

## Type Export Challenge

The tricky part is extracting the Better Auth instance type from inside `Auth.make` (an Effect generator). The `betterAuth()` call at `Auth.ts:261` is inside `Effect.gen`, so its return type isn't directly accessible at module scope.

Approaches to solve this:

1. **Hoist the options type** — `createBetterAuthOptions` is already a standalone function. Its return type can be used:
   ```ts
   export type BetterAuth = ReturnType<typeof betterAuth<ReturnType<typeof createBetterAuthOptions>>>;
   ```

2. **Use `Auth["Service"]` inference** — The `Auth` Effect service returns `{ auth, api, handler, getSession }`. The `getSession` return type can derive the session type without needing `$Infer`:
   ```ts
   type AuthSession = Awaited<ReturnType<Awaited<ReturnType<Auth["Service"]["getSession"]>>>>
   ```
   But this is complex and fragile.

3. **Simplest: just call `typeof betterAuth` with the options** at module level for type inference only, without actually executing it.

Approach 1 is cleanest. Test with `pnpm typecheck` to confirm the generic inference works.
