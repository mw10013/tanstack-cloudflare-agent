import type { Effect } from "effect";
import { ServiceMap } from "effect";

export const Greeting = ServiceMap.Service<{
  readonly greet: () => string;
}>("Greeting");

export type AppServices = typeof Greeting.Identifier;

export type RunEffect = <A, E>(
  effect: Effect.Effect<A, E, AppServices>,
) => Promise<A>;
