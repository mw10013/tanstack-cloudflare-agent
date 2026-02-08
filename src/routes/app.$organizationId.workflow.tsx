import type {
  ApprovalRequestInfo,
  OrganizationAgent,
} from "@/organization-agent";
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import { Check, Play, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const getLoaderData = createServerFn({ method: "GET" })
  .inputValidator((organizationId: string) => organizationId)
  .handler(async ({ context: { env }, data: organizationId }) => {
    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);
    return { requests: await stub.listApprovalRequests() };
  });

const requestApprovalFn = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { organizationId: string; title: string; description: string }) =>
      data,
  )
  .handler(
    async ({
      context: { env },
      data: { organizationId, title, description },
    }): Promise<ApprovalRequestInfo> => {
      const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
      const stub = env.ORGANIZATION_AGENT.get(id);
      const { [Symbol.dispose]: _, ...result } = await stub.requestApproval(
        title,
        description,
      );
      return result;
    },
  );

const approveRequestFn = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { organizationId: string; workflowId: string }) => data,
  )
  .handler(
    async ({ context: { env }, data: { organizationId, workflowId } }) => {
      const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
      const stub = env.ORGANIZATION_AGENT.get(id);
      return stub.approveRequest(workflowId) as Promise<boolean>;
    },
  );

const rejectRequestFn = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { organizationId: string; workflowId: string }) => data,
  )
  .handler(
    async ({ context: { env }, data: { organizationId, workflowId } }) => {
      const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
      const stub = env.ORGANIZATION_AGENT.get(id);
      return stub.rejectRequest(workflowId) as Promise<boolean>;
    },
  );

export const Route = createFileRoute("/app/$organizationId/workflow")({
  loader: ({ params }) => getLoaderData({ data: params.organizationId }),
  component: RouteComponent,
});

const statusConfig = {
  pending: {
    label: "Pending",
    variant: "secondary" as const,
    className: "bg-yellow-500/10 text-yellow-700",
  },
  approved: {
    label: "Approved",
    variant: "secondary" as const,
    className: "bg-green-500/10 text-green-700",
  },
  rejected: {
    label: "Rejected",
    variant: "destructive" as const,
    className: "bg-red-500/10 text-red-700",
  },
} as const;

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const { requests } = Route.useLoaderData();
  const isHydrated = useHydrated();
  const router = useRouter();

  useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
    onMessage: (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { type?: string };
        if (
          data.type === "workflow_progress" ||
          data.type === "workflow_complete" ||
          data.type === "workflow_error" ||
          data.type === "approval_requested"
        ) {
          void router.invalidate();
        }
      } catch {
        // ignore non-JSON messages
      }
    },
  });

  const requestApprovalServerFn = useServerFn(requestApprovalFn);
  const approveRequestServerFn = useServerFn(approveRequestFn);
  const rejectRequestServerFn = useServerFn(rejectRequestFn);

  const requestMutation = useMutation<
    ApprovalRequestInfo,
    Error,
    { title: string; description: string }
  >({
    mutationFn: ({ title, description }) =>
      requestApprovalServerFn({ data: { organizationId, title, description } }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const approveMutation = useMutation<boolean, Error, string>({
    mutationFn: (workflowId) =>
      approveRequestServerFn({ data: { organizationId, workflowId } }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const rejectMutation = useMutation<boolean, Error, string>({
    mutationFn: (workflowId) =>
      rejectRequestServerFn({ data: { organizationId, workflowId } }),
    onSuccess: () => {
      void router.invalidate();
    },
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    const title = (formData.get("title") as string | null)?.trim() ?? "";
    const description =
      (formData.get("description") as string | null)?.trim() ?? "";
    if (!title) return;
    requestMutation.mutate({ title, description });
    form.reset();
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Workflow</h1>
        <p className="text-muted-foreground">
          Start approval workflows and manage pending requests
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Approval Request</CardTitle>
          <CardDescription>
            Start a workflow that requires human approval
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex gap-3">
            <Input
              name="title"
              placeholder="Title"
              required
              disabled={!isHydrated || requestMutation.isPending}
            />
            <Input
              name="description"
              placeholder="Description"
              disabled={!isHydrated || requestMutation.isPending}
            />
            <Button
              type="submit"
              disabled={!isHydrated || requestMutation.isPending}
            >
              {requestMutation.isPending ? (
                <Spinner className="mr-2 h-4 w-4" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Start
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Approval Requests</h2>
        {requests.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No approval requests yet
          </p>
        ) : (
          <div className="grid gap-3">
            {requests.map((req) => (
              <Card key={req.id}>
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{req.title}</span>
                      <Badge className={statusConfig[req.status].className}>
                        {statusConfig[req.status].label}
                      </Badge>
                    </div>
                    {req.description && (
                      <span className="text-muted-foreground text-sm">
                        {req.description}
                      </span>
                    )}
                    <span className="text-muted-foreground text-xs">
                      {req.id.slice(0, 12)}… · {req.createdAt}
                    </span>
                    {req.reason && (
                      <span className="text-destructive text-xs">
                        {req.reason}
                      </span>
                    )}
                  </div>
                  {req.status === "pending" && (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          approveMutation.isPending || rejectMutation.isPending
                        }
                        onClick={() => {
                          approveMutation.mutate(req.id);
                        }}
                      >
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          approveMutation.isPending || rejectMutation.isPending
                        }
                        onClick={() => {
                          rejectMutation.mutate(req.id);
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
