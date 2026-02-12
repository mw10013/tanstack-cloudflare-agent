import type { OrganizationAgent, OrganizationMessage } from "@/organization-agent";
import { organizationMessageSchema } from "@/organization-agent";
import { invariant } from "@epic-web/invariant";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useAgent } from "agents/react";
import { AlertCircle, Check, CircleDot, Info, MessageSquare, XCircle } from "lucide-react";
import * as React from "react";
import * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const organizationIdSchema = z.object({
  organizationId: z.string().min(1),
});

const uploadFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  file: z
    .file()
    .min(1, "File is required")
    .max(5_000_000, "File must be under 5MB")
    .mime(["image/png", "image/jpeg", "application/pdf"]),
});

const uploadFile = createServerFn({ method: "POST" })
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new Error("Expected FormData");
    return z
      .object({
        name: z.string().trim().min(1),
        file: z
          .file()
          .max(5_000_000)
          .mime(["image/png", "image/jpeg", "application/pdf"]),
      })
      .parse(Object.fromEntries(data));
  })
  .handler(async ({ context: { session, env }, data }) => {
    invariant(session, "Missing session");
    const organizationId = session.session.activeOrganizationId;
    invariant(organizationId, "Missing active organization");
    const key = `${organizationId}/${data.name}`;
    await env.R2.put(key, data.file, {
      httpMetadata: { contentType: data.file.type },
      customMetadata: { organizationId, name: data.name },
    });
    if (env.ENVIRONMENT === "local") {
      await env.R2_UPLOAD_QUEUE.send({
        account: "local",
        action: "PutObject",
        bucket: "uploads",
        object: { key, size: data.file.size, eTag: "local" },
        eventTime: new Date().toISOString(),
      });
    }
    return { success: true, name: data.name, size: data.file.size };
  });

const getUploads = createServerFn({ method: "GET" })
  .inputValidator(organizationIdSchema)
  .handler(async ({ context: { session, env }, data: { organizationId } }) => {
    invariant(session, "Missing session");
    invariant(
      session.session.activeOrganizationId === organizationId,
      "Organization mismatch",
    );
    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);
    return (await stub.getUploads()) as unknown as {
      name: string;
      createdAt: number;
    }[];
  });

export const Route = createFileRoute("/app/$organizationId/upload")({
  loader: ({ params: data }) => getUploads({ data }),
  component: RouteComponent,
});

function RouteComponent() {
  const { organizationId } = Route.useParams();
  const isHydrated = useHydrated();
  const uploads = Route.useLoaderData();
  const router = useRouter();
  const [messages, setMessages] = React.useState<OrganizationMessage[]>([]);

  useAgent<OrganizationAgent, unknown>({
    agent: "organization-agent",
    name: organizationId,
    onMessage: (event) => {
      const result = organizationMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!result.success) return;
      setMessages((prev) => [result.data, ...prev]);
      if (result.data.type === "upload_complete") {
        void router.invalidate();
      }
    },
  });
  const uploadServerFn = useServerFn(uploadFile);
  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
    onSuccess: () => {
      form.reset();
      void router.invalidate();
    },
  });

  const form = useForm({
    defaultValues: {
      name: "",
      file: null as File | null,
    },
    validators: {
      onSubmit: uploadFormSchema,
    },
    onSubmit: ({ value }) => {
      const fd = new FormData();
      fd.append("name", value.name);
      if (value.file) fd.append("file", value.file);
      uploadMutation.mutate(fd);
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Upload</h1>
        <p className="text-muted-foreground">
          Upload images or PDF documents (max 5MB)
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload File</CardTitle>
          <CardDescription>
            Select a PNG, JPEG, or PDF file to upload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              {uploadMutation.error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    {uploadMutation.error.message}
                  </AlertDescription>
                </Alert>
              )}
              {uploadMutation.isSuccess && (
                <Alert>
                  <AlertTitle>Uploaded</AlertTitle>
                  <AlertDescription>
                    {uploadMutation.data.name} (
                    {Math.round(uploadMutation.data.size / 1024)} KB)
                  </AlertDescription>
                </Alert>
              )}
              <form.Field
                name="name"
                children={(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                        }}
                        placeholder="Document name"
                        aria-invalid={isInvalid}
                        disabled={!isHydrated || uploadMutation.isPending}
                      />
                      {isInvalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </Field>
                  );
                }}
              />
              <form.Field
                name="file"
                children={(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>File</FieldLabel>
                      <Input
                        id={field.name}
                        type="file"
                        accept="image/png,image/jpeg,application/pdf"
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.files?.[0] ?? null);
                        }}
                        aria-invalid={isInvalid}
                        disabled={!isHydrated || uploadMutation.isPending}
                      />
                      {isInvalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </Field>
                  );
                }}
              />
              <form.Subscribe
                selector={(state) => state.canSubmit}
                children={(canSubmit) => (
                  <Button
                    type="submit"
                    disabled={
                      !canSubmit || !isHydrated || uploadMutation.isPending
                    }
                    className="self-end"
                  >
                    {uploadMutation.isPending ? "Uploading..." : "Upload"}
                  </Button>
                )}
              />
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {uploads.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Uploads</CardTitle>
            <CardDescription>
              {uploads.length} file{uploads.length !== 1 && "s"} uploaded
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {uploads.map((upload) => (
                <li
                  key={upload.name}
                  className="flex items-center justify-between py-2"
                >
                  <span className="font-medium">{upload.name}</span>
                  <span className="text-muted-foreground text-sm">
                    {new Date(upload.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Messages messages={messages} />
    </div>
  );
}

function Messages({ messages }: { messages: OrganizationMessage[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-5" />
          Messages
        </CardTitle>
        <CardDescription>Real-time events from the agent</CardDescription>
      </CardHeader>
      <CardContent>
        {messages.length === 0 ? (
          <p className="text-muted-foreground text-sm">No messages yet</p>
        ) : (
          <ul className="divide-y">
            {messages.map((msg, i) => (
              <li key={i} className="flex items-center gap-3 py-2">
                <MessageIcon type={msg.type} />
                <span className="text-sm">{formatMessage(msg)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MessageIcon({ type }: { type: OrganizationMessage["type"] }) {
  switch (type) {
    case "upload_complete":
      return <Check className="text-green-600 size-4" />;
    case "upload_error":
      return <XCircle className="text-destructive size-4" />;
    case "workflow_progress":
      return <CircleDot className="text-yellow-600 size-4" />;
    case "workflow_complete":
      return <Check className="text-green-600 size-4" />;
    case "workflow_error":
      return <XCircle className="text-destructive size-4" />;
    case "approval_requested":
      return <Info className="text-blue-600 size-4" />;
  }
}

function formatMessage(msg: OrganizationMessage): string {
  switch (msg.type) {
    case "upload_complete":
      return `${msg.name} uploaded`;
    case "upload_error":
      return `${msg.name} failed: ${msg.error}`;
    case "workflow_progress":
      return msg.progress.message;
    case "workflow_complete":
      return `Workflow ${msg.result?.approved ? "approved" : "completed"}`;
    case "workflow_error":
      return `Workflow error: ${msg.error}`;
    case "approval_requested":
      return `Approval requested: ${msg.title}`;
  }
}
