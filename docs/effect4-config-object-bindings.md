# Effect 4 Config: Object Bindings Not Supported

## Problem

Cloudflare Workers expose resources (D1, R2, KV, Durable Objects) as **object bindings** on the `env` parameter. Effect's Config system is **string-based** — leaf values are always strings. You can't pass a `D1Database` instance through Config.

## Prior Art

[cloudflare-effect-config-object-poc](https://github.com/mw10013/cloudflare-effect-config-object-poc) proposed `Config.object` and `ConfigProvider.fromObject` for Effect 3. The POC worked by type-punning object references as strings through `ConfigProvider.fromMap`, then casting them back via `Config.mapOrFail`. Clever but fundamentally a hack — smuggling objects through a string-typed channel.

## Effect 4 Config Capabilities

Effect 4 Config supports nested structured data via:
- `Config.all({ ... })` — combine configs into an object
- `Config.schema(Schema.Struct({ ... }))` — nested objects from env vars
- `ConfigProvider.fromUnknown(obj)` — traverse a JS object

All of these still resolve to **string leaf values**. `ConfigProvider.Node` is `Value (string) | Record (keys) | Array (length)`. No variant for opaque objects.

## Conclusion: Abandon This Approach

Don't fight the library. Config is designed for string-based configuration (env vars, .env files, JSON). Forcing object bindings through it requires side-channel hacks (module-scoped Maps, type punning) that are fragile and non-idiomatic.

## Recommended: ServiceMap Pattern

Pass Cloudflare bindings through Effect 4's `ServiceMap` + `runPromiseWith` — no Layers needed. Cloudflare owns the resource lifecycle, so there's nothing to acquire/release.

```ts
const CfEnv = ServiceMap.Service<{
  DB: D1Database
  KV: KVNamespace
}>("CfEnv")

export default {
  async fetch(req: Request, env: CloudflareEnv) {
    const services = ServiceMap.make(CfEnv, { DB: env.DB, KV: env.KV })
    const run = Effect.runPromiseWith(services)
    return run(handleRequest(req))
  }
}
```

Use Config for string-based settings (env vars, secrets, feature flags). Use ServiceMap for object bindings.

See [effect4-runtime-servicemap-cloudflare.md](./effect4-runtime-servicemap-cloudflare.md) for the full ServiceMap pattern.
