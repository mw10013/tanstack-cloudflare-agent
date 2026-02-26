# Better Auth Upgrade Research

## Current Version

- `@better-auth/core`: `1.4.17`
- `@better-auth/stripe`: `1.4.17`
- `better-auth`: `1.4.17`

## Available Versions

### Stable

- **Latest stable:** `1.4.19`

### Beta

- **Latest beta:** `1.5.0-beta.19`

## Breaking Changes Analysis

### v1.4.5 - Array Serialization

When `supportsJSON: false`, array fields (`string[]`, `number[]`) are serialized as JSON strings before saving to the database.

**Impact on D1 adapter:**

- Your adapter has `supportsJSON: false` in config
- D1 natively supports JSON - consider setting `supportsJSON: true`
- May affect any `string[]` or `number[]` fields in schema

**Reference:** https://github.com/better-auth/better-auth/issues/6552

### v1.4.19 - Adapter Select Improvements

- "Improve `select` support"
- May affect how `select` clause is passed to custom adapter methods

### v1.5.0-beta.12 - Transaction Deadlock Fix

- Uses `getCurrentAdapter` for user lookup to avoid transaction deadlocks
- Internal adapter API may have changed

## D1 Adapter Analysis

Current config in `src/lib/d1-adapter.ts`:

```typescript
config: {
  adapterId: "d1-adapter",
  adapterName: "D1 Adapter",
  supportsNumericIds: false,
  supportsDates: false,
  supportsBooleans: false,
  disableIdGeneration: false,
  debugLogs: false,
}
```

### Areas to Review After Upgrade

| Area              | Current     | Recommendation                     |
| ----------------- | ----------- | ---------------------------------- |
| `supportsJSON`    | `false`     | Consider `true` for D1 native JSON |
| `select` handling | Basic       | Verify compatibility               |
| `Where` operators | Custom impl | Check for changes                  |

### Custom Where Operator Implementation

The adapter implements custom handling for:

- `eq`, `ne`, `lt`, `lte`, `gt`, `gte`
- `in`, `not_in`
- `contains`, `starts_with`, `ends_with`

This custom implementation handles:

- Model name capitalization (singular PascalCase)
- Date serialization to ISO strings
- Array handling for `in`/`not_in`

## Recommendation

1. **Immediate:** Upgrade to `1.4.19` (stable)
2. **Test thoroughly** for:
   - Array serialization issues
   - Select clause behavior
   - Where clause queries
3. **Future:** Monitor 1.5.0-beta releases for adapter API stability

## Links

- [Changelogs](https://www.better-auth.com/changelogs)
- [Create a Database Adapter](https://www.better-auth.com/docs/guides/create-a-db-adapter)
- [GitHub Releases](https://github.com/better-auth/better-auth/releases)
