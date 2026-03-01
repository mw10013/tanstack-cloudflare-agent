import { Redacted } from "effect";
import * as Oidc from "openid-client";
import * as Schema from "effect/Schema";

export interface GoogleOAuthClientInput {
  clientId: string;
  clientSecret: Redacted.Redacted;
  redirectUri: string;
}

export interface GoogleAuthorizationInput extends GoogleOAuthClientInput {
  scope: readonly string[];
}

const GoogleTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
});

let cachedConfig: Oidc.Configuration | undefined;
let cachedConfigKey: string | undefined;

const getGoogleOidcConfig = async (
  { clientId, clientSecret }: GoogleOAuthClientInput,
) => {
  const secret = Redacted.value(clientSecret);
  const configKey = `${clientId}:${secret}`;
  if (cachedConfig && cachedConfigKey === configKey) {
    return cachedConfig;
  }
  const config = await Oidc.discovery(
    new URL("https://accounts.google.com"),
    clientId,
    secret,
  );
  cachedConfig = config;
  cachedConfigKey = configKey;
  return config;
};

export const buildGoogleAuthorizationRequest = async (
  input: GoogleAuthorizationInput,
) => {
  const config = await getGoogleOidcConfig(input);
  const state = Oidc.randomState();
  const codeVerifier = Oidc.randomPKCECodeVerifier();
  const codeChallenge = await Oidc.calculatePKCECodeChallenge(codeVerifier);
  const authorizationUrl = Oidc.buildAuthorizationUrl(config, {
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scope.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return {
    state,
    codeVerifier,
    authorizationUrl: authorizationUrl.toString(),
  };
};

export const exchangeGoogleAuthorizationCode = async (
  input: GoogleOAuthClientInput & {
    currentUrl: URL | Request;
    codeVerifier: string;
    expectedState: string;
  },
) => {
  const config = await getGoogleOidcConfig(input);
  const tokenResponse = await Oidc.authorizationCodeGrant(
    config,
    input.currentUrl,
    {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.expectedState,
    },
    { redirect_uri: input.redirectUri },
  );
  return Schema.decodeUnknownSync(GoogleTokenResponse)(tokenResponse);
};

export const refreshGoogleToken = async (
  input: GoogleOAuthClientInput & { refreshToken: string },
) => {
  const config = await getGoogleOidcConfig(input);
  const tokenResponse = await Oidc.refreshTokenGrant(config, input.refreshToken);
  return Schema.decodeUnknownSync(GoogleTokenResponse)(tokenResponse);
};
