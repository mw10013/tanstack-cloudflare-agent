import { isNotFound, isRedirect } from "@tanstack/react-router";
import { Cause, ConfigProvider, Effect, Exit, Layer, ServiceMap } from "effect";
import { Auth } from "./Auth";
import { D1 } from "./D1";
import { Repository } from "./Repository";
import { Stripe } from "./Stripe";

export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

const makeAppLayer = (env: Env) =>
  Layer.provideMerge(
    Auth.layer,
    Layer.provideMerge(
      Stripe.layer,
      Layer.provideMerge(
        Repository.layer,
        Layer.provideMerge(
          D1.layer,
          Layer.succeedServices(
            ServiceMap.make(CloudflareEnv, env)
              .pipe(
                ServiceMap.add(Greeting, {
                  greet: () => "Hello from Effect 4 ServiceMap!",
                }),
              )
              .pipe(
                ServiceMap.add(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromUnknown(env),
                ),
              ),
          ),
        ),
      ),
    ),
  );

type AppLayer = ReturnType<typeof makeAppLayer>;
type AppR = Layer.Success<AppLayer>;

/**
 * Runs an Effect within the app layer, converting failures to throwable values
 * compatible with TanStack Start's server function error serialization.
 *
 * Uses `runPromiseExit` instead of `runPromise` to inspect the `Exit` and
 * ensure the thrown value is always an `Error` instance (which TanStack Start
 * can serialize via seroval). Raw non-Error values from `Effect.fail` would
 * otherwise pass through `causeSquash` unboxed and fail the client-side
 * `instanceof Error` check, producing an opaque "unexpected error" message.
 *
 * TanStack `redirect`/`notFound` objects placed in the defect channel via
 * `Effect.die` are detected and re-thrown as-is so TanStack's control flow
 * (HTTP 307 redirects, 404 not-found handling) works from within Effect
 * pipelines.
 */
export const makeRunEffect = (env: Env) => {
  const appLayer = makeAppLayer(env);
  return async <A, E>(effect: Effect.Effect<A, E, AppR>): Promise<A> => {
    const exit = await Effect.runPromiseExit(Effect.provide(effect, appLayer));
    if (Exit.isSuccess(exit)) return exit.value;
    const squashed = Cause.squash(exit.cause);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- redirect is a Response, notFound is a plain object; TanStack expects these thrown as-is
    if (isRedirect(squashed) || isNotFound(squashed)) throw squashed;
    throw squashed instanceof Error
      ? squashed
      : new Error(Cause.pretty(exit.cause));
  };
};

export type RunEffect = ReturnType<typeof makeRunEffect>;
