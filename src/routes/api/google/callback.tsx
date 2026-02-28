import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import * as Option from "effect/Option";
import { Auth } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/effect-services";
import { exchangeGoogleAuthorizationCode } from "@/lib/google-oauth-client";

export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request, context: { runEffect } }) =>
        runEffect(
          Effect.gen(function* () {
            const auth = yield* Auth;
            const env = yield* CloudflareEnv;
            const session = yield* Effect.tryPromise(() =>
              auth.api.getSession({ headers: request.headers }),
            );
            if (!session?.session.activeOrganizationId) {
              return new Response("Unauthorized", { status: 401 });
            }
            const organizationId = session.session.activeOrganizationId;
            const callbackUrl = new URL(request.url);
            const code = callbackUrl.searchParams.get("code");
            const state = callbackUrl.searchParams.get("state");
            const providerError = callbackUrl.searchParams.get("error");
            if (providerError) {
              return Response.redirect(
                `${env.BETTER_AUTH_URL}/app/${organizationId}/google?google=denied`,
                302,
              );
            }
            if (!code || !state) {
              return Response.redirect(
                `${env.BETTER_AUTH_URL}/app/${organizationId}/google?google=error`,
                302,
              );
            }
            const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
            const stub = env.ORGANIZATION_AGENT.get(id);
            const stateResult = yield* Effect.tryPromise(async () =>
              stub.consumeGoogleOAuthState(state),
            );
            if (!stateResult.ok) {
              return Response.redirect(
                `${env.BETTER_AUTH_URL}/app/${organizationId}/google?google=error`,
                302,
              );
            }

            const tokenOption = yield* Effect.option(
              Effect.tryPromise(() =>
                exchangeGoogleAuthorizationCode({
                  clientId: env.GOOGLE_OAUTH_CLIENT_ID,
                  clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
                  redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
                  currentUrl: callbackUrl,
                  codeVerifier: stateResult.codeVerifier,
                  expectedState: state,
                }),
              ),
            );
            if (Option.isNone(tokenOption)) {
              return Response.redirect(
                `${env.BETTER_AUTH_URL}/app/${organizationId}/google?google=error`,
                302,
              );
            }
            const token = tokenOption.value;
            yield* Effect.tryPromise(() =>
              stub.saveGoogleTokens({
                accessToken: token.access_token,
                accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
                refreshToken: token.refresh_token,
                scope: token.scope ?? "",
                idToken: token.id_token,
              }),
            );
            return Response.redirect(
              `${env.BETTER_AUTH_URL}/app/${organizationId}/google?google=connected`,
              302,
            );
          }),
        ),
    },
  },
});
