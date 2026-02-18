import * as z from "zod";

export const organizationMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upload_error"), name: z.string(), error: z.string() }),
  z.object({ type: z.literal("upload_deleted"), name: z.string(), eventTime: z.number() }),
  z.object({ type: z.literal("workflow_progress"), workflowId: z.string(), progress: z.object({ status: z.string(), message: z.string() }) }),
  z.object({ type: z.literal("workflow_complete"), workflowId: z.string(), result: z.object({ approved: z.boolean() }).optional() }),
  z.object({ type: z.literal("workflow_error"), workflowId: z.string(), error: z.string() }),
  z.object({ type: z.literal("approval_requested"), workflowId: z.string(), title: z.string() }),
  z.object({ type: z.literal("classification_workflow_started"), name: z.string(), idempotencyKey: z.string() }),
  z.object({ type: z.literal("classification_updated"), name: z.string(), idempotencyKey: z.string(), label: z.string(), score: z.number() }),
  z.object({ type: z.literal("classification_error"), name: z.string(), idempotencyKey: z.string(), error: z.string() }),
]);

export type OrganizationMessage = z.infer<typeof organizationMessageSchema>;
