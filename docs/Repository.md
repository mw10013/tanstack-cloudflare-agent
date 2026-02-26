# Repository.ts: Effect 4 Version Research

Research for creating `src/lib/Repository.ts` — an idiomatic Effect 4 Repository service, completely independent of `src/lib/repository.ts`. Both files coexist but share nothing except domain schemas.

## Current State

### Existing `repository.ts` (keep as-is, separate concern)

Factory function returning plain async methods. Uses `Schema.decodeUnknownSync` for validation:

```ts
// src/lib/repository.ts
export type Repository = ReturnType<typeof createRepository>;

export function createRepository({ db }: { db: D1Database | D1DatabaseSession }) {
  const getUser = async ({ email }: { email: Domain.User["email"] }) => {
    const result = await db.prepare(`select * from User where email = ?1`).bind(email).first();
    return Schema.decodeUnknownSync(Schema.NullOr(Domain.User))(result);
  };
  // ...9 methods total
  return { getUser, getUsers, getAppDashboardData, ... };
}
```

The new `Repository.ts` is **not** a drop-in replacement. It uses idiomatic Effect 4 patterns: `Option` instead of `null`, typed error channel, `Effect.fn`, `ServiceMap.Service` with inferred shape.

### Existing Effect Infrastructure

| File                         | What                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| `src/lib/D1.ts`              | `D1` service via `ServiceMap.Service`, wraps D1 with retry + `D1Error` |
| `src/lib/SchemaEx.ts`        | `DataFromResult` — schema for `{ data: string }` → parsed JSON         |
| `src/lib/effect-services.ts` | `CloudflareEnv`, `makeAppLayer`, `makeRunEffect`                       |
| `src/lib/domain.ts`          | All domain schemas (Effect 4 `Schema.Struct`, `Schema.decodeTo`, etc.) |

## Reference: cerr's Effect 3 Repository

From `refs/cerr/functions/cos/src/Repository.ts`:

```ts
// Effect 3
export class Repository extends Effect.Service<Repository>()("Repository", {
  accessors: true,
  dependencies: [D1.Default],
  effect: Effect.gen(function* () {
    const d1 = yield* D1;

    return {
      getCustomers: () =>
        pipe(
          d1.prepare(`select ...`),
          d1.first,
          Effect.flatMap(Effect.fromNullable),
          Effect.flatMap(
            Schema.decodeUnknown(DataFromResult(Schema.Array(Customer))),
          ),
        ),
      // ...
    };
  }),
}) {}
```

Pattern per method: `prepare → d1.first → fromNullable → decodeUnknown(schema)`

## Effect 3 → 4 Differences for Repository

| Aspect                     | Effect 3 (cerr)                             | Effect 4 (target)                                |
| -------------------------- | ------------------------------------------- | ------------------------------------------------ |
| Service declaration        | `Effect.Service<R>()('name', { ... })`      | `ServiceMap.Service<R>()("name", { make: ... })` |
| Shape typing               | Explicit in `effect:` return type           | Inferred from `make` return type                 |
| Layer attachment           | `dependencies: [D1.Default]` inside service | `static layer = Layer.effect(this, this.make)`   |
| Accessors                  | `accessors: true` auto-generates            | Not available; use `yield*`                      |
| Service construction       | Return plain object from `effect:`          | Return `Repository.of({ ... })`                  |
| Default layer              | `D1.Default`                                | `D1.layer` (convention: `layer` not `Default`)   |
| Error class                | `Data.TaggedError`                          | `Schema.TaggedErrorClass` preferred              |
| Nullable → absent          | `Effect.fromNullable`                       | `Option.fromNullOr` / `Effect.fromNullishOr`     |
| Schema decode              | `Schema.decodeUnknown(schema)`              | Same API, still available in v4                  |
| `Schema.parseJson`         | `Schema.parseJson(schema)`                  | `Schema.fromJsonString(schema)`                  |
| Functions returning Effect | `Effect.gen(function*() { ... })`           | `Effect.fn("name")(function*(...) { ... })`      |
| Schema transforms          | `Schema.transform(from, to, opts)`          | `from.pipe(Schema.decodeTo(to, transform))`      |

## ServiceMap.Service: `make` Pattern (Inferred Shape)

`ServiceMap.Service` has three overloads. The `make` pattern (overload 3) provides shape inference:

```ts
// Overload 3: only <Self> type param, shape inferred from make's return type
class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    return { prepare: ..., batch: ..., run: ..., first: ... }
  }),
}) {
  static layer = Layer.effect(this, this.make)
}
```

How it works:

- `ServiceMap.Service<Self>()` — one type param selects overload 3
- `make` is typed as `Make extends Effect<any, any, any>`
- Shape is extracted as `Make extends Effect<infer _A, ...> ? _A : never`
- `this.make` is the literal Effect passed in, stored as a static property
- `Effect.fn` return types are fully preserved in the inferred shape

This is the pattern used by `D1.ts` in the codebase and by `Rollup` in `refs/effect4/packages/tools/bundle/src/Rollup.ts`.

### Why inferred shape over explicit

- No duplication between interface and implementation
- `Effect.fn` types flow through naturally
- Follows established project convention (`D1.ts`)
- Less boilerplate

## Design: Effect 4 Repository.ts

### Service Declaration

```ts
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { D1 } from "./D1";
import * as Domain from "./domain";
import { DataFromResult } from "./SchemaEx";

export class Repository extends ServiceMap.Service<Repository>()("Repository", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;

    const getUser = Effect.fn("Repository.getUser")(/* ... */);
    const getUsers = Effect.fn("Repository.getUsers")(/* ... */);
    // ... all methods

    return Repository.of({
      getUser,
      getUsers,
      getAppDashboardData,
      getAdminDashboardData,
      getCustomers,
      getSubscriptions,
      getSessions,
      updateInvitationRole,
      deleteExpiredSessions,
    });
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

### Method Pattern (Simple — `select *`, nullable result → `Option`)

Old `repository.ts`:

```ts
const getUser = async ({ email }) => {
  const result = await db
    .prepare(`select * from User where email = ?1`)
    .bind(email)
    .first();
  return Schema.decodeUnknownSync(Schema.NullOr(Domain.User))(result);
};
```

Effect 4 — return `Option<Domain.User>`:

```ts
const getUser = Effect.fn("Repository.getUser")(function* ({
  email,
}: {
  email: Domain.User["email"];
}) {
  const result = yield* d1.first(
    d1.prepare(`select * from User where email = ?1`).bind(email),
  );
  return Option.fromNullOr(result).pipe(
    Option.map((row) => Schema.decodeUnknownSync(Domain.User)(row)),
  );
});
```

Or, keeping decode in the Effect channel (schema errors become defects):

```ts
const getUser = Effect.fn("Repository.getUser")(function* ({
  email,
}: {
  email: Domain.User["email"];
}) {
  const result = yield* d1.first(
    d1.prepare(`select * from User where email = ?1`).bind(email),
  );
  if (result == null) return Option.none();
  return Option.some(
    yield* Schema.decodeUnknown(Domain.User)(result).pipe(Effect.orDie),
  );
});
```

### Method Pattern (JSON aggregation — `{ data: string }` result)

Old `repository.ts`:

```ts
const getUsers = async ({ limit, offset, searchValue }) => {
  const searchPattern = searchValue ? `%${searchValue}%` : "%";
  const result = await db.prepare(`select json_object(...) as data`).bind(searchPattern, limit, offset).first();
  invariant(typeof result?.data === "string", "...");
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ ... })))(result.data);
};
```

Effect 4 using `DataFromResult`:

```ts
const getUsers = Effect.fn("Repository.getUsers")(function* ({
  limit,
  offset,
  searchValue,
}: {
  limit: number;
  offset: number;
  searchValue?: string;
}) {
  const searchPattern = searchValue ? `%${searchValue}%` : "%";
  const result = yield* d1.first(
    d1
      .prepare(`select json_object(...) as data`)
      .bind(searchPattern, limit, offset),
  );
  return yield* Schema.decodeUnknown(
    DataFromResult(
      Schema.Struct({
        users: Schema.Array(Domain.User),
        count: Schema.Number,
        limit: Schema.Number,
        offset: Schema.Number,
      }),
    ),
  )(result).pipe(Effect.orDie);
});
```

`DataFromResult` replaces `invariant` + manual `fromJsonString`. It validates `{ data: string }` shape → extracts `data` → parses JSON → validates against schema.

### Method Pattern (Simple write — no decode)

```ts
const updateInvitationRole = Effect.fn("Repository.updateInvitationRole")(
  function* ({ invitationId, role }: { invitationId: string; role: string }) {
    yield* d1.run(
      d1
        .prepare("update Invitation set role = ?1 where id = ?2")
        .bind(role, invitationId),
    );
  },
);
```

### Method Pattern (Write returning metadata)

```ts
const deleteExpiredSessions = Effect.fn("Repository.deleteExpiredSessions")(
  function* () {
    const result = yield* d1.run(
      d1.prepare("delete from Session where expiresAt < datetime('now')"),
    );
    return result.meta.changes;
  },
);
```

### Error Typing

**Schema decode failures → defects (via `Effect.orDie`).** A schema mismatch in the repository means the SQL query shape doesn't match the domain model — that's a programmer error, not a recoverable runtime condition.

**`D1Error` stays in the typed error channel.** Database failures (connection issues, constraint violations) are recoverable runtime errors consumers should handle.

The error channel is inferred from the `make` return type — no need to declare it. Methods using `d1.first`/`d1.run` naturally carry `D1Error`. Schema decode errors are converted to defects with `.pipe(Effect.orDie)`, keeping the error channel clean.

### Nullable Results → `Option`

Effect 4 idioms for nullable-to-Option:

| API                                                       | What                                                  |
| --------------------------------------------------------- | ----------------------------------------------------- |
| `Option.fromNullOr(value)`                                | `null` → `None`, everything else → `Some`             |
| `Option.fromNullishOr(value)`                             | `null \| undefined` → `None`                          |
| `Effect.fromNullishOr(value)`                             | `null \| undefined` → `Effect<A, NoSuchElementError>` |
| `Effect.fromNullishOr(v).pipe(Effect.catchNoSuchElement)` | → `Effect<Option<A>>`                                 |

**Use `Option.fromNullOr`** for D1 `.first()` results (returns `T | null`). This is a pure conversion, no Effect wrapping needed.

### Full Service Skeleton

```ts
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { D1 } from "./D1";
import * as Domain from "./domain";
import { DataFromResult } from "./SchemaEx";

export class Repository extends ServiceMap.Service<Repository>()("Repository", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;

    const getUser = Effect.fn("Repository.getUser")(function* ({
      email,
    }: {
      email: Domain.User["email"];
    }) {
      const result = yield* d1.first(
        d1.prepare(`select * from User where email = ?1`).bind(email),
      );
      if (result == null) return Option.none();
      return Option.some(
        yield* Schema.decodeUnknown(Domain.User)(result).pipe(Effect.orDie),
      );
    });

    const getUsers = Effect.fn("Repository.getUsers")(function* ({
      limit,
      offset,
      searchValue,
    }: {
      limit: number;
      offset: number;
      searchValue?: string;
    }) {
      const searchPattern = searchValue ? `%${searchValue}%` : "%";
      const result = yield* d1.first(
        d1
          .prepare(`select json_object(...) as data`)
          .bind(searchPattern, limit, offset),
      );
      return yield* Schema.decodeUnknown(
        DataFromResult(
          Schema.Struct({
            users: Schema.Array(Domain.User),
            count: Schema.Number,
            limit: Schema.Number,
            offset: Schema.Number,
          }),
        ),
      )(result).pipe(Effect.orDie);
    });

    // ... remaining methods follow same patterns

    const updateInvitationRole = Effect.fn("Repository.updateInvitationRole")(
      function* ({
        invitationId,
        role,
      }: {
        invitationId: string;
        role: string;
      }) {
        yield* d1.run(
          d1
            .prepare("update Invitation set role = ?1 where id = ?2")
            .bind(role, invitationId),
        );
      },
    );

    const deleteExpiredSessions = Effect.fn("Repository.deleteExpiredSessions")(
      function* () {
        const result = yield* d1.run(
          d1.prepare("delete from Session where expiresAt < datetime('now')"),
        );
        return result.meta.changes;
      },
    );

    return Repository.of({
      getUser,
      getUsers,
      getAppDashboardData,
      getAdminDashboardData,
      getCustomers,
      getSubscriptions,
      getSessions,
      updateInvitationRole,
      deleteExpiredSessions,
    });
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

### Layer Wiring

`Repository.layer` depends on `D1`. Wire into app layer in `effect-services.ts`:

```ts
const makeAppLayer = (env: Env) =>
  Layer.provideMerge(
    Layer.provideMerge(Repository.layer, D1.layer),
    Layer.succeedServices(
      ServiceMap.make(CloudflareEnv, env).pipe(
        ServiceMap.add(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(env),
        ),
      ),
    ),
  );
```

Or more cleanly:

```ts
const makeAppLayer = (env: Env) => {
  const envLayer = Layer.succeedServices(
    ServiceMap.make(CloudflareEnv, env).pipe(
      ServiceMap.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
  );
  return D1.layer.pipe(
    Layer.provideMerge(envLayer),
    Layer.provideMerge(Repository.layer),
  );
};
```

### Consumption

In server functions / route handlers:

```ts
const users = await runEffect(
  Effect.gen(function* () {
    const repo = yield* Repository;
    return yield* repo.getUsers({ limit: 10, offset: 0 });
  }),
);
```

## Key Decisions

### 1. `Effect.fn` vs closures returning `pipe`

cerr used `pipe(...)` chains. Effect 4 prefers `Effect.fn("name")(function*(...) { ... })` for:

- Better stack traces (automatic `withSpan`)
- Generator syntax is more readable for multi-step operations
- Named functions appear in traces

**Decision: Use `Effect.fn` for all methods.**

### 2. Inferred shape via `make` (not explicit `Shape` type parameter)

Two overloads of `ServiceMap.Service`:

- Explicit: `ServiceMap.Service<Self, Shape>()(id)` — shape declared as type parameter
- Inferred: `ServiceMap.Service<Self>()(id, { make: ... })` — shape inferred from `make` return

**Decision: Use `make` pattern (overload 3).** Follows `D1.ts` convention. No interface/implementation duplication. `Effect.fn` types flow through. `this.make` is auto-exposed for `Layer.effect(this, this.make)`.

### 3. Error channel typing

**Decision: `D1Error` in error channel, schema failures as defects via `Effect.orDie`.** Schema decode mismatches are programmer errors. Database failures are runtime errors consumers handle.

### 4. `Option` for nullable results

**Decision: Use `Option`.** This is idiomatic Effect 4. The new Repository is independent — not a drop-in replacement for `repository.ts`. Consumers using the Effect version should use Effect idioms.

Convert D1's `T | null` with `Option.fromNullOr(result)`.

### 5. Service identifier

**Decision: Use `"Repository"`.** Short, clear. Namespaced identifiers (`"tanstack-cloudflare-agent/Repository"`) are recommended for published libraries. For application-level services, bare names are fine.

### 6. SQL queries — fully independent

**Decision: Duplicate SQL.** The two files share domain schemas from `domain.ts` but nothing else. SQL strings are duplicated for independent evolution.

### 7. File naming

- Existing: `repository.ts` (lowercase, factory function)
- New: `Repository.ts` (PascalCase, Effect service class)

Follows the Effect convention and the existing `D1.ts` pattern.

## D1 Service Method Signatures

From `src/lib/D1.ts`:

```ts
export class D1 extends ServiceMap.Service<D1>()("D1", {
  make: Effect.gen(function* () {
    return {
      prepare: (query: string) => d1.prepare(query), // sync → D1PreparedStatement
      batch: <T>(statements: D1PreparedStatement[]) => tryD1(), // → Effect<D1Result<T>[], D1Error>
      run: <T>(statement: D1PreparedStatement) => tryD1(), // → Effect<D1Result<T>, D1Error>
      first: <T>(statement: D1PreparedStatement) => tryD1(), // → Effect<T | null, D1Error>
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
```

`d1.prepare()` and `.bind()` are synchronous. Only `d1.run`, `d1.first`, `d1.batch` return Effects. Pattern:

```ts
yield * d1.first(d1.prepare("select ...").bind(value1, value2));
//     ^Effect    ^sync                   ^sync
```

Note: `d1.first` returns `T | null`, so use `Option.fromNullOr` on the result for `Option` semantics.

## DataFromResult Schema

From `src/lib/SchemaEx.ts`:

```ts
export const DataFromResult = <A>(DataSchema: Schema.Schema<A>) =>
  Schema.Struct({ data: Schema.String }).pipe(
    pluck("data"),
    Schema.decodeTo(Schema.fromJsonString(DataSchema)),
  );
```

Usage: `Schema.decodeUnknown(DataFromResult(SomeStruct))(row)` where `row` is `{ data: "..." }`.

Replaces the `invariant` + manual `fromJsonString` pattern.

## Coexistence

| Aspect         | `repository.ts`            | `Repository.ts`                |
| -------------- | -------------------------- | ------------------------------ |
| Pattern        | Factory function           | `ServiceMap.Service`           |
| Methods return | `Promise<T>`               | `Effect<T, D1Error>`           |
| Nullable       | `T \| null`                | `Option<T>`                    |
| Schema errors  | Thrown (untyped)           | Defects (`Effect.orDie`)       |
| D1 access      | Raw `D1Database`           | `D1` Effect service            |
| Consumption    | `await repo.method()`      | `yield* repo.method()`         |
| Wiring         | `createRepository({ db })` | `yield* Repository` from layer |

Both import from `domain.ts`. Both have their own SQL. They are completely independent.
