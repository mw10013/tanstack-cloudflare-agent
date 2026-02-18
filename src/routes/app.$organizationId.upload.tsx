import type { OrganizationAgent } from "@/organization-agent";
import {
  organizationMessageSchema,
  type OrganizationMessage,
} from "@/organization-messages";
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
import {
  AlertCircle,
  Check,
  CircleDot,
  Info,
  MessageSquare,
  XCircle,
} from "lucide-react";
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

const uploadNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .regex(/^[A-Za-z0-9_-]+$/, "Name can only contain letters, numbers, underscores, and hyphens");

const imageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const uploadFormSchema = z.object({
  name: uploadNameSchema,
  file: z
    .file()
    .min(1, "File is required")
    .max(5_000_000, "File must be under 5MB")
    .mime(imageMimeTypes),
});

const deleteUploadSchema = z.object({
  name: uploadNameSchema,
});

const uploadFile = createServerFn({ method: "POST" })
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new Error("Expected FormData");
    return z
      .object({
        name: uploadNameSchema,
        file: z.file().max(5_000_000).mime(imageMimeTypes),
      })
      .parse(Object.fromEntries(data));
  })
  .handler(async ({ context: { session, env }, data }) => {
    invariant(session, "Missing session");
    const organizationId = session.session.activeOrganizationId;
    invariant(organizationId, "Missing active organization");
    const key = `${organizationId}/${data.name}`;
    const idempotencyKey = crypto.randomUUID();
    await env.R2.put(key, data.file, {
      httpMetadata: { contentType: data.file.type },
      customMetadata: { organizationId, name: data.name, idempotencyKey },
    });
    if (env.ENVIRONMENT === "local") {
      await env.R2_UPLOAD_QUEUE.send({
        account: "local",
        action: "PutObject",
        bucket: env.R2_BUCKET_NAME,
        object: { key, size: data.file.size, eTag: "local" },
        eventTime: new Date().toISOString(),
        idempotencyKey,
      });
    }
    return { success: true, name: data.name, size: data.file.size, idempotencyKey };
  });

const deleteUpload = createServerFn({ method: "POST" })
  .inputValidator(deleteUploadSchema)
  .handler(async ({ context: { session, env }, data }) => {
    invariant(session, "Missing session");
    const organizationId = session.session.activeOrganizationId;
    invariant(organizationId, "Missing active organization");
    const key = `${organizationId}/${data.name}`;
    await env.R2.delete(key);
    if (env.ENVIRONMENT === "local") {
      await env.R2_UPLOAD_QUEUE.send({
        account: "local",
        action: "DeleteObject",
        bucket: env.R2_BUCKET_NAME,
        object: { key },
        eventTime: new Date().toISOString(),
      });
    }
    return { success: true, name: data.name };
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
    const uploads = await stub.getUploads();
    if (env.ENVIRONMENT === "local") {
      return uploads.map((upload) => ({
        ...upload,
        thumbnailUrl: `/api/org/${organizationId}/upload-image/${encodeURIComponent(upload.name)}`,
      }));
    }
    invariant(env.R2_BUCKET_NAME, "Missing R2_BUCKET_NAME");
    invariant(env.R2_S3_ACCESS_KEY_ID, "Missing R2_S3_ACCESS_KEY_ID");
    invariant(env.R2_S3_SECRET_ACCESS_KEY, "Missing R2_S3_SECRET_ACCESS_KEY");
    const { AwsClient } = await import("aws4fetch");
    const client = new AwsClient({
      service: "s3",
      region: "auto",
      accessKeyId: env.R2_S3_ACCESS_KEY_ID,
      secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY,
    });
    return Promise.all(
      uploads.map(async (upload) => {
        const signed = await client.sign(
          new Request(
            `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${organizationId}/${upload.name}?X-Amz-Expires=900`,
            { method: "GET" },
          ),
          { aws: { signQuery: true } },
        );
        return {
          ...upload,
          thumbnailUrl: signed.url,
        };
      }),
    );
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
      if (result.data.type !== "upload_deleted") {
        setMessages((prev) => [result.data, ...prev]);
      }
      if (
        result.data.type === "upload_deleted" ||
        result.data.type === "classification_updated" ||
        result.data.type === "classification_error"
      ) {
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
  const deleteUploadServerFn = useServerFn(deleteUpload);
  const deleteMutation = useMutation({
    mutationFn: ({ name }: { name: string }) => deleteUploadServerFn({ data: { name } }),
    onSuccess: () => {
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
          Upload images (PNG, JPEG, WEBP, GIF) up to 5MB.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Upload Image</CardTitle>
            <CardDescription>
              Use letters, numbers, underscores, or hyphens for names.
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
                          placeholder="hero_image"
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
                          accept="image/png,image/jpeg,image/webp,image/gif"
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

        <Messages messages={messages} />
      </div>

      {uploads.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Uploads</CardTitle>
            <CardDescription>
              {uploads.length} image{uploads.length !== 1 && "s"} uploaded
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {uploads.map((upload) => (
                <div
                  key={upload.name}
                  className="bg-muted/20 flex items-center gap-3 rounded-md border p-3"
                >
                  <div className="bg-muted/40 flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border">
                    <img
                      src={upload.thumbnailUrl}
                      alt={upload.name}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{upload.name}</p>
                    <p className="text-muted-foreground text-xs">{new Date(upload.createdAt).toLocaleString()}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {upload.classificationLabel
                        ? `${upload.classificationLabel} (${String(Math.round((upload.classificationScore ?? 0) * 100))}%)`
                        : "Classifying..."}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        deleteMutation.mutate({ name: upload.name });
                      }}
                      disabled={deleteMutation.isPending}
                      className="mt-2"
                    >
                      {deleteMutation.isPending ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
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
    case "upload_error":
      return <XCircle className="text-destructive size-4" />;
    case "upload_deleted":
      return <Info className="text-blue-600 size-4" />;
    case "workflow_progress":
      return <CircleDot className="text-yellow-600 size-4" />;
    case "workflow_complete":
      return <Check className="text-green-600 size-4" />;
    case "workflow_error":
      return <XCircle className="text-destructive size-4" />;
    case "approval_requested":
      return <Info className="text-blue-600 size-4" />;
    case "classification_workflow_started":
      return <CircleDot className="text-yellow-600 size-4" />;
    case "classification_updated":
      return <Check className="text-green-600 size-4" />;
    case "classification_error":
      return <XCircle className="text-destructive size-4" />;
  }
}

function formatMessage(msg: OrganizationMessage): string {
  switch (msg.type) {
    case "upload_error":
      return `${msg.name} failed: ${msg.error}`;
    case "upload_deleted":
      return `${msg.name} deleted`;
    case "workflow_progress":
      return msg.progress.message;
    case "workflow_complete":
      return `Workflow ${msg.result?.approved ? "approved" : "completed"}`;
    case "workflow_error":
      return `Workflow error: ${msg.error}`;
    case "approval_requested":
      return `Approval requested: ${msg.title}`;
    case "classification_workflow_started":
      return `Classification started: ${msg.name}`;
    case "classification_updated":
      return `${msg.name}: ${msg.label} (${String(Math.round(msg.score * 100))}%)`;
    case "classification_error":
      return `Classification error: ${msg.name} - ${msg.error}`;
  }
}
