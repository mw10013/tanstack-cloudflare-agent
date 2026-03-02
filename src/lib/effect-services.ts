import { isNotFound, isRedirect } from "@tanstack/react-router";
import { Cause, ConfigProvider, Effect, Exit, Layer, ServiceMap } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Auth } from "./Auth";
import { D1 } from "./D1";
import { Repository } from "./Repository";
import { Stripe } from "./Stripe";

export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

const makeAppLayer = (env: Env) => {
  const envLayer = Layer.succeedServices(
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
  );
  const runtimeLayer = Layer.provideMerge(FetchHttpClient.layer, envLayer);
  const d1Layer = Layer.provideMerge(D1.layer, runtimeLayer);
  const repositoryLayer = Layer.provideMerge(Repository.layer, d1Layer);
  const stripeLayer = Layer.provideMerge(Stripe.layer, repositoryLayer);
  return Layer.provideMerge(Auth.layer, stripeLayer);
};

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
 *
 * **Error message preservation:** TanStack Router's `ShallowErrorPlugin`
 * (seroval plugin used during SSR dehydration) serializes ONLY `.message`
 * from Error objects — `.name`, `._tag`, `.stack`, and all custom properties
 * are stripped. On the client it reconstructs `new Error(message)`. Effect v4
 * errors like `NoSuchElementError` set `.name` on the prototype and often
 * have `.message = undefined` (own property via `Object.assign`), so after
 * dehydration the client receives a bare `Error` with an empty message.
 * To ensure the error boundary always has something meaningful to display,
 * we normalize the thrown Error to always carry a non-empty `.message`,
 * using `Cause.pretty` which includes the error name and server-side stack
 * trace. This causes some duplication in the browser (the client-generated
 * `.stack` echoes `.message` in V8 environments) but preserves the full
 * server context that would otherwise be lost after `ShallowErrorPlugin`
 * strips everything except `.message`.
 */
export const makeRunEffect = (env: Env) => {
  const appLayer = makeAppLayer(env);
  return async <A, E>(effect: Effect.Effect<A, E, AppR>): Promise<A> => {
    const exit = await Effect.runPromiseExit(Effect.provide(effect, appLayer));
    if (Exit.isSuccess(exit)) return exit.value;
    const squashed = Cause.squash(exit.cause);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- redirect is a Response, notFound is a plain object; TanStack expects these thrown as-is
    if (isRedirect(squashed) || isNotFound(squashed)) throw squashed;
    const pretty = Cause.pretty(exit.cause);
    if (squashed instanceof Error) {
      if (!squashed.message) squashed.message = pretty;
      throw squashed;
    }
    throw new Error(pretty);
  };
};

export type RunEffect = ReturnType<typeof makeRunEffect>;
