import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Option } from "effect";
import { Repository } from "@/lib/Repository";

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const [usersResult, adminData, testUser] = yield* Effect.all([
          repo.getUsers({ limit: 10, offset: 0 }),
          repo.getAdminDashboardData(),
          repo.getUser("u@u.com"),
        ]);
        return {
          users: usersResult.users,
          userCount: usersResult.count,
          adminData,
          testUser: Option.getOrNull(testUser),
        };
      }),
    ),
);

export const Route = createFileRoute("/app/$organizationId/repository")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { users, userCount, adminData, testUser } = Route.useLoaderData();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Effect Repository</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {String(userCount)} total users | {String(adminData.customerCount)}{" "}
        customers | {String(adminData.activeSubscriptionCount)} active
        subscriptions | {String(adminData.trialingSubscriptionCount)} trialing
      </p>
      {testUser && (
        <div className="bg-muted mt-4 rounded p-4 text-sm">
          <h2 className="font-semibold">Test User (u@u.com)</h2>
          <pre className="mt-2 overflow-auto">
            {JSON.stringify(testUser, null, 2)}
          </pre>
        </div>
      )}
      <div className="mt-4">
        <h2 className="text-lg font-semibold">Users (first 10)</h2>
        <pre className="bg-muted mt-2 overflow-auto rounded p-4 text-sm">
          {JSON.stringify(users, null, 2)}
        </pre>
      </div>
    </div>
  );
}
