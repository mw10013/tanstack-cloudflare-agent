import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Config, Effect } from "effect";
import { Greeting } from "@/lib/effect-services";

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const greeting = yield* Greeting;
        const environment = yield* Config.nonEmptyString("ENVIRONMENT");
        return { greeting: greeting.greet(), environment };
      }),
    ),
);

export const Route = createFileRoute("/app/$organizationId/effect")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { greeting, environment } = Route.useLoaderData();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Effect Spike</h1>
      <p className="mt-4 text-lg">{greeting}</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Environment: {environment}
      </p>
    </div>
  );
}
