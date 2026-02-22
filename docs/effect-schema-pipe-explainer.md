# Effect Schema `pipe` and `pageSchema` Explainer

This doc explains the `pageSchema` in `src/routes/admin.customers.tsx:30`:

```ts
const pageSchema = Schema.Union([
  Schema.Int,
  Schema.NumberFromString.check(Schema.isInt()),
])
  .check(Schema.isGreaterThanOrEqualTo(1))
  .pipe(Schema.withDecodingDefaultKey(() => 1));
```

## What `pipe` means

`pipe` means: "take current schema value, pass it into a schema-transform function, get a new schema value."

Equivalent:

```ts
const s1 = Schema.NumberFromString;
const s2 = Schema.check(Schema.isInt())(s1);
```

Same as:

```ts
const s2 = s1.pipe(Schema.check(Schema.isInt()));
```

Recommended style in this codebase:

```ts
const s2 = s1.check(Schema.isInt());
```

Grounding:

- `Schema.check(...)` returns a function `(self) => self.check(...)` (`refs/effect4/packages/effect/src/Schema.ts:2582`)

## First piece only

Expression:

```ts
Schema.NumberFromString.check(Schema.isInt());
```

### Step flow

```text
input
  |
  v
[NumberFromString]
  expects string, decodes to number
  |
  v
[check(isInt)]
  requires decoded number to be integer
  |
  v
output number
```

Grounding:

- `NumberFromString` decodes string -> number (`refs/effect4/packages/effect/src/Schema.ts:7040`)
- `isInt` uses `Number.isSafeInteger` (`refs/effect4/packages/effect/src/Schema.ts:4351`)

Examples:

- `"2"` -> `2` success
- `"2.5"` -> fail (`isInt`)
- `"abc"` -> fail (`NumberFromString`)
- `2` -> fail (expects string on this branch)

## Why `pipe` here? Why not `schema.check(...)` directly?

This also works:

```ts
Schema.NumberFromString.check(Schema.isInt());
```

`pipe` is not required for correctness here.

Both are equivalent in result:

- method style: `schema.check(...)`
- function-composition style: `schema.pipe(Schema.check(...))`

Why use `pipe` anyway:

- consistent left-to-right composition when mixing method-style and function-style helpers
- same shape as other transforms like `Schema.withDecodingDefaultKey(...)` that are commonly used via `pipe`

## Should we prefer `pipe` here? (idiomatic guidance)

Short answer: not a strong rule. For `check`, both are idiomatic.

Evidence from Effect source/tests:

- method style is common:
  - `Int = Number.check(isInt())` (`refs/effect4/packages/effect/src/Schema.ts:7032`)
  - `NonEmptyString = String.check(isNonEmpty())` (`refs/effect4/packages/effect/src/Schema.ts:5243`)
- function+pipe style is also used:
  - `Schema.String.pipe(Schema.check(...))` examples in docs/tests (`refs/effect4/packages/effect/SCHEMA.md:7977`, `refs/effect4/packages/effect/test/schema/toArbitrary.test.ts:435`)

For some helpers, `pipe` is effectively required/expected:

- `decodeTo` docs explicitly say curried and "must use pipe" (`refs/effect4/packages/effect/src/Schema.ts:2846`)
- `withDecodingDefaultKey` is a curried function returning `(self) => ...` (`refs/effect4/packages/effect/src/Schema.ts:3059`)

Practical recommendation:

- use method style (`schema.check(...)`) for a quick single check
- use `pipe(...)` for curried transformers (`decodeTo`, `withDecodingDefaultKey`, etc.)
- keep style consistent within a local expression; consistency > rule purity

## Recommended approach for this codebase

Use method style for local checks, `pipe` for curried transformers.

Recommended rewrite of the first branch:

```ts
Schema.NumberFromString.check(Schema.isInt());
```

So full `pageSchema` can read as:

```ts
const pageSchema = Schema.Union([
  Schema.Int,
  Schema.NumberFromString.check(Schema.isInt()),
])
  .check(Schema.isGreaterThanOrEqualTo(1))
  .pipe(Schema.withDecodingDefaultKey(() => 1));
```

Why this is the best compromise:

- fewer cognitive jumps for readers new to `pipe`
- still uses `pipe` where it is naturally curried (`withDecodingDefaultKey`)
- aligns with common Effect method-style check usage (`refs/effect4/packages/effect/src/Schema.ts:7032`, `refs/effect4/packages/effect/src/Schema.ts:5243`)

## Now full `pageSchema`

```ts
const pageSchema = Schema.Union([
  Schema.Int,
  Schema.NumberFromString.check(Schema.isInt()),
])
  .check(Schema.isGreaterThanOrEqualTo(1))
  .pipe(Schema.withDecodingDefaultKey(() => 1));
```

### Expanded equivalent

```ts
const branchA = Schema.Int;
const branchB = Schema.NumberFromString.check(Schema.isInt());
const union = Schema.Union([branchA, branchB]);
const constrained = union.check(Schema.isGreaterThanOrEqualTo(1));
const pageSchema = constrained.pipe(Schema.withDecodingDefaultKey(() => 1));
```

### Diagram

```text
                     +--> [Int] ------------------+
input page value ----|                            |--> [check >= 1] --> page:number
                     +--> [NumberFromString->isInt] +

outer wrapper:
[withDecodingDefaultKey(() => 1)]
  if key missing in parent object -> page = 1
  else run inner page pipeline above
```

Grounding:

- `Union` "members are checked in order" (`refs/effect4/packages/effect/src/Schema.ts:2428`)
- `isGreaterThanOrEqualTo` is numeric min check (`refs/effect4/packages/effect/src/Schema.ts:4190`)
- `withDecodingDefaultKey` applies missing-key decode default (`refs/effect4/packages/effect/src/Schema.ts:3059`)
- Test confirms missing key defaults, `undefined` does not (`refs/effect4/packages/effect/test/schema/Schema.test.ts:6713`)

## Nest vs transform

`transform` here means "build a new schema from an existing schema."

- `check(...)` transforms schema by adding a constraint.
- `withDecodingDefaultKey(...)` transforms schema by adding missing-key default behavior.

`nest` means putting a schema as a field inside another schema.

Example nest:

```ts
const searchSchema = Schema.Struct({
  page: pageSchema,
  filter: Schema.optionalKey(Schema.Trim),
});
```

In this example:

- `pageSchema` itself is built by transforms (`pipe`, `check`)
- `searchSchema` nests `pageSchema` under key `page`

## Behavior table for `page` in `searchSchema`

Assume:

```ts
const searchSchema = Schema.Struct({
  page: pageSchema,
  filter: Schema.optionalKey(Schema.Trim),
});
```

Results:

- `{}` -> `{ page: 1 }`
- `{ page: 1 }` -> `{ page: 1 }`
- `{ page: "1" }` -> `{ page: 1 }`
- `{ page: "0" }` -> fail (`>= 1`)
- `{ page: "2.5" }` -> fail (`isInt`)
- `{ page: undefined }` -> fail (key exists; not treated as missing key)
