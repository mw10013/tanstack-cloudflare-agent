import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { Stripe } from "@/lib/Stripe";

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const stripe = yield* Stripe;
        const plans = yield* stripe.getPlans();
        return { plans, count: plans.length };
      }),
    ),
);

export const Route = createFileRoute("/app/$organizationId/stripe")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { plans, count } = Route.useLoaderData();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Effect Stripe</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {String(count)} plans from Stripe/KV
      </p>
      <pre className="bg-muted mt-4 overflow-auto rounded p-4 text-sm">
        {JSON.stringify(plans, null, 2)}
      </pre>
    </div>
  );
}
