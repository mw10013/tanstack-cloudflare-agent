# Effect Schema v4 Research for This Codebase

## TL;DR

Yes, Effect Schema v4 can replace most in-repo Zod usage in this app, including TanStack Router `validateSearch` and TanStack Start `inputValidator`.

Main constraints:

- `validateSearch` must stay synchronous.
- Effect schemas used via Standard Schema should avoid Effect service dependencies.
- TanStack docs show an older Effect API in one snippet (`standardSchemaV1`, `withDefaults`) while Effect v4 here uses `toStandardSchemaV1`, `withDecodingDefault*`, `withConstructorDefault`.

Is this a show-stopper? Does this mean Effect v4 schemas cannot work with TanStack?

## Grounded Evidence

### 1) TanStack accepts Standard Schema validators

From `refs/tan-start/packages/router-core/src/validators.ts:62`:

```ts
export type Validator<TInput, TOutput> =
  | ValidatorObj<TInput, TOutput>
  | ValidatorFn<TInput, TOutput>
  | ValidatorAdapter<TInput, TOutput>
  | StandardSchemaValidator<TInput, TOutput>
  | undefined
```

From `refs/tan-start/packages/router-core/src/validators.ts:8`:

```ts
export interface StandardSchemaValidator<TInput, TOutput> {
  readonly '~standard': StandardSchemaValidatorProps<TInput, TOutput>
}
```

### 2) Router `validateSearch` rejects async validation

From `refs/tan-start/packages/router-core/src/router.ts:2832`:

```ts
if ('~standard' in validateSearch) {
  const result = validateSearch['~standard'].validate(input)

  if (result instanceof Promise)
    throw new SearchParamError('Async validation not supported')
```

Implication: Effect Schema for `validateSearch` must be sync.

### 3) `createServerFn().inputValidator(...)` supports async Standard Schema

From `refs/tan-start/packages/start-client-core/src/createServerFn.ts:749`:

```ts
if ('~standard' in validator) {
  const result = await validator['~standard'].validate(input)
```

And type tests explicitly cover sync + async standard validators:

- `refs/tan-start/packages/start-client-core/src/tests/createServerFn.test-d.ts:159`
- `refs/tan-start/packages/start-client-core/src/tests/createServerFn.test-d.ts:207`

### 4) Effect Schema v4 provides Standard Schema bridge

From `refs/effect4/packages/effect/src/Schema.ts:535`:

```ts
export function toStandardSchemaV1<
  S extends Top & { readonly DecodingServices: never }
>(self: S, ...)
```

Also this validate can return sync or Promise (`refs/effect4/packages/effect/src/Schema.ts:551`), which matches TanStack server-fn validator behavior, but not Router `validateSearch`.

### 5) Effect decode APIs work outside an Effect runtime

From `refs/effect4/packages/effect/src/Schema.ts:776`:

```ts
export const decodeUnknownSync = Parser.decodeUnknownSync
```

And typed sync/exit/promise decode variants require `DecodingServices: never` (ex: `decodeUnknownExit` at `refs/effect4/packages/effect/src/Schema.ts:733`).

### 6) Effect docs include non-Effect integration via Standard Schema

`refs/effect4/packages/effect/SCHEMA.md:6223` shows TanStack Form integration:

```ts
onChangeAsync: Schema.toStandardSchemaV1(schema),
```

### 7) One TanStack doc snippet is on older Effect API surface

`refs/tan-start/docs/router/framework/react/guide/search-params.md:329` uses:

```ts
S.standardSchemaV1(...)
S.withDefaults(...)
```

But Effect v4 source here exports `toStandardSchemaV1` and `withDecodingDefault*`/`withConstructorDefault`:

- `refs/effect4/packages/effect/src/Schema.ts:535`
- `refs/effect4/packages/effect/src/Schema.ts:3023`
- `refs/effect4/packages/effect/src/Schema.ts:3059`
- `refs/effect4/packages/effect/src/Schema.ts:3086`

## Current Codebase Impact

Project currently has both deps:

- `effect` at `package.json:89`
- `zod` at `package.json:114`

Zod imported in 21 `src/` files (`rg -l "from \"zod\"" src`).

Key integration points:

- Route `validateSearch` + server function input validation in same schema, e.g. `src/routes/admin.users.tsx:66`, `src/routes/admin.users.tsx:73`, `src/routes/admin.users.tsx:93`.
- Domain codecs and entity schemas, e.g. `src/lib/domain.ts:10`, `src/lib/domain.ts:19`.
- Repository DB parse layer, e.g. `src/lib/repository.ts:36`, `src/lib/repository.ts:90`.
- Worker/agent inbound event validation, e.g. `src/worker.ts:135`.

## Can We Replace Zod Here?

### Yes, for app-owned validation layers

- `validateSearch`: yes, with sync Effect Standard Schema values.
- `inputValidator`: yes, using `Schema.toStandardSchemaV1(schema)` (sync or async supported by Start server fn path).
- DB/JSON parsing: yes, with `Schema.decodeUnknownSync`, `decodeUnknownExit`, or `toStandardSchemaV1`.
- Queue/event payload validation: yes.

### Not a full “remove zod from lockfile” path immediately

Many dependencies still bring or expect Zod transitively (`pnpm-lock.yaml` has many `zod` consumers). So near-term goal is replacing direct app usage, not ecosystem-wide elimination.

## Feature Mapping for Existing Patterns

- `z.object(...)` -> `Schema.Struct(...)`
- `schema.parse(...)` -> `Schema.decodeUnknownSync(schema)(...)`
- `schema.safeParse(...)` -> `Schema.decodeUnknownExit(schema)(...)` or `Schema.toStandardSchemaV1(schema)["~standard"].validate(...)`
- `z.codec(...)` -> `decodeTo`/`encodeTo` transformations
  - Relevant existing code: `src/lib/domain.ts:10`, `src/lib/domain.ts:19`
- `z.coerce.number().int().min(1).default(1)` -> string/unknown decode transform + numeric checks + decoding defaults
- `z.file()` -> `Schema.File` exists (`refs/effect4/packages/effect/src/Schema.ts:6699`)
- `.loose()` behavior -> parse option `onExcessProperty: "preserve"` (`refs/effect4/packages/effect/src/SchemaAST.ts:381`)

## Migration Risks

- Async validator accidentally used in `validateSearch` will throw `Async validation not supported` (`refs/tan-start/packages/router-core/src/router.ts:2835`).
- Effect schemas that require services are not good candidates for plain “outside effect runtime” validation; tests show missing-service errors (`refs/effect4/packages/effect/test/schema/toStandardSchemaV1.test.ts:153`).
- Defaulting/coercion semantics need deliberate parity tests for search params and form inputs.
- Error shapes differ (Zod issues vs Standard Schema issues).

## Recommended Incremental Plan

1. Migrate `validateSearch` schemas first (small, high leverage, 5 route files).
2. Migrate `createServerFn` input validators next, keeping them service-free and mostly sync.
3. Migrate domain/repository parse boundary (`src/lib/domain.ts`, `src/lib/repository.ts`).
4. Migrate worker/agent payload schemas (`src/worker.ts`, `src/organization-agent.ts`, `src/organization-messages.ts`).
5. Keep hybrid mode while transitive dependencies still use Zod.

## Bottom Line

Effect Schema v4 is viable as a Zod replacement for this codebase’s own validation logic, including TanStack Start/Router integration, as long as we respect the sync requirement for `validateSearch` and avoid service-dependent schemas in runtime-only validation paths.

Are there any zod schemas that are used outside of tanstack apis in the codebase. What I mean by this is that a zod schema is not passed into a TanStack api. However, if within the implementation of a TanStack handler or some such and a zod schema is used, but not passed in, that is a relevant case. Trying to figure out how to spike this and my thinking is that we should try it on code that doesn't get caught up in TanStack api args.
