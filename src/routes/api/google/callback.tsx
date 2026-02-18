import { invariant } from "@epic-web/invariant";
import { createFileRoute } from "@tanstack/react-router";
import { exchangeGoogleAuthorizationCode } from "@/lib/google-oauth-client";

export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const session = await context.authService.api.getSession({
          headers: request.headers,
        });
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
            `${context.env.BETTER_AUTH_URL}/app/${organizationId}/google?google=denied`,
            302,
          );
        }
        if (!code || !state) {
          return Response.redirect(
            `${context.env.BETTER_AUTH_URL}/app/${organizationId}/google?google=error`,
            302,
          );
        }
        invariant(
          context.env.GOOGLE_OAUTH_CLIENT_ID,
          "Missing GOOGLE_OAUTH_CLIENT_ID",
        );
        invariant(
          context.env.GOOGLE_OAUTH_CLIENT_SECRET,
          "Missing GOOGLE_OAUTH_CLIENT_SECRET",
        );
        invariant(
          context.env.GOOGLE_OAUTH_REDIRECT_URI,
          "Missing GOOGLE_OAUTH_REDIRECT_URI",
        );
        const id = context.env.ORGANIZATION_AGENT.idFromName(organizationId);
        const stub = context.env.ORGANIZATION_AGENT.get(id);
        const stateResult = await stub.consumeGoogleOAuthState(state);
        if (!stateResult.ok) {
          return Response.redirect(
            `${context.env.BETTER_AUTH_URL}/app/${organizationId}/google?google=error`,
            302,
          );
        }

        let token: {
          access_token: string;
          expires_in: number;
          refresh_token?: string;
          scope?: string;
          id_token?: string;
        };
        try {
          token = await exchangeGoogleAuthorizationCode({
            clientId: context.env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: context.env.GOOGLE_OAUTH_CLIENT_SECRET,
            redirectUri: context.env.GOOGLE_OAUTH_REDIRECT_URI,
            currentUrl: callbackUrl,
            codeVerifier: stateResult.codeVerifier,
            expectedState: state,
          });
        } catch {
          return Response.redirect(
            `${context.env.BETTER_AUTH_URL}/app/${organizationId}/google?google=error`,
            302,
          );
        }
        await stub.saveGoogleTokens({
          accessToken: token.access_token,
          accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
          refreshToken: token.refresh_token,
          scope: token.scope ?? "",
          idToken: token.id_token,
        });
        return Response.redirect(
          `${context.env.BETTER_AUTH_URL}/app/${organizationId}/google?google=connected`,
          302,
        );
      },
    },
  },
});
