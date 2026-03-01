# Effect Config Research

## Goal

Replace direct `CloudflareEnv` service access for scalar config values (strings, secrets, booleans) with `Config` from Effect 4. Keep `CloudflareEnv` only for Cloudflare bindings (D1, R2, KV, Durable Objects, Queue, AI, RateLimit, Workflow).

## How Config Works (Effect 4)

### Core Concepts

- **`Config<T>`** — a recipe for extracting a typed value from a `ConfigProvider`. Yieldable in `Effect.gen`.
- **`ConfigProvider`** — the backing data source. Registered as a `ServiceMap.Reference` with default `fromEnv()`.
- **`ConfigProvider.fromUnknown(obj)`** — creates a provider from a plain JS object (key lookup by path segments).
- **`Config.ConfigError`** — wraps either `SourceError` (I/O) or `SchemaError` (validation).

### Already Provided in Our Codebase

`src/lib/effect-services.ts` already installs a `ConfigProvider` backed by the Cloudflare `env` object:

```ts
ServiceMap.add(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromUnknown(env),
)
```

This means `yield* Config.string("ENVIRONMENT")` already resolves from our Cloudflare env — no additional setup needed.

### Proof: Existing Usage

`src/routes/app.$organizationId.effect.tsx` already uses Config:

```ts
const environment = yield* Config.string("ENVIRONMENT");
```

## Config API Reference

### Primitive Constructors

All return `Config<T>` — yieldable in `Effect.gen`.

| Constructor | Type | Example |
|---|---|---|
| `Config.string("KEY")` | `string` | `yield* Config.string("ENVIRONMENT")` |
| `Config.nonEmptyString("KEY")` | `string` (non-empty) | `yield* Config.nonEmptyString("BETTER_AUTH_URL")` |
| `Config.number("KEY")` | `number` | `yield* Config.number("PORT")` |
| `Config.int("KEY")` | `number` (integer) | `yield* Config.int("PORT")` |
| `Config.boolean("KEY")` | `boolean` | `yield* Config.boolean("DEMO_MODE")` — accepts `true/false/yes/no/on/off/1/0/y/n` |
| `Config.redacted("KEY")` | `Redacted<string>` | `yield* Config.redacted("STRIPE_SECRET_KEY")` — hidden from logs/toString |
| `Config.url("KEY")` | `URL` | `yield* Config.url("BETTER_AUTH_URL")` |
| `Config.port("KEY")` | `number` (1–65535) | `yield* Config.port("PORT")` |
| `Config.literal(value, "KEY")` | literal type | `Config.literal("production", "ENVIRONMENT")` |

### Combinators

```ts
// Default value (only for missing data, not validation errors)
Config.string("HOST").pipe(Config.withDefault("localhost"))

// Optional (returns Option<T>)
Config.option(Config.number("PORT"))

// Transform
Config.string("NAME").pipe(Config.map(s => s.toUpperCase()))

// Fallback on any error
Config.string("HOST").pipe(Config.orElse(() => Config.succeed("localhost")))

// Combine multiple configs into struct
Config.all({
  host: Config.string("HOST"),
  port: Config.number("PORT"),
})

// Namespace/prefix
Config.all({
  host: Config.string("host"),
  port: Config.number("port"),
}).pipe(Config.nested("database"))
```

### Schema-Based Config

```ts
// Structured config from a Schema
const AppConfig = Config.schema(
  Schema.Struct({
    host: Schema.String,
    port: Schema.Int,
  }),
  "app" // optional root path
)

// yields { host: string, port: number }
const config = yield* AppConfig;
```

## Idiomatic Patterns from Effect 4 Source

### Pattern 1: Direct yield in Effect.gen (Route handlers)

```ts
// BEFORE (CloudflareEnv)
const env = yield* CloudflareEnv;
const environment = env.ENVIRONMENT;
const demoMode = env.DEMO_MODE === "true";

// AFTER (Config)
const environment = yield* Config.string("ENVIRONMENT");
const demoMode = yield* Config.boolean("DEMO_MODE");
```

### Pattern 2: Config in Layer construction (Services)

From `refs/effect4/ai-docs/src/01_effect/04_resources/10_acquire-release.ts`:

```ts
static readonly layer = Layer.effect(
  Smtp,
  Effect.gen(function*() {
    const user = yield* Config.string("SMTP_USER")
    const pass = yield* Config.redacted("SMTP_PASS")
    // ...build service using config values
  })
)
```

### Pattern 3: Config-driven Layer selection (Layer.unwrap)

From `refs/effect4/ai-docs/src/01_effect/02_services/20_layer-unwrap.ts`:

```ts
static readonly layer = Layer.unwrap(
  Effect.gen(function*() {
    const useInMemory = yield* Config.boolean("MESSAGE_STORE_IN_MEMORY").pipe(
      Config.withDefault(false)
    )
    if (useInMemory) return MessageStore.layerInMemory
    const remoteUrl = yield* Config.url("MESSAGE_STORE_URL")
    return MessageStore.layerRemote(remoteUrl)
  })
)
```

### Pattern 4: layerConfig for library clients

From `refs/effect4/ai-docs/src/71_ai/10_language-model.ts`:

```ts
const AnthropicClientLayer = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY")
})
```

### Pattern 5: Config in logging/observability

From `refs/effect4/ai-docs/src/08_observability/10_logging.ts`:

```ts
const env = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"))
```

## Migration Plan

### What Changes

Routes and services that access **scalar string/number/boolean values** from `CloudflareEnv` should use `Config` instead.

### What Stays on CloudflareEnv

Cloudflare bindings are **not** string config — they're runtime service objects. `ConfigProvider.fromUnknown` will not meaningfully resolve them. Keep `CloudflareEnv` for:

- `D1` (D1Database)
- `R2` (R2Bucket)
- `KV` (KVNamespace)
- `AI` (Ai)
- `R2_UPLOAD_QUEUE` (Queue)
- `MAGIC_LINK_RATE_LIMITER` (RateLimit)
- `ORGANIZATION_AGENT` (DurableObjectNamespace)
- `OrganizationWorkflow` (Workflow)
- `OrganizationImageClassificationWorkflow` (Workflow)

### Migration Examples

#### Route: login.tsx

```ts
// BEFORE
const env = yield* CloudflareEnv;
return { isDemoMode: env.DEMO_MODE === "true" };

// AFTER
const demoMode = yield* Config.boolean("DEMO_MODE");
return { isDemoMode: demoMode };
```

```ts
// BEFORE (still needs CloudflareEnv for KV binding)
const env = yield* CloudflareEnv;
if (env.ENVIRONMENT !== "local") {
  const whitelist = env.EMAIL_WHITELIST.split(",")...
}
const magicLink = env.DEMO_MODE === "true"
  ? (yield* Effect.tryPromise(() => env.KV.get(`demo:magicLink`))) ?? undefined
  : undefined;

// AFTER (Config for scalars, CloudflareEnv for KV)
const environment = yield* Config.string("ENVIRONMENT");
const demoMode = yield* Config.boolean("DEMO_MODE");
if (environment !== "local") {
  const whitelist = (yield* Config.string("EMAIL_WHITELIST"))
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
}
const env = yield* CloudflareEnv; // only for KV binding
const magicLink = demoMode
  ? (yield* Effect.tryPromise(() => env.KV.get(`demo:magicLink`))) ?? undefined
  : undefined;
```

#### Service: Stripe.ts

```ts
// BEFORE
const env = yield* CloudflareEnv;
const stripe = new StripeClient.Stripe(env.STRIPE_SECRET_KEY, {...});

// AFTER
const stripeSecretKey = yield* Config.redacted("STRIPE_SECRET_KEY");
const stripe = new StripeClient.Stripe(Redacted.value(stripeSecretKey), {...});
```

#### Service: Auth.ts

Auth passes the entire `env` object to `createBetterAuthOptions`. Migrate to a config struct via `Config.all`:

```ts
const authConfig = yield* Config.all({
  betterAuthUrl: Config.nonEmptyString("BETTER_AUTH_URL"),
  betterAuthSecret: Config.redacted("BETTER_AUTH_SECRET"),
  environment: Config.nonEmptyString("ENVIRONMENT"),
  transactionalEmail: Config.nonEmptyString("TRANSACTIONAL_EMAIL"),
  demoMode: Config.boolean("DEMO_MODE"),
});
// authConfig: { betterAuthUrl: string, betterAuthSecret: Redacted<string>, ... }
```

**`Config.all` details:**
- Accepts a record of `Config`s → returns `Config<{ key: T, ... }>` with all values resolved.
- All configs resolve from the same `ConfigProvider` — our `fromUnknown(env)`.
- If any single config fails, the whole `Config.all` fails with `ConfigError`.
- The result is a plain object, so refactoring `createBetterAuthOptions` to accept `typeof authConfig` instead of `Env` is straightforward.

**`string` vs `nonEmptyString` — empty string behavior:**
- `Config.string("KEY")` = `Config.schema(Schema.String)` — succeeds on `""`. An env var set to `""` silently passes through.
- `Config.nonEmptyString("KEY")` = `Config.schema(Schema.NonEmptyString)` — fails with `ConfigError` (SchemaError) on `""`.
- For config values that must have a real value (URLs, secrets, emails), use `nonEmptyString`. For values where `""` is a valid sentinel, use `string`.
- Recommendation: **default to `nonEmptyString`** for most env vars. Use `string` only where empty is explicitly valid (e.g., `R2_S3_ACCESS_KEY_ID` which can be `""`).

### Error Channel Impact

`Config` introduces `Config.ConfigError` into the error channel. Since `makeRunEffect` already uses `Cause.squash` → Error normalization, `ConfigError` will naturally flow through the existing error handling. No changes needed to `makeRunEffect`.

### Type Safety: string vs nonEmptyString vs literal vs schema

The `Env` interface types some values as literal unions (e.g., `ENVIRONMENT: "production" | "local"`). Config constructors vary in how much type precision they preserve.

#### Approach 1: `Config.nonEmptyString` — recommended default

```ts
const environment = yield* Config.nonEmptyString("ENVIRONMENT");
// type: string
```

- **Type**: `string` — loses literal narrowing.
- **Validation**: rejects `""` and missing keys. Catches misconfiguration early.
- **Trade-off**: you can't do `if (environment === "production")` with exhaustive switch. But you can still compare strings — you just don't get a compile-time guarantee that only `"production" | "local"` exist.
- **When**: most config values. URLs, emails, tokens, account IDs, bucket names.

#### Approach 2: `Config.schema(Schema.Literals([...]))` — for known enums

```ts
const environment = yield* Config.schema(
  Schema.Literals(["production", "local"]),
  "ENVIRONMENT"
);
// type: "production" | "local"
```

- **Type**: `"production" | "local"` — full literal union preserved.
- **Validation**: rejects any value not in the list. If someone sets `ENVIRONMENT=staging`, it fails with `ConfigError`.
- **Trade-off**: you must enumerate all valid values. If a new environment is added to wrangler.jsonc but not here, it breaks at runtime.
- **When**: values where you branch on the literal (`if (env === "production")`) and want exhaustive checking.

#### Approach 3: `Config.literal(value)` — single literal only

```ts
const environment = yield* Config.literal("production", "ENVIRONMENT");
// type: "production"
```

- **Type**: single literal. Only useful with `Config.orElse` chains.
- **Not recommended** — `Config.schema(Schema.Literals([...]))` is strictly better for unions.

#### Approach 4: `Config.string` — most permissive

```ts
const value = yield* Config.string("R2_S3_ACCESS_KEY_ID");
// type: string — "" is valid
```

- **When**: only for values where empty string is intentionally valid.

#### Recommendation

| Category | Constructor | Examples |
|---|---|---|
| Most env vars | `Config.nonEmptyString` | `BETTER_AUTH_URL`, `EMAIL_WHITELIST`, `CF_ACCOUNT_ID` |
| Secrets | `Config.redacted` | `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Booleans | `Config.boolean` | `DEMO_MODE` |
| Known enums | `Config.schema(Schema.Literals([...]))` | `ENVIRONMENT` |
| Empty-valid | `Config.string` | `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY` |

The recommendation for `ENVIRONMENT` seems a little onerous and too manual. How do you keep the Literals up to date if they change? Would have to update them manually in multiple places? Or should this Schema.Literals be in Domain.ts? That may be better I guess, but then you also need to manually keep it in sync with what's in the cloudflare env, but I suppose there's no way around that.

I need more research here with effective approaches that are functional and idiomatic to effect 4.

## Decisions

1. **Big-bang migration** — migrate all routes and services at once.
2. **Auth.ts** — extract a config struct via `Config.all`, refactor `createBetterAuthOptions` to accept it.
3. **Use `Config.redacted`** for all secrets (`BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `WORKERS_AI_API_TOKEN`, `GOOGLE_AI_STUDIO_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`). Unwrap with `Redacted.value()` at point of use.
4. **Keep `CloudflareEnv`** service name, used only for bindings (D1, R2, KV, AI, Queue, RateLimit, DurableObjects, Workflows).
