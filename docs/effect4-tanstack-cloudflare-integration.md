# Effect 4 + TanStack Start + Cloudflare Workers Integration

How to integrate Effect 4's ServiceMap and `runPromiseWith` into a TanStack Start app running on Cloudflare Workers.

Two phases:
- **Phase B** (current target): Dual context — Effect ServiceMap alongside existing plain services in `requestContext`. Incremental adoption. New code uses Effect programs; existing code unchanged.
- **Phase C** (later target): Effect-first — all business logic as Effect programs. Server functions become thin adapters.

## Architecture Overview

```
Request
  → worker.ts fetch()
    → build services (createRepository, createAuthService, ...)
    → build ServiceMap from those services
    → build curried runner: Effect.runPromiseWith(serviceMap)
    → pass { run, ...plainServices } as requestContext to serverEntry.fetch()
      → TanStack Start routes & server functions
        → plain code: destructure context.repository, context.authService
        → Effect code: context.run(myEffectProgram)
```

The bridge between Effect and TanStack Start is `requestContext`. TanStack Start owns the request lifecycle — Effect lives inside it.

---

## Phase B: Dual Context

### 1. Define Effect Services

New file: `src/lib/effect-services.ts`

```ts
import type { AuthService } from "@/lib/auth-service"
import type { Repository } from "@/lib/repository"
import type { StripeService } from "@/lib/stripe-service"
import { ServiceMap } from "effect"

export const CfEnv = ServiceMap.Service<Env>("CfEnv")

export const Repo = ServiceMap.Service<Repository>("Repo")

export const Auth = ServiceMap.Service<AuthService>("Auth")

export const Stripe = ServiceMap.Service<StripeService>("Stripe")
```

These are typed keys into the ServiceMap. The `Shape` type param matches the existing service interfaces — no wrappers needed.

### 2. Build ServiceMap in Worker

`src/worker.ts` — after creating services, build a ServiceMap and curried runner:

```ts
import { Effect, ServiceMap } from "effect"
import { CfEnv, Repo, Auth, Stripe } from "@/lib/effect-services"

// ... existing service creation unchanged ...

const serviceMap = ServiceMap.make(CfEnv, env)
  .pipe(ServiceMap.add(Repo, repository))
  .pipe(ServiceMap.add(Auth, authService))
  .pipe(ServiceMap.add(Stripe, stripeService))

const run = Effect.runPromiseWith(serviceMap)
```

### 3. Extend ServerContext

```ts
export interface ServerContext {
  env: Env
  repository: Repository
  authService: AuthService
  stripeService: StripeService
  run: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
  session?: AuthService["$Infer"]["Session"]
  organization?: AuthService["$Infer"]["Organization"]
  organizations?: AuthService["$Infer"]["Organization"][]
}
```

The `run` function accepts `Effect<A, E, never>` — all service requirements must be satisfied. This is because the ServiceMap is already fully built in the worker. The type constraint ensures you can't accidentally pass an effect with unsatisfied dependencies to `run`.

### 4. Pass run Through Context

```ts
const response = await serverEntry.fetch(request, {
  context: {
    env,
    repository,
    authService,
    stripeService,
    run,
    session: session ?? undefined,
  },
})
```

### 5. Use in Server Functions

Existing server functions — **unchanged**:

```ts
const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(async ({ data, context: { authService, repository } }) => {
    // ... existing code, no Effect
  })
```

New or migrated server functions — use `run`:

```ts
import { Effect } from "effect"
import { Repo, Auth } from "@/lib/effect-services"

const getAppDashboard = Effect.gen(function*() {
  const repo = yield* Repo
  const auth = yield* Auth
  const request = getRequest()
  const session = yield* Effect.tryPromise(() =>
    auth.api.getSession({ headers: request.headers })
  )
  if (!session) return yield* Effect.fail(new Error("Missing session"))
  return yield* Effect.tryPromise(() =>
    repo.getAppDashboardData({
      userEmail: session.user.email,
      organizationId: "...",
    })
  )
})

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(({ data: { organizationId }, context: { run } }) =>
    run(getAppDashboardEffect(organizationId))
  )
```

### 6. Full worker.ts Diff

Only the `fetch` handler changes. `scheduled` and `queue` unchanged.

```ts
export default {
  async fetch(request, env, _ctx) {
    // ... rate limiting unchanged ...

    const d1SessionService = createD1SessionService({ d1: env.D1, request, ... })
    const repository = createRepository({ db: d1SessionService.getSession() })
    const stripeService = createStripeService()
    const authService = createAuthService({ ... })

    // NEW: build ServiceMap and runner
    const serviceMap = ServiceMap.make(CfEnv, env)
      .pipe(ServiceMap.add(Repo, repository))
      .pipe(ServiceMap.add(Auth, authService))
      .pipe(ServiceMap.add(Stripe, stripeService))
    const run = Effect.runPromiseWith(serviceMap)

    // ... routeAgentRequest unchanged ...

    const response = await serverEntry.fetch(request, {
      context: {
        env,
        repository,
        authService,
        stripeService,
        run,  // NEW
        session: session ?? undefined,
      },
    })
    d1SessionService.setSessionBookmarkCookie(response)
    return response
  },
  // scheduled, queue unchanged
} satisfies ExportedHandler<Env>
```

### 7. What This Enables

**Typed errors instead of thrown exceptions:**

```ts
class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  {}
) {}

class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { reason: Schema.String }
) {}

const requireSession = Effect.gen(function*() {
  const auth = yield* Auth
  const request = getRequest()
  const session = yield* Effect.tryPromise(() =>
    auth.api.getSession({ headers: request.headers })
  )
  if (!session) return yield* Effect.fail(new SessionNotFound())
  return session
})
```

**Composable programs:**

```ts
const getAppDashboard = (organizationId: string) =>
  Effect.gen(function*() {
    const repo = yield* Repo
    const { user } = yield* requireSession
    return yield* Effect.tryPromise(() =>
      repo.getAppDashboardData({ userEmail: user.email, organizationId })
    )
  })
```

**Testable via mock ServiceMap:**

```ts
const testServices = ServiceMap.make(Repo, mockRepository)
  .pipe(ServiceMap.add(Auth, mockAuth))
const testRun = Effect.runPromiseWith(testServices)

const result = await testRun(getAppDashboard("org-1"))
```

### 8. The `run` Typing Question

The `run` in ServerContext is typed `<A, E>(effect: Effect<A, E, never>) => Promise<A>`. This means:

- The effect must have **no unsatisfied service requirements** (`R = never`)
- Errors `E` are squashed into rejected promises (same as `Effect.runPromise`)
- Server functions that call `run(...)` get a `Promise<A>` — fits TanStack Start's async handler model

If the Effect has unresolved requirements, TypeScript catches it:

```ts
// This compiles — Repo and Auth are in the ServiceMap
run(getAppDashboard("org-1"))

// This fails — MissingService is not in the ServiceMap
run(Effect.gen(function*() { yield* SomeUnprovidedService }))
//  ^^^ Type error: Effect<..., ..., SomeUnprovidedService> not assignable to Effect<..., ..., never>
```

But wait — the ServiceMap **does** satisfy `Repo | Auth | Stripe | CfEnv`. So why require `never`?

Because `run` is created by `Effect.runPromiseWith(serviceMap)` which returns:

```ts
<A, E>(effect: Effect<A, E, CfEnv | Repo | Auth | Stripe>) => Promise<A>
```

So the actual type of `run` is more permissive than `Effect<A, E, never>`. The ServiceMap's type flows through. We need ServerContext to reflect this:

```ts
import type { CfEnv, Repo, Auth, Stripe } from "@/lib/effect-services"

type AppServices = typeof CfEnv | typeof Repo | typeof Auth | typeof Stripe

export interface ServerContext {
  // ...
  run: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Promise<A>
}
```

Or define a type alias in `effect-services.ts`:

```ts
export type AppServices =
  | typeof CfEnv.Identifier
  | typeof Repo.Identifier
  | typeof Auth.Identifier
  | typeof Stripe.Identifier
```

The exact identifier types depend on how `ServiceMap.Service` resolves — with the single-param form `ServiceMap.Service<Shape>(key)`, `Identifier = Shape`. So `typeof CfEnv.Identifier = Env`, `typeof Repo.Identifier = Repository`, etc.

### 9. Queue Handler — Natural Effect Candidate

The current queue handler (`worker.ts:142-248`) has complex branching: decode → validate → R2 head → metadata check → agent call → ack/retry. This is a natural Effect program:

```ts
const processR2Notification = (message: Message) =>
  Effect.gen(function*() {
    const env = yield* CfEnv
    const notification = yield* Schema.decodeUnknown(r2QueueMessageSchema)(message.body)

    if (!["PutObject", "DeleteObject", "LifecycleDeletion"].includes(notification.action)) {
      return
    }

    if (notification.action === "PutObject") {
      const head = yield* Effect.tryPromise(() => env.R2.head(notification.object.key))
      if (!head) return
      const { organizationId, name, idempotencyKey } = head.customMetadata ?? {}
      if (!organizationId || !name || !idempotencyKey) {
        return yield* Effect.fail(new MissingMetadata({ key: notification.object.key }))
      }
      const stub = yield* Effect.tryPromise(() =>
        getAgentByName(env.ORGANIZATION_AGENT, organizationId)
      )
      yield* Effect.tryPromise(() =>
        stub.onUpload({ name, eventTime: notification.eventTime, idempotencyKey, r2ObjectKey: notification.object.key })
      )
      return
    }

    // DeleteObject / LifecycleDeletion
    const slashIndex = notification.object.key.indexOf("/")
    const organizationId = slashIndex > 0 ? notification.object.key.slice(0, slashIndex) : ""
    const name = slashIndex > 0 ? notification.object.key.slice(slashIndex + 1) : ""
    if (!organizationId || !name) {
      return yield* Effect.fail(new InvalidDeleteKey({ key: notification.object.key }))
    }
    const stub = yield* Effect.tryPromise(() =>
      getAgentByName(env.ORGANIZATION_AGENT, organizationId)
    )
    yield* Effect.tryPromise(() =>
      stub.onDelete({ name, eventTime: notification.eventTime, action: notification.action, r2ObjectKey: notification.object.key })
    )
  })
```

The queue handler can use its own `runPromiseWith` since it only needs `CfEnv`:

```ts
async queue(batch, env) {
  const run = Effect.runPromiseWith(ServiceMap.make(CfEnv, env))
  for (const message of batch.messages) {
    const exit = await Effect.runPromiseExitWith(ServiceMap.make(CfEnv, env))(
      processR2Notification(message)
    )
    if (Exit.isSuccess(exit)) {
      message.ack()
    } else {
      console.error("queue processing failed", { cause: String(exit.cause) })
      message.retry()
    }
  }
}
```

### 10. What NOT to Migrate in Phase B

| Area | Why |
|---|---|
| `beforeLoad` route guards | Simple redirect logic. `if (!session) throw redirect(...)`. Effect adds nothing. |
| Auth middleware | `authAllowlistMiddleware` is a Set lookup + 404. Trivial. |
| `authService.handler(request)` | Better-auth library call. Not your logic. |
| Rate limiting | Single `env.MAGIC_LINK_RATE_LIMITER.limit()` call. |
| Route components | Client-side React. Effect is server-side. |

---

## Phase C: Effect-First (Future)

Phase B keeps dual context — plain services + `run`. Phase C removes the plain services from `requestContext` entirely. All server-side logic goes through Effect.

### 1. ServerContext Becomes Minimal

```ts
export interface ServerContext {
  run: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Promise<A>
}
```

No more `repository`, `authService`, `stripeService` on context. Server functions access them through Effect services exclusively.

### 2. Server Functions Become Thin Adapters

```ts
const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator(Schema.toStandardSchemaV1(organizationIdSchema))
  .handler(({ data: { organizationId }, context: { run } }) =>
    run(getAppDashboard(organizationId))
  )
```

Every handler is `({ data, context: { run } }) => run(someEffect(data))`. The handler is a bridge; logic lives in Effect programs.

### 3. Effect Programs Own Business Logic

```ts
// src/lib/programs/app-dashboard.ts
export const getAppDashboard = (organizationId: string) =>
  Effect.gen(function*() {
    const repo = yield* Repo
    const { user } = yield* requireSession
    return yield* Effect.tryPromise(() =>
      repo.getAppDashboardData({ userEmail: user.email, organizationId })
    )
  })
```

Programs are pure Effect — testable, composable, no TanStack coupling.

### 4. Service Definitions May Evolve

In Phase B, Effect services wrap existing imperative services:

```ts
const Repo = ServiceMap.Service<Repository>("Repo")
```

In Phase C, services could become more granular or Effect-native:

```ts
class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  { message: Schema.String, query: Schema.String }
) {}

const Repo = ServiceMap.Service<{
  getUser: (email: string) => Effect.Effect<Domain.User | null, DatabaseError>
  getAppDashboardData: (params: {...}) => Effect.Effect<DashboardData, DatabaseError>
}>("Repo")
```

Here repository methods return `Effect` instead of `Promise` — errors are typed, retry/timeout composable. But this is a larger refactor — each repository method needs rewriting.

### 5. What Changes from B to C

| Aspect | Phase B | Phase C |
|---|---|---|
| ServerContext | `{ run, env, repository, authService, stripeService, session }` | `{ run }` |
| Server function handlers | Mix of plain and Effect | All `run(effect)` |
| Existing server functions | Unchanged | Migrated to Effect |
| Service granularity | Wraps existing interfaces | Potentially Effect-native |
| Error handling | Mix of throw/Effect.fail | All typed Effect errors |

### 6. Migration Path B → C

1. Migrate server functions one at a time — replace `context.repository.foo()` with `run(fooEffect)`
2. Once no server function destructures a plain service from context, remove it from `ServerContext`
3. When all four plain services are removed, `ServerContext = { run }`
4. Optionally refactor service implementations to return `Effect` instead of `Promise`

---

## Open Questions

1. **Session in ServiceMap?** The current `session` is resolved per-request in the worker before being passed to context. Should it be a `Reference` with a default of `undefined`? Or resolved inside Effect programs via `requireSession`?

2. **D1SessionService lifecycle** — `d1SessionService.setSessionBookmarkCookie(response)` runs **after** `serverEntry.fetch()` returns. This is a post-response side effect. Effect's `Scope` or `acquireRelease` could manage this, but it's also fine as-is since there's no cleanup — just a cookie set.

3. **`getRequest()` inside Effect** — TanStack's `getRequest()` reads from AsyncLocalStorage. It works inside Effect's `withFiber` because the fiber runs on the same async context. But if Effect ever moves fibers across async boundaries (e.g., `Effect.fork`), `getRequest()` would lose context. For Phase B this is fine. Phase C might want a `Request` service.

4. **Error squashing** — `runPromiseWith` squashes `Cause<E>` into a thrown error via `causeSquash`. In server functions this means TanStack Start sees a thrown exception. Is this acceptable, or do you want to handle `Exit` explicitly in the server function adapter?
