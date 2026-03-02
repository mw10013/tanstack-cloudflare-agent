import type { BetterAuthOptions } from "better-auth";
import { stripe as stripePlugin } from "@better-auth/stripe";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { admin, magicLink, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { Cause, Config, Data, Effect, Layer, Redacted, ServiceMap } from "effect";
import { D1 } from "./D1";
import { Stripe } from "./Stripe";
import { CloudflareEnv } from "./effect-services";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly op: string;
  readonly message: string;
  readonly cause: Error;
}> {}

const toCause = (error: unknown) =>
  Cause.isUnknownError(error) && error.cause instanceof Error
    ? error.cause
    : error instanceof Error
      ? error
      : new Error(String(error));

const tryAuth = <A>(op: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => {
      const cause = toCause(error);
      return new AuthError({ op, message: cause.message, cause });
    }),
  );

interface CreateBetterAuthOptions {
  db: D1Database;
  d1: D1["Service"];
  stripe: Stripe["Service"];
  runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  kv: KVNamespace;
  betterAuthUrl: string;
  betterAuthSecret: Redacted.Redacted;
  transactionalEmail: string;
  stripeWebhookSecret: Redacted.Redacted;
  databaseHookUserCreateAfter?: NonNullable<
    NonNullable<
      NonNullable<BetterAuthOptions["databaseHooks"]>["user"]
    >["create"]
  >["after"];
  databaseHookSessionCreateBefore?: NonNullable<
    NonNullable<
      NonNullable<BetterAuthOptions["databaseHooks"]>["session"]
    >["create"]
  >["before"];
}

const createBetterAuthOptions = ({
  db,
  d1,
  stripe,
  runEffect,
  kv,
  betterAuthUrl,
  betterAuthSecret,
  transactionalEmail,
  stripeWebhookSecret,
  databaseHookUserCreateAfter,
  databaseHookSessionCreateBefore,
}: CreateBetterAuthOptions) =>
  ({
    baseURL: betterAuthUrl,
    secret: Redacted.value(betterAuthSecret),
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    database: db,
    user: { modelName: "User" },
    session: { modelName: "Session", storeSessionInDatabase: true },
    account: {
      modelName: "Account",
      accountLinking: { enabled: true },
    },
    verification: { modelName: "Verification" },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          after:
            databaseHookUserCreateAfter ??
            ((user) => {
              console.log("databaseHooks.user.create.after", user);
              return Promise.resolve();
            }),
        },
      },
      session: {
        create: {
          before:
            databaseHookSessionCreateBefore ??
            ((session) => {
              console.log("databaseHooks.session.create.before", session);
              return Promise.resolve();
            }),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware((ctx) =>
        runEffect(
          Effect.gen(function* () {
            if (
              ctx.path === "/subscription/upgrade" ||
              ctx.path === "/subscription/billing-portal" ||
              ctx.path === "/subscription/cancel-subscription"
            ) {
              yield* Effect.sync(() => {
                console.log(`better-auth: hooks: before: ${ctx.path}`);
              });
              yield* stripe.ensureBillingPortalConfiguration();
            }
          }),
        ),
      ),
    },
    plugins: [
      magicLink({
        storeToken: "hashed",
        sendMagicLink: async (data) => {
          console.log("sendMagicLink", data);
          await kv.put("demo:magicLink", data.url, {
            expirationTtl: 60,
          });
          console.log(`Email would be sent to: ${data.email}`);
          console.log(`Subject: Your Magic Link`);
          console.log(`From: ${transactionalEmail}`);
          console.log(`Magic link URL: ${data.url}`);
        },
      }),
      admin(),
      organization({
        organizationLimit: 1,
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        schema: {
          organization: { modelName: "Organization" },
          member: { modelName: "Member" },
          invitation: { modelName: "Invitation" },
        },
        sendInvitationEmail: (data) => {
          const url = `${betterAuthUrl}/accept-invitation/${data.id}`;
          console.log(`Invitation email would be sent to: ${data.email}`);
          console.log(`Subject: You're invited!`);
          console.log(`From: ${transactionalEmail}`);
          console.log(`Invitation URL: ${url}`);
          return Promise.resolve();
        },
      }),
      stripePlugin({
        stripeClient: stripe.stripe,
        stripeWebhookSecret: Redacted.value(stripeWebhookSecret),
        createCustomerOnSignUp: false,
        subscription: {
          enabled: true,
          requireEmailVerification: true,
          plans: () =>
            runEffect(
              Effect.map(stripe.getPlans(), (plans) =>
                plans.map((plan) => ({
                  name: plan.name,
                  priceId: plan.monthlyPriceId,
                  annualDiscountPriceId: plan.annualPriceId,
                  freeTrial: {
                    days: plan.freeTrialDays,
                    onTrialStart: (subscription) => {
                      console.log(
                        `stripe plugin: onTrialStart: ${plan.name} plan trial started for subscription ${subscription.id}`,
                      );
                      return Promise.resolve();
                    },
                    onTrialEnd: ({ subscription }) => {
                      console.log(
                        `stripe plugin: onTrialEnd: ${plan.name} plan trial ended for subscription ${subscription.id}`,
                      );
                      return Promise.resolve();
                    },
                    onTrialExpired: (subscription) => {
                      console.log(
                        `stripe plugin: onTrialExpired: ${plan.name} plan trial expired for subscription ${subscription.id}`,
                      );
                      return Promise.resolve();
                    },
                  },
                })),
              ),
            ),
          authorizeReference: ({ user, referenceId, action }) =>
            runEffect(
              Effect.gen(function* () {
                const result = Boolean(
                  yield* d1.first(
                    d1
                      .prepare(
                        "select 1 from Member where userId = ? and organizationId = ? and role = 'owner'",
                      )
                      .bind(user.id, referenceId),
                  ),
                );
                yield* Effect.sync(() => {
                  console.log(
                    `stripe plugin: authorizeReference: user ${user.id} is attempting to ${action} subscription for referenceId ${referenceId}, authorized: ${String(result)}`,
                  );
                });
                return result;
              }),
            ),
          onSubscriptionComplete: ({ subscription, plan }) => {
            console.log(
              `stripe plugin: onSubscriptionComplete: subscription ${subscription.id} completed for plan ${plan.name}`,
            );
            return Promise.resolve();
          },
          onSubscriptionUpdate: ({ subscription }) => {
            console.log(
              `stripe plugin: onSubscriptionUpdate: subscription ${subscription.id} updated`,
            );
            return Promise.resolve();
          },
          onSubscriptionCancel: ({ subscription }) => {
            console.log(
              `stripe plugin: onSubscriptionCancel: subscription ${subscription.id} canceled`,
            );
            return Promise.resolve();
          },
          onSubscriptionDeleted: ({ subscription }) => {
            console.log(
              `stripe plugin: onSubscriptionDeleted: subscription ${subscription.id} deleted`,
            );
            return Promise.resolve();
          },
        },
        organization: {
          enabled: true,
          getCustomerCreateParams: (_organization, ctx) => {
            const userEmail = ctx.context.session?.user.email;
            return Promise.resolve(userEmail ? { email: userEmail } : {});
          },
        },
        schema: {
          subscription: {
            modelName: "Subscription",
          },
        },
        onCustomerCreate: ({ stripeCustomer, user }) => {
          console.log(
            `stripe plugin: onCustomerCreate: customer ${stripeCustomer.id} created for user ${user.email}`,
          );
          return Promise.resolve();
        },
        onEvent: (event) => {
          console.log(
            `stripe plugin: onEvent: stripe event received: ${event.type}`,
          );
          return Promise.resolve();
        },
      }),
      tanstackStartCookies(),
    ],
  }) satisfies BetterAuthOptions;

type BetterAuthInstance = ReturnType<
  typeof betterAuth<ReturnType<typeof createBetterAuthOptions>>
>;

export class Auth extends ServiceMap.Service<Auth>()("Auth", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;
    const stripe = yield* Stripe;
    const runEffect: CreateBetterAuthOptions["runEffect"] = Effect.runPromise;
    const authConfig = yield* Config.all({
      betterAuthUrl: Config.nonEmptyString("BETTER_AUTH_URL"),
      betterAuthSecret: Config.redacted("BETTER_AUTH_SECRET"),
      transactionalEmail: Config.nonEmptyString("TRANSACTIONAL_EMAIL"),
      stripeWebhookSecret: Config.redacted("STRIPE_WEBHOOK_SECRET"),
    });
    const { KV, D1: db } = yield* CloudflareEnv;

    const auth: BetterAuthInstance = betterAuth(
      createBetterAuthOptions({
        db,
        d1,
        stripe,
        runEffect,
        kv: KV,
        betterAuthUrl: authConfig.betterAuthUrl,
        betterAuthSecret: authConfig.betterAuthSecret,
        transactionalEmail: authConfig.transactionalEmail,
        stripeWebhookSecret: authConfig.stripeWebhookSecret,
        databaseHookUserCreateAfter: (user) =>
          runEffect(
            Effect.gen(function* () {
              if (user.role !== "user") return;
              const org = yield* Effect.tryPromise(() =>
                auth.api.createOrganization({
                  body: {
                    name: `${user.email.charAt(0).toUpperCase() + user.email.slice(1)}'s Organization`,
                    slug: user.email.replace(/[^a-z0-9]/g, "-").toLowerCase(),
                    userId: user.id,
                  },
                }),
              );
              yield* d1.run(
                d1
                  .prepare(
                    "update Session set activeOrganizationId = ? where userId = ? and activeOrganizationId is null",
                  )
                  .bind(org.id, user.id),
              );
            }),
          ),
        databaseHookSessionCreateBefore: (session) =>
          runEffect(
            Effect.gen(function* () {
              const activeOrganization = yield* d1.first<{ id: string }>(
                d1
                  .prepare(
                    "select id from Organization where id in (select organizationId from Member where userId = ? and role = 'owner')",
                  )
                  .bind(session.userId),
              );
              return {
                data: {
                  ...session,
                  activeOrganizationId: activeOrganization?.id ?? undefined,
                },
              };
            }),
          ),
      }),
    );

    return {
      auth,
      api: auth.api,
      handler: (request: Request) => tryAuth("Auth.handler", () => auth.handler(request)),
      getSession: (headers: Headers) =>
        tryAuth("Auth.api.getSession", () => auth.api.getSession({ headers })),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

export type AuthTypes = ReturnType<
  typeof betterAuth<ReturnType<typeof createBetterAuthOptions>>
>;

export const signOutServerFn = createServerFn({ method: "POST" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = getRequest();
        const auth = yield* Auth;
        yield* Effect.tryPromise(() =>
          auth.api.signOut({ headers: request.headers }),
        );
        return yield* Effect.die(redirect({ to: "/" }));
      }),
    ),
);
