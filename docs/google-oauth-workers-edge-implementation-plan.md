# Google OAuth Workers Edge Implementation Plan

Updated: 2026-02-18

## Goal

Migrate Google OAuth/token lifecycle to `openid-client` on Workers, keep runtime-compatible `fetch` for Google APIs, then optionally consolidate Drive/Sheets calls into one typed module.

## Grounding Excerpts

From `docs/google-oauth-workers-edge-research.md`:

- Option A accepted: auth code + PKCE + `openid-client` (`docs/google-oauth-workers-edge-research.md:247`, `docs/google-oauth-workers-edge-research.md:264`)
- Keep Drive/Sheets as typed `fetch` wrappers (`docs/google-oauth-workers-edge-research.md:253`, `docs/google-oauth-workers-edge-research.md:444`)
- Incremental migration order: callback + refresh first (`docs/google-oauth-workers-edge-research.md:451`, `docs/google-oauth-workers-edge-research.md:474`)

From current code:

- PKCE + auth URL is hand-rolled in `beginGoogleConnect` (`src/routes/app.$organizationId.google.tsx:47`)
- Callback token exchange is raw `fetch` (`src/routes/api/google/callback.tsx:54`)
- Refresh flow is raw `fetch` (`src/organization-agent.ts:1003`)
- Drive + Sheets calls are direct `fetch` (`src/organization-agent.ts:618`, `src/organization-agent.ts:664`, `src/organization-agent.ts:682`)

From upstream `openid-client` docs:

- Runtime support includes Cloudflare Workers (`https://github.com/panva/openid-client` README)
- Auth-code flow API: `buildAuthorizationUrl`, `authorizationCodeGrant`, `refreshTokenGrant`, `randomPKCECodeVerifier`, `calculatePKCECodeChallenge`, `randomState`

## Scope

In scope:

1. Replace manual PKCE/auth URL assembly with `openid-client` helpers.
2. Replace callback code exchange with `openid-client` `authorizationCodeGrant`.
3. Replace refresh-token exchange with `openid-client` `refreshTokenGrant`.
4. Add one contained typed Google API module and migrate agent methods to it.

Out of scope:

1. Service-account OAuth mode.
2. Discovery codegen pipeline.
3. Reworking storage schema/tables.

## Phase 1: Add Dependency

1. Add `openid-client` as pinned dependency.

```bash
pnpm add openid-client@6.8.2
```

2. Verify package is present with exact pin in `package.json`.

## Phase 2: Add OAuth Helper Module

Create `src/lib/google-oauth-client.ts`.

```ts
import * as Oidc from "openid-client";
import * as z from "zod";

export interface GoogleOAuthClientInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleAuthorizationInput extends GoogleOAuthClientInput {
  scope: readonly string[];
}

const GoogleTokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

let cachedConfig: Oidc.Configuration | undefined;
let cachedKey: string | undefined;

const getConfig = async ({
  clientId,
  clientSecret,
}: GoogleOAuthClientInput): Promise<Oidc.Configuration> => {
  const key = `${clientId}:${clientSecret}`;
  if (cachedConfig && cachedKey === key) {
    return cachedConfig;
  }
  const config = await Oidc.discovery(
    new URL("https://accounts.google.com"),
    clientId,
    clientSecret,
  );
  cachedConfig = config;
  cachedKey = key;
  return config;
};

export const buildGoogleAuthorizationRequest = async (
  input: GoogleAuthorizationInput,
) => {
  const config = await getConfig(input);
  const state = Oidc.randomState();
  const codeVerifier = Oidc.randomPKCECodeVerifier();
  const codeChallenge = await Oidc.calculatePKCECodeChallenge(codeVerifier);
  const authorizationUrl = Oidc.buildAuthorizationUrl(config, {
    redirect_uri: input.redirectUri,
    scope: input.scope.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return { state, codeVerifier, authorizationUrl: authorizationUrl.href };
};

export const exchangeGoogleAuthorizationCode = async (
  input: GoogleOAuthClientInput & {
    currentUrl: URL | Request;
    codeVerifier: string;
    expectedState: string;
  },
) => {
  const config = await getConfig(input);
  const tokenResponse = await Oidc.authorizationCodeGrant(
    config,
    input.currentUrl,
    {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.expectedState,
    },
    { redirect_uri: input.redirectUri },
  );
  return GoogleTokenResponse.parse(tokenResponse);
};

export const refreshGoogleToken = async (
  input: GoogleOAuthClientInput & { refreshToken: string },
) => {
  const config = await getConfig(input);
  const tokenResponse = await Oidc.refreshTokenGrant(
    config,
    input.refreshToken,
  );
  return GoogleTokenResponse.parse(tokenResponse);
};
```

## Phase 3: Migrate Begin OAuth Route

Edit `src/routes/app.$organizationId.google.tsx`.

1. Remove manual PKCE utilities from route-level flow.
2. Use helper function to get URL + state + verifier.
3. Persist `state` + `codeVerifier` exactly as now via `stub.beginGoogleOAuth`.

Snippet:

```ts
import { buildGoogleAuthorizationRequest } from "@/lib/google-oauth-client";

const beginGoogleConnect = createServerFn({ method: "POST" }).handler(
  async ({ context: { session, env } }) => {
    invariant(session, "Missing session");
    const organizationId = session.session.activeOrganizationId;
    invariant(organizationId, "Missing active organization");
    invariant(env.GOOGLE_OAUTH_CLIENT_ID, "Missing GOOGLE_OAUTH_CLIENT_ID");
    invariant(
      env.GOOGLE_OAUTH_CLIENT_SECRET,
      "Missing GOOGLE_OAUTH_CLIENT_SECRET",
    );
    invariant(
      env.GOOGLE_OAUTH_REDIRECT_URI,
      "Missing GOOGLE_OAUTH_REDIRECT_URI",
    );

    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);

    const oauth = await buildGoogleAuthorizationRequest({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      scope: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/documents",
      ],
    });

    await stub.beginGoogleOAuth({
      state: oauth.state,
      codeVerifier: oauth.codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return { url: oauth.authorizationUrl };
  },
);
```

## Phase 4: Migrate Callback Exchange

Edit `src/routes/api/google/callback.tsx`.

1. Keep current redirect/error semantics unchanged.
2. Replace raw token endpoint `fetch` with `exchangeGoogleAuthorizationCode`.
3. Continue storing tokens through existing `stub.saveGoogleTokens`.

Snippet:

```ts
import { exchangeGoogleAuthorizationCode } from "@/lib/google-oauth-client";

const token = await exchangeGoogleAuthorizationCode({
  clientId: context.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: context.env.GOOGLE_OAUTH_CLIENT_SECRET,
  redirectUri: context.env.GOOGLE_OAUTH_REDIRECT_URI,
  currentUrl: callbackUrl,
  codeVerifier: stateResult.codeVerifier,
  expectedState: state,
});

await stub.saveGoogleTokens({
  accessToken: token.access_token,
  accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
  refreshToken: token.refresh_token,
  scope: token.scope ?? "",
  idToken: token.id_token,
});
```

## Phase 5: Migrate Refresh Flow in Agent

Edit `src/organization-agent.ts` (`refreshGoogleAccessToken` only).

1. Keep `getValidGoogleAccessToken` behavior unchanged.
2. Replace raw token refresh `fetch` with helper.
3. Keep SQL update semantics and fallback scopes.

Snippet:

```ts
import { refreshGoogleToken } from "@/lib/google-oauth-client";

private async refreshGoogleAccessToken(refreshToken: string) {
  const token = await refreshGoogleToken({
    clientId: this.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: this.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: this.env.GOOGLE_OAUTH_REDIRECT_URI,
    refreshToken,
  });
  const current = this.getGoogleConnectionRow();
  if (!current) {
    throw new Error("Google connection missing");
  }
  const now = Date.now();
  void this.sql`update GoogleConnection
    set accessToken = ${token.access_token},
        accessTokenExpiresAt = ${now + token.expires_in * 1000},
        scopes = ${token.scope ?? current.scopes},
        idToken = ${token.id_token ?? current.idToken},
        updatedAt = ${now}
    where id = 1`;
}
```

## Phase 6: Add Typed Google API Module

Create `src/lib/google-client.ts`.

1. Keep runtime transport as `fetch`.
2. Add shared request/error core.
3. Add only current methods:
   1. `drive.files.list`
   2. `sheets.spreadsheets.values.get`
   3. `sheets.spreadsheets.values.append`

Snippet:

```ts
import * as z from "zod";

const GoogleApiError = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    status: z.string().optional(),
  }),
});

const DriveListResponse = z.object({
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        modifiedTime: z.string().optional(),
        webViewLink: z.string().optional(),
      }),
    )
    .optional(),
});

const SheetsValuesResponse = z.object({
  range: z.string().optional(),
  majorDimension: z.string().optional(),
  values: z.array(z.array(z.string())).optional(),
});

const SheetsAppendResponse = z.object({
  spreadsheetId: z.string().optional(),
  tableRange: z.string().optional(),
  updates: z
    .object({
      updatedRange: z.string().optional(),
      updatedRows: z.number().optional(),
      updatedColumns: z.number().optional(),
      updatedCells: z.number().optional(),
    })
    .optional(),
});

interface GoogleRequestInput<T> {
  url: URL | string;
  accessToken: string;
  method?: "GET" | "POST";
  body?: string;
  schema: z.ZodType<T>;
}

const fetchGoogle = async <T>({
  url,
  accessToken,
  method = "GET",
  body,
  schema,
}: GoogleRequestInput<T>) => {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => null);
    const parsed = GoogleApiError.safeParse(json);
    throw new Error(
      parsed.success
        ? `Google API ${String(parsed.data.error.code)}: ${parsed.data.error.message}`
        : `Google API request failed: ${String(response.status)}`,
    );
  }
  return schema.parse(await response.json());
};

export const listDriveSpreadsheets = async (
  accessToken: string,
  pageSize = 100,
) => {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
  );
  url.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");
  url.searchParams.set("pageSize", String(pageSize));
  return fetchGoogle({ url, accessToken, schema: DriveListResponse });
};

export const getSpreadsheetValues = async (
  accessToken: string,
  spreadsheetId: string,
  range: string,
) =>
  fetchGoogle({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    accessToken,
    schema: SheetsValuesResponse,
  });

export const appendSpreadsheetValues = async (
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[],
) =>
  fetchGoogle({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    accessToken,
    method: "POST",
    body: JSON.stringify({ values: [values] }),
    schema: SheetsAppendResponse,
  });
```

## Phase 7: Replace Agent Drive/Sheets Calls

Edit `src/organization-agent.ts`.

1. Replace `listDriveSpreadsheets` raw `fetch` with `listDriveSpreadsheets` helper.
2. Replace `readDefaultRange` raw `fetch` with `getSpreadsheetValues`.
3. Replace `appendDefaultRow` raw `fetch` with `appendSpreadsheetValues`.

Snippet:

```ts
import {
  appendSpreadsheetValues,
  getSpreadsheetValues,
  listDriveSpreadsheets,
} from "@/lib/google-client";

const data = await listDriveSpreadsheets(accessToken);
const files = (data.files ?? []).map((file) => ({
  spreadsheetId: file.id,
  name: file.name,
  modifiedTime: file.modifiedTime ?? null,
  webViewLink: file.webViewLink ?? null,
}));
```

## Phase 8: Validation Gates

Run after each phase:

```bash
pnpm typecheck
pnpm lint
```

Manual validation:

1. Connect Google from `/app/$organizationId/google` and ensure redirect query becomes `google=connected`.
2. Re-connect same account and confirm refresh token remains non-null in `GoogleConnection`.
3. Force token refresh path by setting short expiry in DB and invoking Drive/Sheets actions.
4. Verify spreadsheet list/read/append still works.
5. Verify denied consent returns `google=denied`.
6. Verify invalid state returns `google=error`.

## File Change Checklist

1. `package.json`
2. `src/lib/google-oauth-client.ts`
3. `src/routes/app.$organizationId.google.tsx`
4. `src/routes/api/google/callback.tsx`
5. `src/organization-agent.ts`
6. `src/lib/google-client.ts`

## Risks and Mitigations

1. Discovery request latency on cold start
   1. Use in-memory config cache in helper module.
2. Token shape drift
   1. Keep Zod parsing with strict required token fields.
3. Scope omissions from token response
   1. Preserve existing scope fallback (`token.scope ?? current.scopes`).
4. Runtime mismatch
   1. Validate on local Workers runtime with existing route flow before production deploy.
