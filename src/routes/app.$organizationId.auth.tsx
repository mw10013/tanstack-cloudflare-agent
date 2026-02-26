import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { Auth } from "@/lib/Auth";

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const request = getRequest();
        const session = yield* auth.getSession(request.headers);
        return { session };
      }),
    ),
);

export const Route = createFileRoute("/app/$organizationId/auth")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { session } = Route.useLoaderData();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Effect Auth</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {session ? `Signed in as ${session.user.email}` : "No active session"}
      </p>
      <pre className="bg-muted mt-4 overflow-auto rounded p-4 text-sm">
        {JSON.stringify(session, null, 2)}
      </pre>
    </div>
  );
}
