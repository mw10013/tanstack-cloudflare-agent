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

### `openid-client`

Why relevant:

- Package description: "OAuth 2 / OpenID Connect Client API for JavaScript Runtimes."
- Runtime support list includes "Cloudflare Workers".
- Package simplifies OAuth/OIDC integration with higher-level APIs.

How it helps here:

- Higher-level OAuth/OIDC client wrapper than `oauth4webapi`.
- Tradeoff: more abstraction/magic; less minimal than `oauth4webapi`.

Direct answers to annotation questions:

- Maintainer overlap: yes, same maintainer ecosystem (`openid-client`, `oauth4webapi`, `jose`).
- `openid-client` package currently depends on both `oauth4webapi` and `jose` (`openid-client` `package.json`).
- If you adopt `openid-client` for user OAuth/OIDC flows, you usually do not need to use `oauth4webapi` directly.
- If you adopt `openid-client`, you usually do not need direct `jose` for normal auth-code + refresh flow.
- You still need direct `jose` when you need JWT features outside `openid-client` scope.

Inference from sources:

- Direct `jose` still useful for Google service-account JWT bearer assertions and custom JWT operations not modeled by `openid-client` APIs.

### `oauth4webapi` vs `openid-client` (which one for this codebase?)

Grounding from docs:

- `oauth4webapi`: "Low-Level OAuth 2 / OpenID Connect Client API for JavaScript Runtimes."
- `openid-client`: "simplifies integration with authorization servers..." and provides easier OAuth/OIDC flows.

Practical decision:

- If your preference is higher-level and less boilerplate: use `openid-client`.
- If you want very explicit protocol-level control and minimal abstraction: use `oauth4webapi`.

Code reduction expectation:

- `openid-client` should reduce flow boilerplate vs `oauth4webapi` in callback + token lifecycle wiring.
- `oauth4webapi` remains cleaner than fully manual raw `fetch` flow but still more verbose than `openid-client`.

### `@cloudflare/workers-oauth-provider`

Why relevant:

- Worker-native OAuth provider.

Scope caveat:

- Best fit when your Worker is acting as an OAuth authorization server/provider (not primarily as a Google OAuth client for app features).
- Still useful reference for consent/state/CSRF hardening patterns.

## Recommended architecture options

### Option A (recommended for this codebase): auth code + PKCE + `openid-client`

Shape:

1. Keep `beginGoogleOAuth` + `consumeGoogleOAuthState` in DO SQLite.
2. Use `openid-client` for authorization URL, callback validation, token exchange, refresh.
3. Keep Drive/Sheets calls as typed `fetch` wrappers.
4. Keep Zod response validation for runtime safety.

Why:

- Edge-native.
- Highest code reduction for OAuth/OIDC plumbing.
- Still compatible with Workers runtime.

Decision:

- Accepted on 2026-02-18: use Option A for this codebase.

### Option A2 (lower-level alternative): auth code + PKCE + `oauth4webapi`

Why:

- Edge-native and explicit protocol control.
- Good fit if you want fewer abstractions than `openid-client`.

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

## Discovery-based generation without LLM

Official discovery endpoints:

- API directory endpoint: `https://discovery.googleapis.com/discovery/v1/apis`
- Service discovery document endpoint pattern: `https://<api>/$discovery/rest?version=<version>`
- Example Sheets discovery doc: `https://sheets.googleapis.com/$discovery/rest?version=v4`
- Example Drive discovery doc: `https://www.googleapis.com/discovery/v1/apis/drive/v3/rest`

Direct/tooling approach (non-LLM):

1. Fetch discovery docs at build-time.
2. Generate TS types from `schemas` and request/response types from method definitions.
3. Generate thin typed client wrappers that still call runtime `fetch`.
4. Regenerate on dependency/API version bump to stay in sync.

Inference from sources:

- Google docs describe discovery as machine-readable metadata for building clients.
- I did not find an official Google-maintained TypeScript generator for Workers runtime from discovery docs.
- Most robust path is an internal codegen step targeting only the methods you use.

## Discovery/OpenAPI tool viability for this project

### Candidate 1: `google-discovery-to-swagger` -> OpenAPI/Swagger -> TS generator

Pros:

- Explicitly built for Google Discovery conversion.

Cons:

- npm shows last publish was 6 years ago.
- Converts to Swagger 2.0, so often needs an additional conversion step to modern OpenAPI 3-first tooling.

Viability:

- Medium for one-off conversion, low for long-term core dependency.

Reject

### Candidate 2: `api-spec-converter` (`google` format support)

Pros:

- Supports Google Discovery input format in conversion table.

Cons:

- README says project is looking for a new maintainer.
- README states direct support is centered on OpenAPI 2.0 conversion, with OpenAPI 3 via intermediate conversion.

Viability:

- Low as a long-term dependency in a production path.

Reject

### Candidate 3: OpenAPI-native generators (`orval`, `@hey-api/openapi-ts`) after conversion

Pros:

- Strong TypeScript output ecosystem.
- `orval` supports fetch output and documents edge-runtime compatibility for fetch clients.
- `@hey-api/openapi-ts` has modern SDK/type plugin model.

Cons:

- Require trustworthy OpenAPI input; Google source of truth is Discovery, so you still need conversion or custom extraction.

Viability:

- High if OpenAPI input quality is controlled.

Consider mid-term

### Candidate 4: internal minimal generator from Discovery docs (project-local)

Pros:

- No dependency on stale conversion tools.
- Can generate only needed methods (`drive.files.list`, `sheets.values.get`, `sheets.values.append`).
- Keeps output shaped to Workers + fetch runtime.

Cons:

- You own generator maintenance.

Viability:

- High for this project scope.

Adopt. Note that this will probably be generated by an llm.

## Do we actually want codegen in this project now?

Recommendation:

- Short-term: no heavy external codegen pipeline yet.
- Medium-term: adopt a small internal generator only when endpoint surface grows.

Rationale:

- Current Google surface in codebase is small (a few endpoints), so manual typed wrappers + Zod are still cheap.
- Most complexity currently sits in OAuth/token lifecycle, not endpoint count.

## LLM-generated code viability

Short answer:

- Viable for bootstrap/scaffolding, not ideal as the long-term source-of-truth generator.

Use LLM safely if you choose it:

1. Treat discovery docs as hard input and generate deterministic artifacts from pinned versions.
2. Validate generated code with strict TypeScript + lint + runtime Zod parsing.
3. Snapshot generated outputs and review diffs like generated code, not handwritten code.
4. Keep a non-LLM fallback script path for reproducibility in CI.

Recommendation:

- Use LLM only to accelerate initial internal-generator implementation, then run deterministic script-based generation going forward.

## Suggested next implementation spike

1. Add `openid-client`; migrate callback exchange + refresh flow first.
2. Keep Drive/Sheets HTTP calls as-is in first migration step.
3. Add direct `jose` only if/when you need:
   - service-account JWT bearer flow
   - custom JWT verification not covered by `openid-client` flow
4. Add typed wrappers for current endpoints first:
   - Drive `files.list`
   - Sheets `spreadsheets.values.get`
   - Sheets `spreadsheets.values.append`
5. Keep current storage tables and migration model.
6. Defer external discovery->openapi toolchain until endpoint count justifies it.

## Concrete mapping from current code to library adoption

Current hand-rolled pieces to replace incrementally:

- PKCE generation in `src/routes/app.$organizationId.google.tsx:60`
- callback code/token exchange in `src/routes/api/google/callback.tsx:54`
- refresh-token exchange in `src/organization-agent.ts:1004`

Incremental migration:

1. Swap only token exchange + refresh to `openid-client` first.
2. Keep Drive/Sheets fetch logic unchanged initially.
3. Add `jose` only when specific JWT use-cases require it.
4. If needed later, add service-account support as separate auth mode.

## Sources

- Google API Node.js client: https://github.com/googleapis/google-api-nodejs-client
- `googleapis` package metadata: https://www.npmjs.com/package/googleapis
- `google-auth-library` package metadata: https://www.npmjs.com/package/google-auth-library
- Google API JavaScript client: https://google.github.io/google-api-javascript-client/docs/start.html
- Cloudflare Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- `oauth4webapi`: https://github.com/panva/oauth4webapi
- `oauth4webapi` API docs: https://jsr.io/@panva/oauth4webapi/doc
- `oauth4webapi` package page (runtime + low-level description): https://www.npmjs.com/package/oauth4webapi
- `jose`: https://github.com/panva/jose
- `jose` docs site: https://jsr.io/@panva/jose/doc
- `jose` package page (runtime + dependency note): https://www.npmjs.com/package/jose
- `openid-client`: https://github.com/panva/openid-client
- `openid-client` package page (runtime + high-level description): https://www.npmjs.com/package/openid-client
- `openid-client` dependencies (`oauth4webapi`, `jose`): https://raw.githubusercontent.com/panva/openid-client/main/package.json
- Cloudflare workers OAuth provider package: https://www.npmjs.com/package/@cloudflare/workers-oauth-provider
- Google Discovery overview: https://developers.google.com/discovery
- Google API Discovery usage guide: https://developers.google.com/discovery/v1/using
- Build client libraries from discovery docs: https://docs.cloud.google.com/docs/discovery/build-client-library
- Sheets discovery document: https://sheets.googleapis.com/$discovery/rest?version=v4
- Drive discovery document: https://www.googleapis.com/discovery/v1/apis/drive/v3/rest
- Orval fetch client (edge-capable generation option): https://orval.dev/docs/guides/fetch/
- `google-discovery-to-swagger` package: https://www.npmjs.com/package/google-discovery-to-swagger
- `google-discovery-to-swagger` README: https://raw.githubusercontent.com/APIs-guru/google-discovery-to-swagger/master/README.md
- `api-spec-converter` README: https://raw.githubusercontent.com/LucyBot-Inc/api-spec-converter/master/README.md
- `@hey-api/openapi-ts` README: https://raw.githubusercontent.com/hey-api/openapi-ts/main/packages/openapi-ts/README.md
- MCP OAuth docs in refs: `refs/agents/docs/securing-mcp-servers.md:3`
- MCP OAuth wiring in refs: `refs/agents/packages/agents/src/index.ts:686`
- MCP OAuth provider type in refs: `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:20`
