import { invariant } from "@epic-web/invariant";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/org/$organizationId/upload-image/$name")({
  server: {
    handlers: {
      GET: async ({ params: { organizationId, name }, context: { env, session } }) => {
        if (env.ENVIRONMENT !== "local") {
          return new Response("Not Found", { status: 404 });
        }
        invariant(session, "Missing session");
        if (session.session.activeOrganizationId !== organizationId) {
          return new Response("Forbidden", { status: 403 });
        }
        const key = `${organizationId}/${name}`;
        const object = await env.R2.get(key);
        if (!object?.body) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(object.body, {
          headers: {
            "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "Cache-Control": "private, max-age=60",
            ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
          },
        });
      },
    },
  },
});
