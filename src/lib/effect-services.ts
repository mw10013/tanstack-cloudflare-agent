import { Effect, ServiceMap } from "effect";

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

export const makeRunEffect = () =>
  Effect.runPromiseWith(
    ServiceMap.make(Greeting, { greet: () => "Hello from Effect 4 ServiceMap!" }),
  );

export type RunEffect = ReturnType<typeof makeRunEffect>;
