import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { D1 } from "@/lib/D1";

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const d1 = yield* D1;
        const stmt = d1.prepare("select id, name, email, role from User");
        const result = yield* d1.run<{
          id: string;
          name: string;
          email: string;
          role: string;
        }>(stmt);
        return {
          rows: result.results,
          rowsRead: result.meta.rows_read,
          duration: result.meta.duration,
        };
      }),
    ),
);

export const Route = createFileRoute("/app/$organizationId/d1")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { rows, rowsRead, duration } = Route.useLoaderData();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">D1 Spike</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {String(rowsRead)} rows read, {String(duration)}ms
      </p>
      <pre className="bg-muted mt-4 overflow-auto rounded p-4 text-sm">
        {JSON.stringify(rows, null, 2)}
      </pre>
    </div>
  );
}
