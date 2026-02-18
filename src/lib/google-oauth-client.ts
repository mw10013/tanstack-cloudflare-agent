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
let cachedConfigKey: string | undefined;

const getGoogleOidcConfig = async (
  { clientId, clientSecret }: GoogleOAuthClientInput,
) => {
  const configKey = `${clientId}:${clientSecret}`;
  if (cachedConfig && cachedConfigKey === configKey) {
    return cachedConfig;
  }
  const config = await Oidc.discovery(
    new URL("https://accounts.google.com"),
    clientId,
    clientSecret,
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
  return GoogleTokenResponse.parse(tokenResponse);
};

export const refreshGoogleToken = async (
  input: GoogleOAuthClientInput & { refreshToken: string },
) => {
  const config = await getGoogleOidcConfig(input);
  const tokenResponse = await Oidc.refreshTokenGrant(config, input.refreshToken);
  return GoogleTokenResponse.parse(tokenResponse);
};
