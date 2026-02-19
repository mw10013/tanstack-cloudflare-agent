# Effect Schema v4 Research for This Codebase

## TL;DR

Yes, Effect Schema v4 can replace most in-repo Zod usage in this app, including TanStack Router `validateSearch` and TanStack Start `inputValidator`.

Main constraints:

- `validateSearch` must stay synchronous.
- Effect schemas used via Standard Schema should avoid Effect service dependencies.
- TanStack docs show an older Effect API in one snippet (`standardSchemaV1`, `withDefaults`) while Effect v4 here uses `toStandardSchemaV1`, `withDecodingDefault*`, `withConstructorDefault`.

### Answer to Your Annotation: Is the API naming mismatch a show-stopper?

No. Not a show-stopper.

Why:

- TanStack consumes the Standard Schema contract (`~standard.validate`), not a specific Effect helper name.
- Effect v4 provides that contract via `Schema.toStandardSchemaV1(...)` (`refs/effect4/packages/effect/src/Schema.ts:535`).
- TanStack Router docs already state Effect/Schema works without an adapter (`refs/tan-start/docs/router/framework/react/guide/search-params.md:323`).

So the doc snippet using `standardSchemaV1/withDefaults` is version drift in examples, not an integration blocker.

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
- 13 route files
- 8 non-route files

Key integration points:

- Route `validateSearch` + server function input validation in same schema, e.g. `src/routes/admin.users.tsx:66`, `src/routes/admin.users.tsx:73`, `src/routes/admin.users.tsx:93`.
- Domain codecs and entity schemas, e.g. `src/lib/domain.ts:10`, `src/lib/domain.ts:19`.
- Repository DB parse layer, e.g. `src/lib/repository.ts:36`, `src/lib/repository.ts:90`.
- Worker/agent inbound event validation, e.g. `src/worker.ts:135`.

## Inventory: Zod Outside TanStack API Args

### A) Fully outside TanStack route/server-fn API arguments

These are strong spike candidates:

- `src/lib/google-client.ts:3` (`parse/safeParse` on Google API responses)
- `src/lib/google-oauth-client.ts:14` (`parse` token response)
- `src/lib/stripe-service.ts:28` (`safeParse` cached plans)
- `src/lib/domain.ts:10` (`z.codec`, domain schemas, enums)
- `src/lib/repository.ts:36` (DB boundary parse layer)
- `src/organization-agent.ts:23` (agent state/event/SQL parse boundaries)
- `src/organization-messages.ts:3` (shared discriminated union schema)
- `src/worker.ts:135` (queue message validation)

### B) Not passed directly as TanStack API arg, but used inside route implementation

Relevant to your note:

- `src/routes/app.$organizationId.upload.tsx:71` local `z.object(...).parse(...)` inside `inputValidator` function body
- `src/routes/app.$organizationId.workflow.tsx:79` `organizationMessageSchema.safeParse(...)` in `useAgent` message handler
- `src/routes/app.$organizationId.upload.tsx:181` `organizationMessageSchema.safeParse(...)` in `useAgent` message handler
- `src/routes/app.$organizationId.invitations.tsx:126` `z.email().safeParse(...)` in `refine(...)`

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

1. Spike on a non-TanStack-arg boundary first: `src/lib/google-client.ts` + `src/lib/google-oauth-client.ts`.
2. Migrate `organizationMessageSchema` and its two route consumers (`src/organization-messages.ts`, `src/routes/app.$organizationId.workflow.tsx:79`, `src/routes/app.$organizationId.upload.tsx:181`).
3. Migrate `validateSearch` schemas (5 files), keeping them strictly sync.
4. Migrate `createServerFn` input validators.
5. Migrate domain/repository parse boundary (`src/lib/domain.ts`, `src/lib/repository.ts`).
6. Keep hybrid mode while transitive dependencies still use Zod.

## Answer to Your Second Annotation

Yes, there are many Zod schemas used outside TanStack API arguments in this codebase.

Best first spike that avoids TanStack API-arg coupling:

1. `src/lib/google-client.ts`
2. `src/lib/google-oauth-client.ts`

These are pure parse/validation boundaries and should let us validate Effect Schema ergonomics with minimal routing/server-fn risk.

google is not a good spike because I would need to manually authenticate my google account to test. what are other candidates?

## Bottom Line

Effect Schema v4 is viable as a Zod replacement for this codebase’s own validation logic, including TanStack Start/Router integration, as long as we respect the sync requirement for `validateSearch` and avoid service-dependent schemas in runtime-only validation paths.
