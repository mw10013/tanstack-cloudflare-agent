import { invariant } from "@epic-web/invariant";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useHydrated } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { AlertCircle } from "lucide-react";
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

const uploadFormSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
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
        title: z.string().trim().min(1),
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
    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);
    const key = `${organizationId}/${data.title}`;
    await stub.reserveUpload(data.title);
    await env.R2.put(key, data.file, {
      httpMetadata: { contentType: data.file.type },
    });
    await stub.confirmUpload(data.title);
    return { success: true, title: data.title, size: data.file.size };
  });

export const Route = createFileRoute("/app/$organizationId/upload")({
  component: RouteComponent,
});

function RouteComponent() {
  const isHydrated = useHydrated();
  const uploadServerFn = useServerFn(uploadFile);
  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => uploadServerFn({ data: formData }),
    onSuccess: () => {
      form.reset();
    },
  });

  const form = useForm({
    defaultValues: {
      title: "",
      file: null as File | null,
    },
    validators: {
      onSubmit: uploadFormSchema,
    },
    onSubmit: ({ value }) => {
      const fd = new FormData();
      fd.append("title", value.title);
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
                    {uploadMutation.data.title} (
                    {Math.round(uploadMutation.data.size / 1024)} KB)
                  </AlertDescription>
                </Alert>
              )}
              <form.Field
                name="title"
                children={(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Title</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                        }}
                        placeholder="Document title"
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
    </div>
  );
}
