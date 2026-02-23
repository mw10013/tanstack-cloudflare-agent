import { ConfigProvider, Effect, ServiceMap } from "effect";

export const CloudflareEnv = ServiceMap.Service<Env>("CloudflareEnv");

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

export const makeRunEffect = (env: Env) =>
  Effect.runPromiseWith(
    ServiceMap.make(CloudflareEnv, env)
      .pipe(ServiceMap.add(Greeting, { greet: () => "Hello from Effect 4 ServiceMap!" }))
      .pipe(ServiceMap.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))),
  );

export type RunEffect = ReturnType<typeof makeRunEffect>;
