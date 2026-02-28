import type { AuthService } from "@/lib/auth-service";
import type { RunEffect } from "@/lib/effect-services";
import serverEntry from "@tanstack/react-start/server-entry";
import { getAgentByName, routeAgentRequest } from "agents";
import { Effect } from "effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Auth } from "@/lib/Auth";
import { createD1SessionService } from "@/lib/d1-session-service";
import { makeRunEffect } from "@/lib/effect-services";
import { Repository } from "@/lib/Repository";
import { extractAgentName } from "./organization-agent";

export {
  OrganizationAgent,
  OrganizationWorkflow,
  OrganizationImageClassificationWorkflow,
} from "./organization-agent";

const r2QueueMessageSchema = Schema.Struct({
  action: Schema.NonEmptyString,
  object: Schema.Struct({
    key: Schema.NonEmptyString,
  }),
  eventTime: Schema.NonEmptyString,
});

export interface ServerContext {
  env: Env;
  runEffect: RunEffect;
  session?: AuthService["$Infer"]["Session"];
}

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: ServerContext };
  }
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    console.log(`[${new Date().toISOString()}] fetch: ${request.url}`);
    const isMagicLinkRequest =
      (url.pathname === "/login" && request.method === "POST") ||
      url.pathname === "/api/auth/magic-link/verify";
    if (isMagicLinkRequest) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.MAGIC_LINK_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
    }
    const d1SessionService = createD1SessionService({
      d1: env.D1,
      request,
      sessionConstraint: url.pathname.startsWith("/api/auth/")
        ? "first-primary"
        : undefined,
    });
    const runEffect = makeRunEffect(env);

    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: async (req) => {
        const session = await runEffect(
          Effect.gen(function* () {
            const auth = yield* Auth;
            return yield* auth.getSession(req.headers);
          }),
        );
        if (!session) {
          return new Response("Unauthorized", { status: 401 });
        }
        const agentName = extractAgentName(req);
        const activeOrganizationId = session.session.activeOrganizationId;
        if (!activeOrganizationId || agentName !== activeOrganizationId) {
          return new Response("Forbidden", { status: 403 });
        }
        return undefined;
      },
      onBeforeRequest: async (req) => {
        const session = await runEffect(
          Effect.gen(function* () {
            const auth = yield* Auth;
            return yield* auth.getSession(req.headers);
          }),
        );
        if (!session) {
          return new Response("Unauthorized", { status: 401 });
        }
        const agentName = extractAgentName(req);
        const activeOrganizationId = session.session.activeOrganizationId;
        if (!activeOrganizationId || agentName !== activeOrganizationId) {
          return new Response("Forbidden", { status: 403 });
        }
        return undefined;
      },
    });
    if (routed) {
      return routed;
    }
    const session = await runEffect(
      Effect.gen(function* () {
        const auth = yield* Auth;
        return yield* auth.getSession(request.headers);
      }),
    );
    const response = await serverEntry.fetch(request, {
      context: {
        env,
        runEffect,
        session: session ?? undefined,
      },
    });
    d1SessionService.setSessionBookmarkCookie(response);
    return response;
  },

  async scheduled(scheduledEvent, env, _ctx) {
    switch (scheduledEvent.cron) {
      case "0 0 * * *": {
        const runEffect = makeRunEffect(env);
        const deletedCount = await runEffect(
          Effect.gen(function* () {
            const repository = yield* Repository;
            return yield* repository.deleteExpiredSessions();
          }),
        );
        console.log(`Deleted ${String(deletedCount)} expired sessions`);
        break;
      }
      default: {
        console.warn(`Unexpected cron schedule: ${scheduledEvent.cron}`);
        break;
      }
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const result = Schema.decodeUnknownExit(r2QueueMessageSchema)(
        message.body,
      );
      if (Exit.isFailure(result)) {
        console.error("Invalid R2 queue message body", {
          messageId: message.id,
          cause: String(result.cause),
          body: message.body,
        });
        message.ack();
        continue;
      }
      const notification = result.value;
      if (
        notification.action !== "PutObject" &&
        notification.action !== "DeleteObject" &&
        notification.action !== "LifecycleDeletion"
      ) {
        message.ack();
        continue;
      }
      if (notification.action === "PutObject") {
        const head = await env.R2.head(notification.object.key);
        if (!head) {
          console.warn(
            "R2 object deleted before notification processed:",
            notification.object.key,
          );
          message.ack();
          continue;
        }
        const organizationId = head.customMetadata?.organizationId;
        const name = head.customMetadata?.name;
        const idempotencyKey = head.customMetadata?.idempotencyKey;
        if (!organizationId || !name || !idempotencyKey) {
          console.error(
            "Missing customMetadata on R2 object:",
            notification.object.key,
          );
          message.ack();
          continue;
        }
        const stub = await getAgentByName(
          env.ORGANIZATION_AGENT,
          organizationId,
        );
        try {
          await stub.onUpload({
            name,
            eventTime: notification.eventTime,
            idempotencyKey,
            r2ObjectKey: notification.object.key,
          });
          message.ack();
        } catch (error) {
          const msg =
            error instanceof Error
              ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
              : String(error);
          console.error("queue onUpload failed", {
            key: notification.object.key,
            organizationId,
            name,
            idempotencyKey,
            error: msg,
          });
          message.retry();
        }
        continue;
      }
      const slashIndex = notification.object.key.indexOf("/");
      const organizationId =
        slashIndex > 0 ? notification.object.key.slice(0, slashIndex) : "";
      const name =
        slashIndex > 0 ? notification.object.key.slice(slashIndex + 1) : "";
      if (!organizationId || !name) {
        console.error("Invalid delete object key", {
          key: notification.object.key,
          action: notification.action,
        });
        message.ack();
        continue;
      }
      const stub = await getAgentByName(env.ORGANIZATION_AGENT, organizationId);
      try {
        await stub.onDelete({
          name,
          eventTime: notification.eventTime,
          action: notification.action,
          r2ObjectKey: notification.object.key,
        });
        message.ack();
      } catch (error) {
        const msg =
          error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
            : String(error);
        console.error("queue onDelete failed", {
          key: notification.object.key,
          organizationId,
          name,
          action: notification.action,
          error: msg,
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
