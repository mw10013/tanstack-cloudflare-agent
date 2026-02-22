# Shared Schema Pattern: TanStack Form + Server Fn

One Effect Schema used for both form validation and server fn input validation, with transforms that bridge the form shape (what the user types) and the server shape (what the handler receives).

## The problem

Forms collect data in UI-friendly shapes (comma-separated string for emails). Server handlers want structured data (array of strings). Without a shared schema, you end up with two schemas that duplicate field definitions and validation logic.

## The pattern

Define one schema with `decodeTo` transforms. The schema has two type faces:

- **Encoded** — the form shape (what the user types, what `defaultValues` looks like)
- **Type** — the server shape (what the handler receives after decoding)

```ts
const inviteSchema = Schema.Struct({
  organizationId: Schema.String,
  emails: Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String.check(Schema.isPattern(emailPattern)))
        .check(Schema.isMinLength(1))
        .check(Schema.isMaxLength(10)),
      SchemaTransformation.transform({
        decode: (value): readonly string[] => splitEmails(value),
        encode: (emails: readonly string[]) => emails.join(", "),
      }),
    ),
  ),
  role: Schema.Literals(Domain.AssignableMemberRoleValues),
});
```

Types:

| | `inviteSchema.Encoded` (form) | `inviteSchema.Type` (server) |
|---|---|---|
| emails | `string` | `readonly string[]` |
| organizationId | `string` | `string` |
| role | `"member" \| "admin"` | `"member" \| "admin"` |

Reference: `src/routes/app.$organizationId.invitations.tsx`

## How it plugs in

### Form

TanStack Form uses the schema for **validation only** — it discards the decoded output and gives `onSubmit` the raw form values (`Encoded` type).

Grounding: `refs/tan-form/docs/framework/react/guides/validation.md:461` — "Validation will not provide you with transformed values."

```ts
const form = useForm({
  defaultValues: {
    organizationId,
    emails: "",                              // ← Encoded shape (string)
    role: "member" as ...,
  },
  validators: {
    onSubmit: Schema.toStandardSchemaV1(inviteSchema),  // ← validation only
  },
  onSubmit: ({ value }) => {
    inviteMutation.mutate(value);            // ← value is Encoded, passed as-is
  },
});
```

### Server fn

TanStack Start's `inputValidator` runs the schema and **does use the decoded output**. The caller sends `Encoded`, the handler receives `Type`.

Grounding:
- Caller typed as `ResolveValidatorInput` (Encoded): `refs/tan-start/packages/start/src/client/createServerFn.ts`
- Handler typed as `ResolveValidatorOutput` (Type): same file, via `IntersectAllValidatorOutputs`
- `execValidator` returns `result.value` (decoded): `refs/tan-start/packages/start/src/client/createServerFn.ts`

```ts
const invite = createServerFn({ method: "POST" })
  .inputValidator(Schema.toStandardSchemaV1(inviteSchema))
  .handler(async ({ data: { emails } }) => {
    // emails is readonly string[] (Type) — already split and validated
    for (const email of emails) { ... }
  });
```

### Mutation type

Use `Encoded` for the mutation since it receives the raw form value:

```ts
const inviteMutation = useMutation({
  mutationFn: (data: typeof inviteSchema.Encoded) =>
    inviteServerFn({ data }),
});
```

## Data flow

```text
Form state (Encoded)          Server fn
─────────────────────         ──────────────────────────────
{ emails: "a@b.com, c@d.com" }
        │
        ▼
  [schema validates]  ← form uses schema, discards decoded output
  ✓ pass / ✗ show errors
        │
        ▼
  onSubmit({ value })
  value = { emails: "a@b.com, c@d.com" }   ← still Encoded
        │
        ▼
  inviteServerFn({ data: value })           ← sent to server
        │
        ▼
  [inputValidator decodes]  ← server uses schema, DOES use decoded output
        │
        ▼
  handler({ data })
  data = { emails: ["a@b.com", "c@d.com"] } ← now Type (decoded)
```

## How `decodeTo` works

`Schema.decodeTo(targetSchema, transformation)` — curried, used via `.pipe()`.

**Arguments:**
1. **targetSchema** — the decoded output schema. Checks on it run **after** the transform.
2. **transformation** — `{ decode, encode }` to convert between source and target.

**Decode flow** (what `inputValidator` does):

```text
raw input (From type)
  → [From schema validates]
  → [decode function] transforms From → To
  → [To schema checks validate transformed value]
  → decoded output (To type)
```

**Encode flow** (reverse):

```text
To value → [encode function] → From value
```

This is Effect Schema's equivalent of Zod's `.transform().refine()`:

| Zod | Effect Schema |
|-----|---------------|
| `.transform(fn).refine(check)` | `.pipe(Schema.decodeTo(target.check(...), transform))` |

The transform produces the value, the target schema's checks validate it. One pass, no double-calling the transform function.

## When to use this pattern

- Form field shape differs from what the server handler needs (string → array, string → number, etc.)
- You want one schema as single source of truth for both validation and type derivation
- The server fn is internal RPC (not a public API where you'd want a strict standalone contract)

## When NOT to use this pattern

- Form shape and server shape are identical (no transforms needed) — just use a plain schema with `.check()` filters, no `decodeTo`
- Public API with consumers who shouldn't know about form shapes — use a separate server-specific schema

## Grounding

- `decodeTo` signature: `refs/effect4/packages/effect/src/Schema.ts:2872`
- `SchemaTransformation.transform`: `refs/effect4/packages/effect/src/SchemaTransformation.ts:389`
- TanStack Form discards transforms: `refs/tan-form/docs/framework/react/guides/validation.md:461`
- TanStack Form `onSubmit` gets raw values: `refs/tan-form/packages/form-core/src/FormApi.ts:2145`
- TanStack Start `inputValidator` uses decoded output: `refs/tan-start/packages/start/src/client/createServerFn.ts`
- TanStack Start caller typed as input, handler typed as output: `refs/tan-start/packages/start/src/client/createServerFn.ts` via `ResolveValidatorInput` / `ResolveValidatorOutput`
