import { Effect, ServiceMap } from "effect";

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

export const makeAppServiceMap = (impls: {
  readonly greeting: typeof Greeting.Service;
}) =>
  ServiceMap.make(Greeting, impls.greeting);

export const makeRunEffect = (
  ...args: Parameters<typeof makeAppServiceMap>
) => Effect.runPromiseWith(makeAppServiceMap(...args));

export type RunEffect = ReturnType<typeof makeRunEffect>;
