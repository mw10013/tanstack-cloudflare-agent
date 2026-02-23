# Effect 4: Runtime, ServiceMap & Cloudflare Workers

Running Effect programs on Cloudflare Workers in Effect 4. Covers `ServiceMap`, `runPromiseWith`, `Reference`, `Layer`, and `.use()`.

## ServiceMap

### What it is

A typed `Map<string, any>` that holds service implementations. Replaces v3's `Context`.

```ts
export interface ServiceMap<in Services> {
  readonly mapUnsafe: ReadonlyMap<string, any>
}
```

- **Keys**: string identifiers (e.g. `"Database"`)
- **Values**: the raw service implementation objects
- **`Services` type param**: purely phantom — exists only at the type level to track which services are present

`Contravariant` variance means `ServiceMap<A | B>` satisfies `ServiceMap<A>`. More services = satisfies narrower requirements.

### ServiceMap.Service

A **typed key** — a singleton object that carries two type params and a string key:

```ts
export interface Service<in out Identifier, in out Shape> {
  readonly key: string              // string key used in the Map
  readonly stack?: string           // captured stack trace for error messages
  of(self: Shape): Shape
  serviceMap(self: Shape): ServiceMap<Identifier>
  use<A, E, R>(f: (service: Shape) => Effect<A, E, R>): Effect<A, E, R | Identifier>
  useSync<A>(f: (service: Shape) => A): Effect<A, never, Identifier>
}
```

**Two type params:**

| Param | Purpose |
|---|---|
| `Identifier` | Phantom type used in `Effect<A, E, R>` requirements. When you write `Effect<string, never, Database>`, `Database` is the Identifier. |
| `Shape` | The actual service interface (e.g. `{ query: (sql: string) => string }`) |

With function syntax, `Identifier` and `Shape` are the same type:

```ts
const Database = ServiceMap.Service<{ query: (sql: string) => string }>("Database")
```

With class syntax, `Identifier = Self` (the class) and `Shape` is the interface:

```ts
class Database extends ServiceMap.Service<Database, {
  readonly query: (sql: string) => string
}>()("Database") {}
```

### How `yield* Database` works

`Service` implements `Yieldable`. Its `asEffect()` reads directly from `fiber.services`:

```ts
// ServiceMap.ts:194-196
asEffect(this: any) {
  const fn = this.asEffect = constant(withFiber((fiber) => exitSucceed(get(fiber.services, this))))
  return fn()
}
```

No effect scheduling, no async — a direct map lookup on the running fiber's ServiceMap.

### Building a ServiceMap

```ts
// Single service
const services = ServiceMap.make(Database, { query: (sql) => `Result: ${sql}` })

// Add more
const services = ServiceMap.make(Database, dbImpl)
  .pipe(ServiceMap.add(Logger, loggerImpl))
  .pipe(ServiceMap.add(Config, configImpl))

// Or merge multiple maps
const services = ServiceMap.mergeAll(dbMap, loggerMap, configMap)
```

### Full API

| Function | Purpose |
|---|---|
| `make(key, impl)` | Create ServiceMap with one service |
| `empty()` | Empty ServiceMap |
| `add(key, impl)` | Add a service, returns new ServiceMap |
| `addOrOmit(key, Option)` | Add if Some, remove if None |
| `merge(that)` | Merge two ServiceMaps (right wins on conflict) |
| `mergeAll(...maps)` | Merge N ServiceMaps |
| `get(map, key)` | Get service (type-safe — requires `I extends Services`) |
| `getUnsafe(map, key)` | Get service (throws if missing) |
| `getOption(map, key)` | Get as `Option<S>` |
| `getOrElse(map, key, fallback)` | Get with fallback |
| `getOrUndefined(map, key)` | Get or undefined |
| `pick(...keys)` | Keep only specified services |
| `omit(...keys)` | Remove specified services |
| `makeUnsafe(map)` | Create from raw `Map<string, any>` |
| `isServiceMap(u)` | Type guard |
| `isService(u)` | Type guard |

### v3 Context vs v4 ServiceMap

| Problem | v3 Context | v4 ServiceMap |
|---|---|---|
| Data structure | Linked list of `(Tag, value)` pairs — O(n) lookup | `Map<string, any>` — O(1) lookup |
| Service identity | Tags used class identity + unique symbols, fragile across module boundaries | Simple string keys — stable, serializable |
| Proxy accessors | `Effect.Tag` created mapped-type proxies that erased generics and lost overloads | Removed entirely; use `yield*` or `.use()` |
| Runtime type | `Runtime<R>` bundled context + runtimeFlags + fiberRefs | Eliminated; ServiceMap is the only thing fibers carry |
| FiberRefs | Separate concept from Context, stored separately | Merged into ServiceMap as `Reference`s with defaults |

Biggest practical win: **FiberRefs and Context are unified**. In v3, `Scheduler`, `Tracer`, `LogLevel` were `FiberRef`s (separate mechanism). In v4, they're all `Reference`s in the ServiceMap. One data structure, one lookup, one API.

## Reference: Service with a Default

A **Reference** is a Service that always has a value because it carries a `defaultValue` factory:

```ts
const LogLevel = ServiceMap.Reference("LogLevel", {
  defaultValue: () => "info" as const
})
```

Internally it's the same thing — a key that maps to a string in the `Map<string, any>`. The only difference is what happens when the key is missing from the map:

```ts
// ServiceMap.ts:672-678 — getUnsafe
if (!self.mapUnsafe.has(service.key)) {
  if (ReferenceTypeId in service) return getDefaultValue(service)  // Reference -> use default
  throw serviceNotFoundError(service)                               // Service -> throw
}
```

The default is lazily computed and cached on the Reference object:

```ts
// ServiceMap.ts:739-744
const getDefaultValue = (ref: Reference<any>) => {
  if (defaultValueCacheKey in ref) return ref[defaultValueCacheKey]
  return (ref as any)[defaultValueCacheKey] = ref.defaultValue()
}
```

### What Effect uses References for

Effect uses References internally for runtime infrastructure. When a fiber starts, `setServices` extracts these:

```ts
// internal/effect.ts:686-697
setServices(services: ServiceMap.ServiceMap<never>): void {
  this.services = services
  this.currentScheduler = this.getRef(Scheduler.Scheduler)          // Reference
  this.currentSpan = services.mapUnsafe.get(Tracer.ParentSpanKey)
  this.currentLogLevel = this.getRef(CurrentLogLevel)               // Reference
  this.minimumLogLevel = this.getRef(MinimumLogLevel)               // Reference
  this.maxOpsBeforeYield = this.getRef(Scheduler.MaxOpsBeforeYield) // Reference
}
```

### When to use Reference

When you have a service that should work out of the box but be overridable:

```ts
const Logger = ServiceMap.Reference("Logger", {
  defaultValue: () => ({ log: (msg: string) => console.log(msg) })
})

// Works without providing anything — uses console.log default
await Effect.runPromise(Logger.useSync((l) => l.log("hello")))

// Override in production
const services = ServiceMap.make(Logger, myProductionLogger)
await Effect.runPromiseWith(services)(program)
```

### Summary

| | Service | Reference |
|---|---|---|
| Missing from ServiceMap | Throws `Service not found` | Returns `defaultValue()` |
| Requires explicit provision | Yes | No |
| Use case | App-specific services (Database, Auth) | Infrastructure with sensible defaults (Logger, Tracer, Scheduler) |

## runPromiseWith

### The execution chain

Everything builds on `runForkWith`. Each `runXWith` variant is a curried function: takes a ServiceMap, returns a runner.

```ts
// internal/effect.ts:4606-4625
export const runForkWith = <R>(services: ServiceMap.ServiceMap<R>) =>
  <A, E>(effect: Effect<A, E, R>, options?: RunOptions): Fiber<A, E> => {
    const scheduler = options?.scheduler ||
      (!services.mapUnsafe.has(Scheduler.Scheduler.key) && new Scheduler.MixedScheduler())
    const fiber = new FiberImpl<A, E>(
      scheduler ? ServiceMap.add(services, Scheduler.Scheduler, scheduler) : services,
      options?.uninterruptible !== true
    )
    // ... starts the fiber with the ServiceMap baked in
  }

// runPromiseWith builds on runForkWith
export const runPromiseWith = <R>(services: ServiceMap.ServiceMap<R>) => {
  const runPromiseExit = runPromiseExitWith(services)
  return <A, E>(effect: Effect<A, E, R>, options?: RunOptions): Promise<A> =>
    runPromiseExit(effect, options).then((exit) => {
      if (exit._tag === "Failure") throw causeSquash(exit.cause)
      return exit.value
    })
}

// runPromise is just runPromiseWith(empty)
export const runPromise = runPromiseWith(ServiceMap.empty())
```

### No Effect.provide involved

`runPromiseWith` does **not** wrap the effect with `Effect.provide`. It passes the ServiceMap **directly to the Fiber constructor**. The Fiber stores it as `fiber.services` and every `yield* MyService` reads from that map. More direct — no extra effect wrapping or layer-building overhead.

### All runXWith variants

| Function | Returns |
|---|---|
| `runForkWith(services)` | `(effect) => Fiber<A, E>` |
| `runCallbackWith(services)` | `(effect, options?) => (interruptor?) => void` |
| `runPromiseWith(services)` | `(effect, options?) => Promise<A>` |
| `runPromiseExitWith(services)` | `(effect, options?) => Promise<Exit<A, E>>` |
| `runSyncWith(services)` | `(effect) => A` |
| `runSyncExitWith(services)` | `(effect) => Exit<A, E>` |

Each has a non-`With` counterpart that's just `runXWith(ServiceMap.empty())`.

### Type safety

If the ServiceMap doesn't satisfy all requirements of the effect, TypeScript catches it at compile time:

```ts
const services = ServiceMap.make(Database, dbImpl)
// ServiceMap<Database>

const run = Effect.runPromiseWith(services)
// run: <A, E>(effect: Effect<A, E, Database>) => Promise<A>

run(programNeedingDatabaseAndLogger)
//  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Type error: Logger not in ServiceMap<Database>
```

## Layers

Layers still exist in Effect 4. They haven't gone away. But they're **optional** — `runPromiseWith` with a hand-built `ServiceMap` bypasses them entirely.

### What a layer actually is

A Layer is a **recipe for building a ServiceMap, with resource lifecycle management.**

```
Layer<Out, Error, In>
  Out   = what services it produces
  Error = what can go wrong during construction
  In    = what services it needs to build
```

A Layer is not the services — it's a *factory* for services. The actual services live in a ServiceMap. A Layer is a blueprint: "given these inputs, here's how to build these outputs, and here's how to clean them up."

### Simplest layers

```ts
// From a plain value — no lifecycle, can't fail, needs nothing
const dbLayer = Layer.succeed(Database)({ query: (sql) => `Result: ${sql}` })
// Layer<Database, never, never>

// From an effect — can use other services during construction
const appLayer = Layer.effect(App)(
  Effect.gen(function*() {
    const db = yield* Database
    return { handle: (req) => db.query(req.sql) }
  })
)
// Layer<App, never, Database>

// Wire dependencies
const fullLayer = appLayer.pipe(Layer.provide(dbLayer))
// Layer<App, never, never>  — Database requirement satisfied
```

### Why layers exist: resource lifecycle

```ts
const poolLayer = Layer.effect(ConnectionPool)(
  Effect.acquireRelease(
    Effect.tryPromise(() => createPool({ max: 10 })),  // acquire
    (pool) => Effect.promise(() => pool.close())        // release on shutdown
  )
)
```

`ServiceMap.make` can't do this — it's just a map, no cleanup hooks. If your service needs a connection pool that must be closed, a cache that must be flushed, a background fiber that must be interrupted — that's what Layers are for.

### Layer memoization (new in v4)

Layers are automatically memoized across multiple `Effect.provide` calls:

```ts
// v3: "Building MyService" logged TWICE
// v4: "Building MyService" logged ONCE
const main = program.pipe(
  Effect.provide(MyServiceLayer),
  Effect.provide(MyServiceLayer)
)

// Opt out with local: true
Effect.provide(MyServiceLayer, { local: true })
// Or
Effect.provide(Layer.fresh(MyServiceLayer))
```

### When you don't need layers

On Cloudflare Workers, the platform manages resource lifecycle. D1 connections, KV bindings, R2 buckets — all provided fully constructed via `env` per request. No pools to close, no connections to release.

```ts
// No layers needed — env is already fully constructed
const services = ServiceMap.make(Database, { query: env.DB })
const run = Effect.runPromiseWith(services)
```

Layers add value when **you** own the lifecycle: connection pools, file handles, background workers, long-lived caches.

## `.use()` and `.useSync()`

### The problem

To call a method on a service in a generator, you need two steps:

```ts
const program = Effect.gen(function*() {
  const notifications = yield* Notifications   // step 1: get the service
  yield* notifications.notify("hello")          // step 2: call the method
})
```

### The solution

`.use()` collapses this into one expression:

```ts
const program = Notifications.use((n) => n.notify("hello"))
// Effect<void, never, Notifications>
```

### Implementation

```ts
// ServiceMap.ts:207-209
use(this: Service<never, any>, f: (service: any) => Effect<A, E, R>): Effect<A, E, R> {
  return withFiber((fiber) => f(get(fiber.services, this)))
}
```

Reads the service from the running fiber's ServiceMap, passes it to the callback. The callback returns an Effect. One allocation, one map lookup.

`useSync` is for when the callback returns a plain value (not an Effect):

```ts
// ServiceMap.ts:210-212
useSync(this: Service<never, any>, f: (service: any) => A): Effect<A, never, Identifier> {
  return withFiber((fiber) => exitSucceed(f(get(fiber.services, this))))
}
```

```ts
const port = Config.useSync((c) => c.port)
// Effect<number, never, Config>
```

### When to use which

| Pattern | When |
|---|---|
| `yield*` in generator | Multiple calls to same service, or you need the service ref for branching logic |
| `.use()` | One-shot effectful call, inline in a pipeline |
| `.useSync()` | One-shot pure/synchronous access (e.g. reading a config value) |

### The tradeoff

From the v4 migration guide:

> **Prefer `yield*` over `use` in most cases.** While `use` is a convenient one-liner, it makes it easy to accidentally leak service dependencies into return values. When you call `use`, the service is available inside the callback but the dependency is not visible at the call site.

With `yield*`, dependencies are explicit at each line. With `.use()`, the dependency is hidden inside the expression. In a large generator with many `.use()` calls on different services, it's harder to see at a glance what the effect depends on.

But for simple one-liners — especially in pipelines — `.use()` is cleaner.

## Cloudflare Workers: Recommended Pattern

```ts
import { Effect, ServiceMap } from "effect"

// Define services
const Env = ServiceMap.Service<{
  DB: D1Database
  KV: KVNamespace
  SECRET: string
}>("Env")

const Auth = ServiceMap.Service<{
  verify: (token: string) => Effect.Effect<User>
}>("Auth")

export default {
  async fetch(req: Request, env: CloudflareEnv) {
    // Build ServiceMap once from request env
    const services = ServiceMap.make(Env, { DB: env.DB, KV: env.KV, SECRET: env.SECRET })
      .pipe(ServiceMap.add(Auth, { verify: (token) => verifyToken(token, env.SECRET) }))

    // Create curried runner — reuse for multiple effects in the request
    const run = Effect.runPromiseWith(services)

    // Run effects — no Effect.provide, no Layer overhead
    const result = await run(handleRequest(req))
    return new Response(JSON.stringify(result))
  }
}
```

### Why this pattern fits CF Workers

- Workers get a fresh `env` per request — build ServiceMap from it
- No resource lifecycle to manage — platform owns bindings
- Curried runner lets you run multiple effects with same services
- No Layer memoization overhead, no Scope management
- ServiceMap is directly passed to the Fiber constructor — most direct path possible

### When to reach for Layers on CF

- **Durable Objects** — long-lived, may need resource cleanup between requests
- **Connection pools** or caches you manage yourself
- **Complex service graphs** where construction order and deduplication matter
- **Shared across multiple handlers** with `ManagedRuntime` scoped to the DO lifecycle

## Migration Quick Reference

| v3 | v4 |
|---|---|
| `Context.GenericTag<T>(id)` | `ServiceMap.Service<T>(id)` |
| `Context.Tag(id)<Self, Shape>()` | `ServiceMap.Service<Self, Shape>()(id)` |
| `Effect.Tag(id)<Self, Shape>()` | `ServiceMap.Service<Self, Shape>()(id)` |
| `Effect.Service<Self>()(id, opts)` | `ServiceMap.Service<Self>()(id, { make })` |
| `Context.Reference<Self>()(id, opts)` | `ServiceMap.Reference<T>(id, opts)` |
| `Context.make(tag, impl)` | `ServiceMap.make(tag, impl)` |
| `Context.get(ctx, tag)` | `ServiceMap.get(map, tag)` |
| `Context.add(ctx, tag, impl)` | `ServiceMap.add(map, tag, impl)` |
| `Context.mergeAll(...)` | `ServiceMap.mergeAll(...)` |
| `Runtime<R>` | Removed — `ServiceMap<R>` is what fibers carry |
| `FiberRef` | `ServiceMap.Reference` |
| `Effect.provide(layer) + runPromise` | `runPromiseWith(serviceMap)` (no layers needed) |
| `Tag.notify("hello")` (proxy accessor) | `Notifications.use((n) => n.notify("hello"))` |
