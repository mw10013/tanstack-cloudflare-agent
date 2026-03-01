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

Auth is more complex — it passes the entire `env` object to `createBetterAuthOptions`. This would require refactoring the options function to accept individual config values, or using `Config.all`:

```ts
const authConfig = yield* Config.all({
  betterAuthUrl: Config.string("BETTER_AUTH_URL"),
  betterAuthSecret: Config.redacted("BETTER_AUTH_SECRET"),
  environment: Config.string("ENVIRONMENT"),
  transactionalEmail: Config.string("TRANSACTIONAL_EMAIL"),
  demoMode: Config.boolean("DEMO_MODE"),
});
```

More detail here so we can better assess viability of Config.all. Also string vs non-empty string or some such. This will blow up with empty strings, right?

### Error Channel Impact

`Config` introduces `Config.ConfigError` into the error channel. Since `makeRunEffect` already uses `Cause.squash` → Error normalization, `ConfigError` will naturally flow through the existing error handling. No changes needed to `makeRunEffect`.

### Type Safety Note

`Config.string("ENVIRONMENT")` returns `string`, losing the literal union type `"production" | "local"` from the Env interface. For cases where the literal type matters, use:

```ts
const environment = yield* Config.literal("production", "ENVIRONMENT").pipe(
  Config.orElse(() => Config.literal("local", "ENVIRONMENT"))
);
// or just cast after Config.string if the union is well-known
```

More detail here. I only vaguely understand this. Your other examples just used string which seems not so great since empty strings would blow up. And now with literal. Would we need to enumerate all the literals. Lay out the different approaches with trade-offs and make recommendation.

## Key Decisions Needed

1. **Incremental vs. big-bang?** — Recommend incremental: migrate one route/service at a time since both patterns coexist.

Big bang

2. **Auth.ts refactor scope** — Auth passes `env` to `createBetterAuthOptions` which spreads it widely. Consider deferring Auth migration or extracting a config struct.

Leaning toward config struct.

3. **Config.redacted for secrets?** — `Config.redacted` wraps in `Redacted<string>`, requiring `Redacted.value()` to unwrap. More secure (won't leak in logs) but adds unwrap calls.

use redacted.

4. **Keep CloudflareEnv service?** — Yes, for bindings. Could rename to `CloudflareBindings` for clarity but not required.

Keep CloudflareEnv
