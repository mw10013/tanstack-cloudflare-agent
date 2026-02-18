# Google Sheets OAuth for Organization Agent (POC Research)

## TL;DR

- Use **Google Sheets API first**.
- Keep Google OAuth separate from Better Auth.
- Store Google OAuth artifacts in the **organization agent Durable Object SQLite**.
- One Google connection per organization agent is feasible.
- Hibernation is fine as long as tokens/state are persisted in DO storage, not memory.

## Why Sheets over Docs for first POC

Sheets is simpler because the first useful operations are direct value read/write calls:

- `spreadsheets.values.get`
- `spreadsheets.values.update`
- `spreadsheets.values.append`

Docs editing is operation/index based via `documents.batchUpdate`, and document structure/tabs handling adds complexity.

Practical impact for POC:

- Sheets: fast path to "agent writes data users can inspect"
- Docs: more structure orchestration before first useful edit

References:

- https://developers.google.com/workspace/sheets/api/guides/values
- https://developers.google.com/sheets/api/reference/rest
- https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate
- https://developers.google.com/workspace/docs/api/how-tos/tabs

## OAuth explained simply (no auth-as-login coupling)

OAuth here means:

1. User clicks "Connect Google"
2. Google asks user to approve your app for chosen scopes
3. Callback returns an authorization `code`
4. Server exchanges `code` for tokens:
   - `access_token` (short-lived)
   - `refresh_token` (long-lived, used to get new access tokens)
5. Store refresh token in organization agent storage
6. Later calls to Sheets API use access token; refresh when expired

This does **not** require using Google for web-app sign in.

Reference:

- https://developers.google.com/identity/protocols/oauth2/web-server

## Clarifying your questions

### Why ask for a "first action"?

Because OAuth scopes should match first capability. POC is easier if we define one small outcome, e.g.:

- "Create a spreadsheet and append a row"

Then scope/API/storage can be minimal.

### Why might `spreadsheetId` be required?

Most Sheets API calls target a specific spreadsheet, so they need `spreadsheetId`.

POC options:

- User pastes `spreadsheetId` once
- or user picks from a list of existing spreadsheets
- or agent creates a spreadsheet first, then persists returned `spreadsheetId`

If you want users to pick existing spreadsheets, add a listing step.

Important detail: listing spreadsheets is generally a **Drive API** concern (`files.list` with spreadsheet mime type), not a Sheets API endpoint. So this introduces Drive scope/API even if write actions remain Sheets.

References:

- https://developers.google.com/workspace/drive/api/guides/search-files
- https://developers.google.com/workspace/drive/api/guides/mime-types
- https://developers.google.com/workspace/sheets/api/scopes

Hmmm, it makes sense that drive seems to be primary focus. Perhaps we should focus on drive first for the poc. is there a way scopes or some such in the oauth flow for drive, sheets, and docs in one go? I still don't understand oath to know even what scopes are or the oauth flow.

## Grounding in current codebase

Your organization agent already uses agent-local SQLite:

- `src/organization-agent.ts:235` class `OrganizationAgent extends AIChatAgent<Env>`
- `src/organization-agent.ts:239` creates `Upload` table via `this.sql`

Agent SDK persists state and MCP metadata in DO SQLite:

- `refs/agents/packages/agents/src/index.ts:591` creates `cf_agents_mcp_servers`
- `refs/agents/packages/agents/src/index.ts:603` creates `cf_agents_state`
- `refs/agents/packages/agents/src/index.ts:577` executes SQL via `this.ctx.storage.sql.exec(...)`

Agents SDK OAuth provider also persists OAuth client/tokens/state in Durable Object storage:

- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:113`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:137`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:157`

That matches your preference to avoid Better Auth `Account` table.

### Agents SDK OAuth deep dive (what it is, what it is not)

What it is:

- OAuth plumbing used by the Agents SDK MCP client manager
- Persists OAuth state/client/tokens in DO storage
- Handles callback orchestration through Agent request handling

Grounding:

- `refs/agents/packages/agents/src/index.ts:686` initializes `MCPClientManager`
- `refs/agents/packages/agents/src/index.ts:753` handles MCP OAuth callback path
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:36` class `DurableObjectOAuthClientProvider`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:149` generates/stores `state`
- `refs/agents/packages/agents/src/mcp/do-oauth-client-provider.ts:137` persists tokens

What it is not:

- Not an out-of-box generic Google OAuth integration for arbitrary app features.
- It is specialized around MCP server OAuth flows.

POC guidance:

- Reuse the same design patterns (state table, token persistence, callback validation).

Are you saying we should use the same tables as the agent implementation for MCP? Is that wise? It seems like we really can't use Agents SDK OAuth or am i misunderstanding. need more context and guidance here. 

- Implement Google OAuth explicitly for your organization-agent integration.

## Durable Object hibernation and token persistence

From Cloudflare docs:

- DO can hibernate after ~10s idle in hibernateable state
- In-memory state is discarded when hibernated
- Constructor runs again on wake

References:

- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:30`
- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:51`
- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:54`
- `refs/cloudflare-docs/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx:59`

Implication:

- Keep OAuth tokens, oauth `state`, chosen spreadsheet id in DO SQLite
- Do not rely on instance vars for these values

## Security posture for POC

Cloudflare DO data is encrypted at rest and in transit:

- `refs/cloudflare-docs/src/content/docs/durable-objects/reference/data-security.mdx:17`
- `refs/cloudflare-docs/src/content/docs/durable-objects/reference/data-security.mdx:25`

Still recommended:

- Store Google client secret and optional local-encryption key as Worker secrets (`env` bindings)
- Use Wrangler secrets for prod values

Reference:

- `refs/cloudflare-docs/src/content/docs/workers/configuration/secrets.mdx:12`
- `refs/cloudflare-docs/src/content/docs/workers/configuration/secrets.mdx:80`

## Proposed POC architecture (one Google account per organization agent)

### Connection model

- One row of Google connection metadata per organization agent
- First user to connect establishes org-wide Google account link
- Other users in same org use that same linked account through agent
- Add an org page dedicated to Google connection status + spreadsheet selection.
- If connected, show spreadsheet list and current selected default spreadsheet.

### Suggested tables in OrganizationAgent SQLite

```sql
create table if not exists GoogleConnection (
  id integer primary key check (id = 1),
  provider text not null,
  googleUserEmail text,
  scopes text not null,
  accessToken text,
  accessTokenExpiresAt integer,
  refreshToken text,
  createdAt integer not null,
  updatedAt integer not null
);

create table if not exists GoogleOAuthState (
  state text primary key,
  codeVerifier text,
  createdAt integer not null,
  expiresAt integer not null
);

create table if not exists GoogleSheetsConfig (
  id integer primary key check (id = 1),
  defaultSpreadsheetId text,
  defaultSheetName text,
  updatedAt integer not null
);

create table if not exists GoogleSpreadsheetCache (
  spreadsheetId text primary key,
  name text not null,
  lastSeenAt integer not null
);
```

Notes:

- Keep one-row semantics with `id = 1` constraint.
- For stricter security, encrypt `refreshToken` before storage using a Worker secret key.

## Minimal OAuth + Sheets API flow for POC

1. UI invokes `connectGoogleSheets` action on an org page
2. Server generates OAuth `state` (and PKCE verifier if used), stores in `GoogleOAuthState`
3. Redirect user to Google auth URL with scopes
4. Google callback endpoint validates state, exchanges code for tokens
5. Persist tokens in `GoogleConnection`, clear used state row
6. Fetch spreadsheet list (Drive files.list filtered to spreadsheet mime type) and cache in `GoogleSpreadsheetCache`
7. User picks spreadsheet from list, persist chosen id in `GoogleSheetsConfig`
8. Agent tool calls use stored refresh token -> get access token -> call Sheets API on selected spreadsheet

Recommended scopes for this specific UX:

- Fastest implementation: `spreadsheets` + `drive.readonly`
- Lower-risk alternative: `spreadsheets` + Google Picker + `drive.file` (more moving parts, less broad Drive access)

fastest implementation is too restrictive. we'll want to be able to write and save.

References:

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/workspace/sheets/api/scopes
- https://developers.google.com/workspace/drive/api/guides/search-files
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth

## Worker vs Agent responsibility split

Your mental model is correct. Recommended split:

1. Worker/TanStack route layer:
- Serves pages
- Initiates OAuth redirect
- Receives OAuth callback HTTP request
- Resolves `organizationId` from session/route context
- Forwards connect/disconnect/select actions to the target organization agent

2. Organization Agent:
- Owns Google tokens and config in DO SQLite
- Owns spreadsheet list cache
- Owns all runtime Sheets calls used by tools/RPC/chat workflows

Grounding in current app:

- Worker already routes agent requests and authorizes by active organization id:
  - `src/worker.ts:69`
  - `src/worker.ts:78`
  - `src/worker.ts:89`
- Worker already calls organization agent by name for background flows:
  - `src/worker.ts:180`

Important clarification:

- Browser `useAgent()` WebSocket RPC is useful for interactive UI operations.
- OAuth callback itself should still be plain HTTP route handling.
- Route handler can call the organization agent stub; callback logic does not need to run over browser WebSocket.

## Answers to open items

1. Callback routing shape:

- Use TanStack API route for callback.
- Route has session context; from that derive `activeOrganizationId`, then call target agent by name.

2. PKCE for first pass:

- Recommendation: **include PKCE now**.
- Cost is small, benefit is better authorization-code interception protection.

3. Spreadsheet source:

- Since you want list selection, add Drive listing step and persist selected spreadsheet id.

4. Token encryption at app layer:

- POC acceptable without extra app-layer encryption if you keep strong access controls and use Worker secrets for client secret.
- Next increment: encrypt `refreshToken` using an env key before DB write.

## Why this POC shape is low-risk

- No coupling to Better Auth tables
- Natural fit with Agent/DO lifecycle and persistence model
- One clear success criterion: from chat/tool call, write/read a sheet row
- Easy rollback: disconnect = delete row(s) from `GoogleConnection` and `GoogleSheetsConfig`

## Appendix: why not Better Auth `Account`

You asked to avoid mingling app-auth identity with org-agent integration state.

Current Better Auth schema includes token fields in app DB:

- `migrations/0001_init.sql:119` table `Account`
- `migrations/0001_init.sql:124` `accessToken`
- `migrations/0001_init.sql:125` `refreshToken`

Using organization agent SQLite instead keeps ownership and lifecycle aligned to the organization agent itself.
