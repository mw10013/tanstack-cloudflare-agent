import { invariant } from "@epic-web/invariant";
import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";

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

        const body = new URLSearchParams();
        body.set("code", code);
        body.set("client_id", context.env.GOOGLE_OAUTH_CLIENT_ID);
        body.set("client_secret", context.env.GOOGLE_OAUTH_CLIENT_SECRET);
        body.set("redirect_uri", context.env.GOOGLE_OAUTH_REDIRECT_URI);
        body.set("grant_type", "authorization_code");
        body.set("code_verifier", stateResult.codeVerifier);
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!tokenRes.ok) {
          return Response.redirect(
            `${context.env.BETTER_AUTH_URL}/app/${organizationId}/google?google=error`,
            302,
          );
        }
        const tokenJson = z.object({
          access_token: z.string(),
          expires_in: z.number(),
          refresh_token: z.string().optional(),
          scope: z.string(),
          id_token: z.string().optional(),
        }).parse(await tokenRes.json());
        await stub.saveGoogleTokens({
          accessToken: tokenJson.access_token,
          accessTokenExpiresAt: Date.now() + tokenJson.expires_in * 1000,
          refreshToken: tokenJson.refresh_token,
          scope: tokenJson.scope,
          idToken: tokenJson.id_token,
        });
        return Response.redirect(
          `${context.env.BETTER_AUTH_URL}/app/${organizationId}/google?google=connected`,
          302,
        );
      },
    },
  },
});
