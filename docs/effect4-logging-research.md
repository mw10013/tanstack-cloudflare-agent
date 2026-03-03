# Effect 4 Logging & Console Research

## Two Systems: Effect Logger vs Console

Effect 4 has **two distinct** logging mechanisms:

1. **`Effect.log*` + `Logger`** — structured, leveled, composable logging integrated into the Effect runtime
2. **`Console`** — effectful wrappers around `console.*` methods (log, error, warn, table, group, time, etc.)

They serve different purposes and can be used together.

---

## 1. Effect Logger System

### Log Functions

All return `Effect<void>`. Accept variadic `...message: ReadonlyArray<any>`.

```ts
Effect.log(...)        // default level (Info)
Effect.logDebug(...)
Effect.logInfo(...)
Effect.logWarning(...)
Effect.logError(...)
Effect.logFatal(...)
Effect.logTrace(...)
```

Source: `refs/effect4/packages/effect/src/Effect.ts` L12908-13118

### Structured Metadata

```ts
// Attach key-value annotations to all logs within an effect
Effect.annotateLogs({ service: "checkout-api", route: "POST /checkout" })

// Add duration span — each log line includes label=<N>ms
Effect.withLogSpan("checkout")

// Scoped variant — applies to entire Scope, not just one effect
Effect.annotateLogsScoped({ requestId: "req-123" })
```

Does annotateLogs impact nested effects or is that what annotateLogsScoped is for? Need examples with output.

### Logger Formats (Built-in)

| Logger | Output | Use Case |
|---|---|---|
| `Logger.defaultLogger` | Simple text | Default runtime logger |
| `Logger.formatSimple` | `timestamp=... level=... message=...` | Plain text |
| `Logger.formatLogFmt` | logfmt style | Log aggregation (Splunk, ELK) |
| `Logger.formatStructured` | JS object with message, level, timestamp, annotations, spans, fiberId | Programmatic processing |
| `Logger.formatJson` | Single-line JSON | Production, containers, K8s |
| `Logger.consolePretty()` | `[09:37:17.579] INFO (#1) label=0ms: hello` | Dev, human-readable |
| `Logger.consoleJson` | JSON to console | Production stdout |
| `Logger.consoleLogFmt` | logfmt to console | Production stdout |
| `Logger.consoleStructured` | Structured object to console | Dev debugging |
| `Logger.tracerLogger` | Logs as tracer span events | Distributed tracing |


Need a view on which formats would be good for cloudflare production and why.
Not understanding the distinction between format vs console vs tracer

Source: `refs/effect4/packages/effect/src/Logger.ts`

### Configuring Loggers via Layer

```ts
// Replace all loggers
const JsonLoggerLayer = Logger.layer([Logger.consoleJson])

// Merge with existing loggers
const AdditionalLoggerLive = Logger.layer([Logger.consoleJson], { mergeWithExisting: true })

// Multiple loggers simultaneously
const MultiLoggerLive = Logger.layer([Logger.consoleJson, Logger.consolePretty()])
```

What do merge and multiple even mean?

### Log Level Filtering

```ts
import { Layer, References } from "effect"

// Skip debug/info — only warn and above
const WarnAndAbove = Layer.succeed(References.MinimumLogLevel, "Warn")
```

Hierarchy: All > Fatal > Error > Warn > Info > Debug > Trace > None

### Custom Logger

```ts
const customLogger = Logger.make((options) => {
  // options: { message, logLevel, cause, fiber, date }
  console.log(`[${options.logLevel}] ${options.message}`)
})
```

### Batched Logger

```ts
const batchedLogger = Logger.batched(Logger.formatStructured, {
  window: "1 second",
  flush: Effect.fn(function*(batch) {
    // send batch to external service
  })
})
```

### Environment-Conditional Logger

```ts
const LoggerLayer = Layer.unwrap(Effect.gen(function*() {
  const env = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"))
  return env === "production"
    ? Logger.layer([Logger.consoleJson])
    : Logger.layer([Logger.consolePretty()])
}))
```

Why is unwrap needed? Is it because it takes an effect that returns a Layer and need to take the layer out of the effect? Explain the concept of unwrap in functional programming context.

Source: `refs/effect4/ai-docs/src/08_observability/10_logging.ts`

### Full Example: Annotated Logging

```ts
const logCheckoutFlow = Effect.gen(function*() {
  yield* Effect.logDebug("loading checkout state")
  yield* Effect.logInfo("validating cart")
  yield* Effect.logWarning("inventory is low for one line item")
  yield* Effect.logError("payment provider timeout")
}).pipe(
  Effect.annotateLogs({ service: "checkout-api", route: "POST /checkout" }),
  Effect.withLogSpan("checkout")
)
```

### Effect.fn Integration

`Effect.fn("name")` auto-attaches a tracing span. Combined with `Effect.annotateLogs`:

```ts
const effectFunction = Effect.fn("effectFunction")(
  function*(n: number): Effect.fn.Return<string, SomeError> {
    yield* Effect.logInfo("Received number:", n)
    return yield* new SomeError({ message: "Failed" })
  },
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.annotateLogs({ method: "effectFunction" })
)
```

What is a tracing span? How does it combine with annotateLogs and affect output?

---

## 2. Console Module

Effectful wrappers around native `console.*`. Service-based — can be swapped/mocked.

```ts
import { Console, Effect } from "effect"

const program = Effect.gen(function*() {
  yield* Console.log("Hello, World!")
  yield* Console.error("Something went wrong")
  yield* Console.warn("This is a warning")
  yield* Console.table(users)
  yield* Console.dir(obj, { depth: 2 })
  yield* Console.assert(condition, "assertion message")
})
```

When would you use Console instead of logging?

### Console.withGroup — Scoped Grouping

```ts
Console.withGroup(
  Effect.gen(function*() {
    yield* Console.log("Step 1: Initialize")
    yield* Console.log("Step 2: Process")
  }),
  { label: "Processing Steps", collapsed: false }
)
```

How does this impact output?

### Console.withTime — Scoped Timing

```ts
Console.withTime(
  Effect.gen(function*() {
    yield* Effect.sleep("1 second")
    yield* Console.log("Operation completed")
  }),
  "my-operation"
)
```

### Console Reference (Swappable)

`Console.Console` is a `ServiceMap.Reference<Console>` — can be replaced per environment:

```ts
const program = Console.consoleWith((console) =>
  Effect.sync(() => {
    console.log("Hello from current console!")
  })
)
```

Source: `refs/effect4/packages/effect/src/Console.ts`

---

## Application to Auth.ts

### Current State

Auth.ts uses raw `console.log` in 20+ places — all inside callbacks (database hooks, plugin callbacks, middleware). None are structured. No log levels. No annotations. No way to filter or redirect.

### Opportunities

#### 1. Replace `console.log` with `Effect.log*` in Effect Generators

**Before:**
```ts
yield* Effect.sync(() => {
  console.log(`better-auth: hooks: before: ${ctx.path}`);
});
```

**After:**
```ts
yield* Effect.logInfo(`hooks: before: ${ctx.path}`)
```

Applies to: hooks.before middleware (L119-121), databaseHookUserCreateAfter (L94, L306+), databaseHookSessionCreateBefore (L104).

#### 2. Add `Effect.annotateLogs` for Context

Annotate all auth-related logs so they're filterable:

```ts
Effect.annotateLogs({ service: "better-auth" })
```

Per-operation annotations:
```ts
Effect.annotateLogs({ hook: "user.create.after", userId: user.id })
```

#### 3. Use Log Levels Appropriately

| Current | Suggested | Where |
|---|---|---|
| `console.log("databaseHooks.user.create.after", ...)` | `Effect.logDebug(...)` | Default hook fallbacks |
| `console.log("sendMagicLink", ...)` | `Effect.logInfo(...)` | Magic link sending |
| `console.log("Email would be sent to:", ...)` | `Effect.logInfo(...)` | Email simulation |
| `console.log("stripe plugin: ...", ...)` | `Effect.logInfo(...)` or `Effect.logDebug(...)` | Stripe callbacks |

#### 4. Use `Effect.withLogSpan` for Timing

```ts
// Track auth handler duration
Effect.withLogSpan("auth.handler")

// Track session creation timing
Effect.withLogSpan("auth.session.create")
```

#### 5. Non-Effect Callbacks (Stripe Plugin, Magic Link)

Many callbacks in `createBetterAuthOptions` are plain `Promise`-returning functions, not Effect. Two approaches:

**A. Use `runEffect` to bridge** — callbacks already have access to `runEffect`:
```ts
sendMagicLink: async (data) =>
  runEffect(
    Effect.gen(function*() {
      yield* Effect.logInfo("sendMagicLink", { email: data.email, url: data.url })
      await kv.put("demo:magicLink", data.url, { expirationTtl: 60 })
    }).pipe(Effect.annotateLogs({ service: "better-auth", hook: "sendMagicLink" }))
  ),
```

NO FUCKING await in an effect.

**B. Keep `console.log` in simple fire-and-forget callbacks** where bridging adds too much ceremony (e.g., `onSubscriptionComplete`, `onEvent`). These could use the `Console` module if inside Effect context.

#### 6. Configure Logger Layer in Service Construction

The `Auth` service's `make` could provide a logger layer with auth-specific annotations:

```ts
// In Auth.make, wrap the construction with annotations
Effect.annotateLogs({ service: "auth" })
```

Or configure a JSON logger for production:
```ts
const AuthLoggerLayer = Logger.layer([Logger.consoleJson])
```

### Summary: What Changes

| Pattern | Before | After |
|---|---|---|
| Debug output in hooks | `console.log(...)` | `yield* Effect.logDebug(...)` |
| Important events | `console.log(...)` | `yield* Effect.logInfo(...)` |
| Errors in auth | implicit | `yield* Effect.logError(...)` |
| Context | none | `Effect.annotateLogs({ service: "auth", ... })` |
| Timing | none | `Effect.withLogSpan("auth.handler")` |
| Filtering | impossible | `Layer.succeed(References.MinimumLogLevel, "Warn")` |
| Format control | none | `Logger.layer([Logger.consoleJson])` for prod |

### Key Constraint

Many better-auth plugin callbacks are plain functions returning `Promise<void>`, not Effect. To use Effect logging in these, you must bridge via `runEffect(Effect.logInfo(...))`. For simple one-liner logs, the ceremony may not be worth it. Prioritize converting the callbacks that already use `runEffect` (like `authorizeReference`, `plans`, hooks.before).

We would want to convert these over to effect.
