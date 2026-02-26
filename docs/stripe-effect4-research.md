# Stripe.ts Effect 4 Research

Goal: design `src/lib/Stripe.ts` as an Effect 4 service equivalent of `src/lib/stripe-service.ts`, while leaving `stripe-service.ts` unchanged.

## Current Behavior Contract (must preserve)

From `src/lib/stripe-service.ts`:

```ts
export function createStripeService() {
  const stripe = new Stripe.Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-10-29.clover",
  });
  const getPlans = async (): Promise<Plan[]> => { ... };
  const ensureBillingPortalConfiguration = async (): Promise<void> => { ... };
  return { stripe, getPlans, ensureBillingPortalConfiguration };
}
```

Key behaviors:

1. `stripe` SDK client is exposed for direct callers.
2. `getPlans()`:
   - reads KV key `stripe:plans`
   - validates cached JSON with `Schema.decodeUnknownOption(Schema.Array(PlanSchema))`
   - on miss, reads Stripe prices by lookup keys from `planData`
   - if no prices exist, creates products then monthly+annual prices
   - validates lookup keys + expected count (`planData.length * 2`)
   - stores result in KV
3. `ensureBillingPortalConfiguration()`:
   - reads KV key `stripe:isBillingPortalConfigured`
   - if not cached, lists portal configs
   - creates one if none exists, configured for plan upgrades/cancel/update
   - if one+ exists, marks KV key `"true"`

Compatibility constraints from usage:

- `auth-service.ts` needs:
  - `stripeService.stripe` as `stripeClient` for Better Auth plugin
  - `stripeService.getPlans()`
  - `stripeService.ensureBillingPortalConfiguration()`
- `routes/api/e2e/delete/user/$email.tsx` calls `stripeService.stripe.customers.*` directly.

So Effect service shape should still expose raw `stripe` client.

Additional constraints from current code and Stripe types:

1. `planData.flatMap(monthly, annual)` feeds `prices.list({ lookup_keys })`.
2. Stripe type docs say `lookup_keys` accepts up to 10 keys (`node_modules/stripe/types/PricesResource.d.ts`).
3. With 2 keys per plan, this flow supports at most 5 plans per call before chunking is required.

## Effect 4 Patterns To Follow

Local project patterns:

```ts
export class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () { ... }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

```ts
export class Repository extends ServiceMap.Service<Repository>()("Repository", {
  make: Effect.gen(function* () { ... }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

Effect 4 docs / refs:

From `refs/effect4/migration/services.md`:

```md
In v4, `ServiceMap.Service` with `make` stores the constructor effect on the
class but does **not** auto-generate a layer. Define layers explicitly using
`Layer.effect`.
```

From `refs/effect4/migration/services.md`:

```md
**Prefer `yield*` over `use` in most cases.**
```

From `refs/effect4/ai-docs/src/01_effect/01_basics/10_creating-effects.ts`:

```ts
Effect.tryPromise({
  async try() { ... },
  catch: (cause) => new UserLookupError({ userId, cause })
})
```

From `refs/effect4/migration/layer-memoization.md`:

```md
In v4 ... `MemoMap` ... is shared between `Effect.provide` calls ...
layers are automatically memoized / deduplicated across `Effect.provide` calls.
```

## Proposed `Stripe.ts` Shape

Use class+`make` pattern (same as `D1.ts` / `Repository.ts`), keep SDK exposed:

```ts
import type { Plan } from "@/lib/Domain";
import type { Stripe as StripeTypes } from "stripe";
import { Cause, Data, Effect, Layer, Option, Schedule, Schema, ServiceMap } from "effect";
import * as StripeSdk from "stripe";
import { planData, Plan as PlanSchema } from "@/lib/Domain";
import { CloudflareEnv } from "./effect-services";

export class StripeError extends Data.TaggedError("StripeError")<{
  readonly op: string;
  readonly message: string;
  readonly cause: Error;
  readonly retryable: boolean;
}> {}

export class Stripe extends ServiceMap.Service<Stripe>()("Stripe", {
  make: Effect.gen(function* () {
    const env = yield* CloudflareEnv;
    const stripe = new StripeSdk.Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-10-29.clover",
    });
    return {
      stripe,
      getPlans: (): Effect.Effect<Plan[], StripeError> => ...,
      ensureBillingPortalConfiguration: (): Effect.Effect<void, StripeError> => ...,
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

Notes:

1. Name service class `Stripe`; import SDK namespace as `StripeSdk` to avoid symbol collision.
2. Pull env from `CloudflareEnv` (local pattern in `D1.ts`) instead of `cloudflare:workers` global `env`.
3. Keep API version identical to existing service.

## Method Design Mapping

### `getPlans`

Effect steps equivalent to current async flow:

1. `kvGetPlans` effect: `Effect.tryPromise` around `env.KV.get("stripe:plans", { type: "json" })`.
2. Cache decode effect:
   - `Schema.decodeUnknownOption(Schema.Array(PlanSchema))(cached)`
   - if `Option.isSome`, return clone of plans.
3. On miss:
   - load price list by lookup keys
   - create products/prices if empty
   - assert expected count and expanded product type
   - map to `Plan[]`
   - persist KV with `env.KV.put("stripe:plans", JSON.stringify(plans))`

### `ensureBillingPortalConfiguration`

1. Read KV flag key.
2. If true, succeed void.
3. List Stripe portal configs.
4. If none:
   - call `getPlans`
   - derive basic/pro plan IDs
   - create billing portal configuration
5. Else:
   - warn if >1
   - store KV flag true

Parity note: current implementation only sets KV true in existing-config branch. Keep this exact behavior if strict parity required.

## Invariant Mapping

Current file uses `invariant(...)` throws for domain assumptions:

- missing `lookup_key`
- missing monthly/annual price
- non-expanded product
- wrong number of matched prices
- missing `basic` / `pro` plan

Effect version should convert these to typed failures (`Effect.fail(new StripeError(...))`) to keep failures in the error channel instead of unchecked throw paths.

## Error + Retry Strategy

Stripe SDK error types available in `node_modules/stripe/types/Errors.d.ts` include:

- `StripeInvalidRequestError`
- `StripeAuthenticationError`
- `StripePermissionError`
- `StripeRateLimitError`
- `StripeConnectionError`
- `StripeAPIError`

Suggested helper:

```ts
const tryStripe = <A>(op: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => {
      const cause =
        Cause.isUnknownError(error) && error.cause instanceof Error
          ? error.cause
          : error instanceof Error
            ? error
            : new Error(String(error));
      const type = (cause as { type?: string }).type;
      const retryable =
        type === "StripeRateLimitError" ||
        type === "StripeConnectionError" ||
        type === "StripeAPIError";
      return new StripeError({ op, message: cause.message, cause, retryable });
    }),
    Effect.retry({
      while: (error) => error.retryable,
      times: 2,
      schedule: Schedule.exponential("250 millis"),
    }),
  );
```

Why this matches project style:

- `D1.ts` already centralizes Promise wrapping + error normalization + retry (`tryD1`).
- Stripe service should use same composition pattern.

## Caching Strategy

Keep cross-request cache in Cloudflare KV exactly as current implementation.

Optional Effect-only optimization:

- wrap `getPlansUncached` with `Effect.cachedWithTTL(...)` for short in-memory cache.
- useful only within lifetime of provided layer / memo map.
- not a replacement for KV.

Because current app also already uses KV, this optimization is optional and not required for parity.

## Layer Integration Plan (no code changes yet)

When implementing later:

1. Add `src/lib/Stripe.ts`.
2. Keep `src/lib/stripe-service.ts` untouched.
3. Add `Stripe.layer` into app layer composition when effect-side consumers need it.
4. Migrate call sites incrementally:
   - old async code keeps `stripe-service.ts`
   - new Effect code uses `yield* Stripe`.

## Locked Decisions

1. Strict parity with `stripe-service.ts` behavior.
2. Single error type: `StripeError`.
3. Stronger immutability: `getPlans` returns `Effect<ReadonlyArray<Plan>, StripeError>`.
