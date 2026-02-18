# Google OAuth + Google APIs on Cloudflare Workers (Research)

Updated: 2026-02-18

## Goal

Find the best TypeScript approach for Google OAuth + Drive/Sheets on Cloudflare Workers/edge runtime, with less boilerplate than raw `fetch` while staying runtime-compatible.

## Current codebase reality (grounding)

Current implementation uses manual OAuth + raw Google API calls.

```ts
// src/routes/api/google/callback.tsx
const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body,
});
```

`src/routes/api/google/callback.tsx:61`

```ts
// src/organization-agent.ts
const url = new URL("https://www.googleapis.com/drive/v3/files");
const res = await fetch(url, {
  headers: { authorization: `Bearer ${accessToken}` },
});
```

`src/organization-agent.ts:620`

```ts
// src/organization-agent.ts
const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.defaultSpreadsheetId}/values/${encodeURIComponent(resolvedRange)}`;
const res = await fetch(endpoint, {
  headers: { authorization: `Bearer ${accessToken}` },
});
```

`src/organization-agent.ts:672`

This validates your concern: more manual request/response handling and schema sync burden.

## What is the official TS/JS Google SDK story?

### 1) `googleapis` / `@googleapis/*` is Node-focused

Evidence:

- `google-api-nodejs-client` README: "Google APIs Node.js Client".
- `googleapis` package metadata: description says it is the Google APIs client library for Node.js.
- `google-auth-library` package metadata: description says OAuth2 client for "Node.js".

Conclusion:

- First-party maintained server SDK path is Node-centric.
- Not documented as Workers/edge-native.

### 2) `gapi` is browser-focused, not Worker server runtime

Evidence:

- Google API JavaScript client docs list supported environments as browser contexts and explicitly "not Node.js".

Conclusion:

- `gapi` is not a server-side Workers replacement for `googleapis`.

## Does official Google SDK support Cloudflare Workers edge runtime?

No official source found that states first-party Google server SDKs are Cloudflare Workers-supported.

Cloudflare runtime docs state Workers implements a subset of Node APIs and some behavior differs from Node. So Node-targeted libs can fail at runtime even if imports compile.

Practical read:

- `googleapis` on Workers = possible in some paths with `nodejs_compat`, not a documented/safe default.
- Raw `fetch` or edge-native OAuth/JWT libs remains the reliable baseline.

## Cloudflare Agents OAuth in `refs/agents` (what it is)

Your hunch is correct: the built-in OAuth references are MCP-centric.

Docs excerpts:

- `refs/agents/docs/securing-mcp-servers.md:3` says MCP auth uses OAuth 2.1 between MCP clients and servers.
- `refs/agents/docs/securing-mcp-servers.md:5` describes `workers-oauth-provider` for securing MCP server routes.
- `refs/agents/docs/securing-mcp-servers.md:31` describes MCP proxying to third-party OAuth providers like Google/GitHub.

Code excerpts:

- `refs/agents/packages/agents/src/index.ts:686` initializes `MCPClientManager`.
- `refs/agents/packages/agents/src/index.ts:753` calls `handleMcpOAuthCallback`.
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:1` imports MCP OAuth interfaces from `@modelcontextprotocol/sdk/...`.
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:20` defines `AgentMcpOAuthProvider`.

Conclusion:

- Reusable patterns: state, PKCE, token persistence, callback safety.
- Not an out-of-box generic Google app integration SDK.

## Edge-compatible TS libraries that help

### `oauth4webapi`

Why relevant:

- Explicitly documents Cloudflare Workers support.
- Pure Web API style (`fetch`, `URL`, `crypto.subtle`) aligns with Workers runtime.
- Covers OAuth/OIDC primitives needed for Google Authorization Code + PKCE + refresh.

How it helps here:

- Replace manual code/token exchange plumbing with standards-based helpers.
- Keep your own storage model in Durable Object SQLite.
- Keep API calls as `fetch` for full runtime compatibility.

Useful API building blocks (map to your current flow):

- `generateRandomCodeVerifier` + `calculatePKCECodeChallenge`
- `validateAuthResponse` for callback validation
- `authorizationCodeGrantRequest` for code -> token exchange
- `refreshTokenGrantRequest` for token refresh
- OIDC helpers for discovery and response processing when needed

### `jose`

Why relevant:

- Explicitly documents support for Cloudflare Workers and other web-interoperable runtimes.
- Strong JWT/JWS/JWK/JWKS support.

How it helps here:

- Verify Google `id_token` signatures/claims safely.
- Implement service-account JWT bearer flow (sign assertion, exchange for access token).
- Handle key import/export and algorithm-safe signing without Node-only crypto dependencies.

Useful API building blocks:

- `createRemoteJWKSet` + `jwtVerify` for Google `id_token` verification via JWKS
- `SignJWT` for service-account JWT assertions
- `importPKCS8` / key import helpers for secret-managed private keys

### `openid-client` (optional alternative)

Why relevant:

- Current docs state support for edge runtimes including Cloudflare Workers.

How it helps here:

- Higher-level OAuth/OIDC client wrapper than `oauth4webapi`.
- Tradeoff: more abstraction/magic; less minimal than `oauth4webapi`.

### `@cloudflare/workers-oauth-provider`

Why relevant:

- Worker-native OAuth provider.

Scope caveat:

- Best fit when your Worker is acting as an OAuth authorization server/provider (not primarily as a Google OAuth client for app features).
- Still useful reference for consent/state/CSRF hardening patterns.

## Recommended architecture options

### Option A (recommended for user-connected Drive/Sheets): auth code + PKCE + `oauth4webapi`

Shape:

1. Keep `beginGoogleOAuth` + `consumeGoogleOAuthState` in DO SQLite.
2. Use `oauth4webapi` for authorization request and token exchange/refresh logic.
3. Keep Drive/Sheets calls as typed `fetch` wrappers.
4. Keep Zod response validation for runtime safety.

Why:

- Edge-native.
- Minimal lock-in.
- Less manual OAuth boilerplate than current hand-rolled flow.

### Option B (workspace automation): service account + `jose`

Shape:

1. Build JWT assertion with `jose`.
2. Exchange assertion at `oauth2.googleapis.com/token`.
3. Call Drive/Sheets with resulting access token.

Why:

- Good for non-user delegated automation.
- Avoids per-user refresh token lifecycle.

### Option C: Node SDK (`googleapis`) under `nodejs_compat`

Status:

- Possible experiment path only.
- Higher risk for runtime breakage and bundle/compat complexity.

Recommendation:

- Not default for production Worker edge path.

## Reducing Google API boilerplate while staying edge-native

Pragmatic approach:

1. Keep runtime transport as `fetch`.
2. Introduce generated types/request builders from Google Discovery docs.
3. Keep tiny shared request core: auth header, retries, pagination, error normalization.

Why Discovery docs matter:

- Google explicitly documents Discovery as the machine-readable API description to build client libraries.
- This gives a path to typed generation without adopting Node-only runtime dependencies.

## Suggested next implementation spike

1. Add `oauth4webapi` and move only token exchange/refresh flow first.
2. Add `jose` only for `id_token` verification (small, high-value hardening).
3. Add typed wrappers for current endpoints first:
   - Drive `files.list`
   - Sheets `spreadsheets.values.get`
   - Sheets `spreadsheets.values.append`
4. Keep current storage tables and migration model.

## Concrete mapping from current code to library adoption

Current hand-rolled pieces to replace incrementally:

- PKCE generation in `src/routes/app.$organizationId.google.tsx:60`
- callback code/token exchange in `src/routes/api/google/callback.tsx:54`
- refresh-token exchange in `src/organization-agent.ts:1004`

Incremental migration:

1. Swap only token exchange + refresh to `oauth4webapi` first.
2. Keep Drive/Sheets fetch logic unchanged initially.
3. Add `jose` only for `id_token` verification step.
4. If needed later, add service-account support as separate auth mode.

## Sources

- Google API Node.js client: https://github.com/googleapis/google-api-nodejs-client
- `googleapis` package metadata: https://www.npmjs.com/package/googleapis
- `google-auth-library` package metadata: https://www.npmjs.com/package/google-auth-library
- Google API JavaScript client: https://google.github.io/google-api-javascript-client/docs/start.html
- Cloudflare Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- `oauth4webapi`: https://github.com/panva/oauth4webapi
- `oauth4webapi` API docs: https://jsr.io/@panva/oauth4webapi/doc
- `jose`: https://github.com/panva/jose
- `jose` docs site: https://jsr.io/@panva/jose/doc
- `openid-client`: https://github.com/panva/openid-client
- Cloudflare workers OAuth provider package: https://www.npmjs.com/package/@cloudflare/workers-oauth-provider
- Google Discovery overview: https://developers.google.com/discovery
- Build client libraries from discovery docs: https://docs.cloud.google.com/docs/discovery/build-client-library
- Orval fetch client (edge-capable generation option): https://orval.dev/docs/guides/fetch/
- MCP OAuth docs in refs: `refs/agents/docs/securing-mcp-servers.md:3`
- MCP OAuth wiring in refs: `refs/agents/packages/agents/src/index.ts:686`
- MCP OAuth provider type in refs: `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:20`
