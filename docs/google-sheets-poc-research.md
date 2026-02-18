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

I don't want to create a new spreadsheet every time the user authenticates. Maybe there's some way to show what spreadsheets are in the account?

### Why might `spreadsheetId` be required?

Most Sheets API calls target a specific spreadsheet, so they need `spreadsheetId`.

POC options:

- User pastes `spreadsheetId` once
- or agent creates a spreadsheet first, then persists returned `spreadsheetId`

Simple path: create one spreadsheet at connect time and store that id as org default.

Again, I think I would like the user to be able to pick an existing spreadsheet from a list.

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

What is Agents SDK OAuth? I think we need a deep dive here since agents may provided very helpful functionality out of the box, hopefully.

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

There are currently several web pages related to organization agent. We'll probably add another one for this poc. If the user navigates to that page, then he should have the opportunity to connect. and when connected or already connected, perhaps that page can show a list of spreadsheets.

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
```

Notes:

- Keep one-row semantics with `id = 1` constraint.
- For stricter security, encrypt `refreshToken` before storage using a Worker secret key.

## Minimal OAuth + Sheets API flow for POC

1. UI invokes `connectGoogleSheets` action on organization agent route
2. Server generates OAuth `state` (and PKCE verifier if used), stores in `GoogleOAuthState`
3. Redirect user to Google auth URL with scopes:
   - `https://www.googleapis.com/auth/spreadsheets`
4. Google callback endpoint validates state, exchanges code for tokens
5. Persist tokens in `GoogleConnection`, clear used state row
6. If no default spreadsheet configured:
   - create spreadsheet via Sheets API
   - persist returned `spreadsheetId` in `GoogleSheetsConfig`
7. Agent tool calls use stored refresh token -> get access token -> call Sheets API

References:

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/workspace/sheets/api/scopes
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create

## Why this POC shape is low-risk

- No coupling to Better Auth tables
- Natural fit with Agent/DO lifecycle and persistence model
- One clear success criterion: from chat/tool call, write/read a sheet row
- Easy rollback: disconnect = delete row(s) from `GoogleConnection` and `GoogleSheetsConfig`

## Open items for next iteration

1. Callback routing shape in this app (TanStack route vs Worker endpoint) and exact URL per env

I think this could be tanstack api route. however, it may get tricky to figure out the organizationId which is needed to get the agent by name.

2. Whether to include PKCE in first pass

What do you advise?

3. Whether to auto-create spreadsheet or require user-provided id

I think I'd like it to list the spreadsheets.

4. Whether to encrypt refresh token at application layer for POC v1

This is where I don't have good sense of the architure with a worker function handling all the tanstack routes and the individual agent/durable objects which run independently. The agent is not able to server web pages, so the worker function would be the point of contact for the client browser. however, once a web page is servered, we can use useAgent() to rpc over web socket to the agent. I think we'll need to use this rpc mechanism to drive the spreadsheet in the organization agent. does that make sense? I don't think the worker fn has direct contact with the google spreadsheet. The agent does.

## Appendix: why not Better Auth `Account`

You asked to avoid mingling app-auth identity with org-agent integration state.

Current Better Auth schema includes token fields in app DB:

- `migrations/0001_init.sql:119` table `Account`
- `migrations/0001_init.sql:124` `accessToken`
- `migrations/0001_init.sql:125` `refreshToken`

Using organization agent SQLite instead keeps ownership and lifecycle aligned to the organization agent itself.
