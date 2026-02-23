import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { Greeting } from "@/lib/effect-services";

const getGreeting = Effect.gen(function* () {
  const greeting = yield* Greeting;
  return greeting.greet();
});

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) => runEffect(getGreeting),
);

export const Route = createFileRoute("/app/$organizationId/effect")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const greeting = Route.useLoaderData();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Effect Spike</h1>
      <p className="mt-4 text-lg">{greeting}</p>
    </div>
  );
}
