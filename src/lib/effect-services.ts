import { ConfigProvider, Effect, Layer, ServiceMap } from "effect";
import { D1 } from "./D1";
import { Repository } from "./Repository";

export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

const makeAppLayer = (env: Env) =>
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
  );

type AppLayer = ReturnType<typeof makeAppLayer>;
type AppR = Layer.Success<AppLayer>;

export const makeRunEffect = (env: Env) => {
  const appLayer = makeAppLayer(env);
  return <A, E>(effect: Effect.Effect<A, E, AppR>) =>
    Effect.runPromise(Effect.provide(effect, appLayer));
};

export type RunEffect = ReturnType<typeof makeRunEffect>;
