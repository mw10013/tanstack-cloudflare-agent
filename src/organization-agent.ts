import type { AgentContext } from "agents";
import type {
  AgentWorkflowEvent,
  AgentWorkflowStep,
  WorkflowInfo,
} from "agents/workflows";
import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { AgentWorkflow } from "agents/workflows";
import { convertToModelMessages, generateText, streamText } from "ai";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { createWorkersAI } from "workers-ai-provider";
import * as z from "zod";
import { type OrganizationMessage } from "@/organization-messages";

const AgentState = z.object({
  id: z.string(),
  state: z.string(),
});
export type AgentState = z.infer<typeof AgentState>;

const AgentQueue = z.object({
  id: z.string(),
  payload: z.string().nullable(),
  callback: z.string().nullable(),
  created_at: z.number().nullable(),
});
export type AgentQueue = z.infer<typeof AgentQueue>;

const AgentSchedule = z.object({
  id: z.string(),
  callback: z.string().nullable(),
  payload: z.string().nullable(),
  type: z.enum(["scheduled", "delayed", "cron", "interval"]),
  time: z.number().nullable(),
  delayInSeconds: z.number().nullable(),
  cron: z.string().nullable(),
  intervalSeconds: z.number().nullable(),
  running: z.number().nullable(),
  created_at: z.number().nullable(),
  execution_started_at: z.number().nullable(),
});
export type AgentSchedule = z.infer<typeof AgentSchedule>;

const AgentWorkflowRow = z.object({
  id: z.string(),
  workflow_id: z.string(),
  workflow_name: z.string(),
  status: z.string(),
  metadata: z.string().nullable(),
  error_name: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
});
export type AgentWorkflowRow = z.infer<typeof AgentWorkflowRow>;

const ChatMessage = z.object({
  id: z.string(),
  message: z.string(),
  created_at: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

const ChatStreamChunk = z.object({
  id: z.string(),
  stream_id: z.string(),
  body: z.string(),
  chunk_index: z.number(),
  created_at: z.number(),
});
export type ChatStreamChunk = z.infer<typeof ChatStreamChunk>;

const ChatStreamMetadata = z.object({
  id: z.string(),
  request_id: z.string(),
  status: z.string(),
  created_at: z.number(),
  completed_at: z.number().nullable(),
});
export type ChatStreamMetadata = z.infer<typeof ChatStreamMetadata>;

const UploadRow = z.object({
  name: z.string(),
  createdAt: z.number(),
  eventTime: z.number(),
  idempotencyKey: z.string(),
  classificationLabel: z.string().nullable(),
  classificationScore: z.number().nullable(),
  classifiedAt: z.number().nullable(),
});
export type UploadRow = z.infer<typeof UploadRow>;

const activeWorkflowStatuses = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);

export const extractAgentName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

export interface ApprovalRequestInfo {
  id: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  reason?: string;
}

export class OrganizationWorkflow extends AgentWorkflow<
  OrganizationAgent,
  { title: string; description: string },
  { status: "pending" | "approved" | "rejected"; message: string }
> {
  async run(
    event: AgentWorkflowEvent<{ title: string; description: string }>,
    step: AgentWorkflowStep,
  ): Promise<{
    approved: boolean;
    title: string;
    resolvedAt: string;
    approvalData?: unknown;
  }> {
    const { title } = event.payload;

    // eslint-disable-next-line @typescript-eslint/require-await
    await step.do("prepare-request", async () => ({
      title,
      requestedAt: Date.now(),
    }));

    await this.reportProgress({
      status: "pending",
      message: `Waiting for approval: ${title}`,
    });

    try {
      const approvalData = await this.waitForApproval<{ approvedBy?: string }>(
        step,
        { timeout: "7 days" },
      );

      const result = {
        approved: true as const,
        title,
        resolvedAt: new Date().toISOString(),
        approvalData,
      };

      await this.reportProgress({
        status: "approved",
        message: `Approved: ${title}`,
      });

      await step.reportComplete(result);
      return result;
    } catch {
      await this.reportProgress({
        status: "rejected",
        message: `Rejected: ${title}`,
      });

      return {
        approved: false,
        title,
        resolvedAt: new Date().toISOString(),
      };
    }
  }
}

export class OrganizationImageClassificationWorkflow extends AgentWorkflow<
  OrganizationAgent,
  { idempotencyKey: string; r2ObjectKey: string },
  { status: string; message: string }
> {
  async run(
    event: AgentWorkflowEvent<{ idempotencyKey: string; r2ObjectKey: string }>,
    step: AgentWorkflowStep,
  ): Promise<{ idempotencyKey: string; label: string; score: number }> {
    const { idempotencyKey, r2ObjectKey } = event.payload;
    await this.reportProgress({
      status: "running",
      message: `Classifying ${r2ObjectKey}`,
    });
    const bytes = await step.do("load-image-bytes", async () => {
      const object = await this.env.R2.get(r2ObjectKey);
      const body = object?.body;
      if (!body) {
        throw new Error(`R2 object not found: ${r2ObjectKey}`);
      }
      const arr = new Uint8Array(await new Response(body).arrayBuffer());
      return Array.from(arr);
    });
    const top = await step.do("classify-image", async () => {
      const response = await this.env.AI.run(
        "@cf/microsoft/resnet-50",
        { image: bytes },
        {
          gateway: {
            id: this.env.AI_GATEWAY_ID,
            skipCache: false,
            cacheTtl: 7 * 24 * 60 * 60,
          },
        },
      );
      const predictions = z.array(z.object({ label: z.string(), score: z.number() })).min(1).parse(response);
      const first = predictions[0];
      return first;
    });
    await step.do("apply-classification-result", async () => {
      await this.agent.applyClassificationResult({
        idempotencyKey,
        label: top.label,
        score: top.score,
      });
    });
    return { idempotencyKey, label: top.label, score: top.score };
  }
}

export class OrganizationAgent extends AIChatAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    void this
      .sql`create table if not exists Upload (
        name text primary key,
        createdAt integer not null,
        eventTime integer not null,
        idempotencyKey text not null unique,
        classificationLabel text,
        classificationScore real,
        classifiedAt integer
      )`;
  }

  ping() {
    return {
      ok: true,
      now: new Date().toISOString(),
      agentId: this.ctx.id.toString(),
    };
  }

  @callable()
  bang() {
    return "bang";
  }

  protected broadcastMessage(msg: OrganizationMessage) {
    this.broadcast(JSON.stringify(msg));
  }

  /**
   * Create-first workflow orchestration for upload classification.
   * 1) Clean up agent-tracked workflow if active.
   * 2) Attempt workflow creation directly — create() itself is the existence check.
   * 3) On duplicate-ID failure, enter recovery: get → terminate → retry create.
   *    In recovery, .get() is only called when we know the instance exists, so any
   *    failure is genuinely transient and propagates (no silent swallow).
   * Avoids speculative .get() probing because the binding throws the same error for
   * "not found" and transient failures (undocumented, confirmed in miniflare source).
   * If any step in recovery fails, throw so queue retries preserve invariants.
   */
  async onUpload(upload: {
    name: string;
    eventTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
  }) {
    const eventTime = Date.parse(upload.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new Error(`Invalid eventTime: ${upload.eventTime}`);
    }
    const existing = UploadRow.nullable().parse(this
      .sql<UploadRow>`select * from Upload where name = ${upload.name}`[0] ?? null);
    if (existing && eventTime < existing.eventTime) {
      console.log("classification workflow skipped for stale upload event", {
        name: upload.name,
        idempotencyKey: upload.idempotencyKey,
      });
      return;
    }
    void this.sql`
      insert into Upload (
        name,
        createdAt,
        eventTime,
        idempotencyKey,
        classificationLabel,
        classificationScore,
        classifiedAt
      ) values (
        ${upload.name},
        ${eventTime},
        ${eventTime},
        ${upload.idempotencyKey},
        null,
        null,
        null
      )
      on conflict(name) do update set
        createdAt = excluded.createdAt,
        eventTime = excluded.eventTime,
        idempotencyKey = excluded.idempotencyKey,
        classificationLabel = null,
        classificationScore = null,
        classifiedAt = null
    `;
    const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
    if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
      await this.terminateWorkflow(upload.idempotencyKey);
    }
    const workflowParams = {
      idempotencyKey: upload.idempotencyKey,
      r2ObjectKey: upload.r2ObjectKey,
    } as const;
    const workflowOpts = { id: upload.idempotencyKey } as const;
    try {
      await this.runWorkflow(
        "OrganizationImageClassificationWorkflow",
        workflowParams,
        workflowOpts,
      );
    } catch {
      const instance = await this.env.OrganizationImageClassificationWorkflow
        .get(upload.idempotencyKey);
      const status = await instance.status();
      if (activeWorkflowStatuses.has(status.status)) {
        await instance.terminate();
      }
      await this.runWorkflow(
        "OrganizationImageClassificationWorkflow",
        workflowParams,
        workflowOpts,
      );
    }
    this.broadcastMessage({
      type: "classification_workflow_started",
      name: upload.name,
      idempotencyKey: upload.idempotencyKey,
    });
  }

  applyClassificationResult(input: {
    idempotencyKey: string;
    label: string;
    score: number;
  }) {
    const classifiedAt = Date.now();
    const updated = this.sql<{ name: string; idempotencyKey: string }>`
      update Upload
      set classificationLabel = ${input.label},
          classificationScore = ${input.score},
          classifiedAt = ${classifiedAt}
      where idempotencyKey = ${input.idempotencyKey}
      returning name, idempotencyKey
    `;
    if (updated.length === 0) {
      return;
    }
    const row = updated[0];
    this.broadcastMessage({
      type: "classification_updated",
      name: row.name,
      idempotencyKey: row.idempotencyKey,
      label: input.label,
      score: input.score,
    });
  }

  @callable()
  getUploads() {
    return UploadRow.array().parse(
      this.sql`select * from Upload order by createdAt desc`,
    );
  }

  getAgentState() {
    const rows = this.sql`select * from cf_agents_state`;
    return AgentState.array().parse(
      rows.map((r) => ({
        ...r,
        state: typeof r.state === "string" ? r.state : JSON.stringify(r.state),
      })),
    );
  }

  getAgentQueues() {
    return AgentQueue.array().parse(
      this.sql`select * from cf_agents_queues order by created_at`,
    );
  }

  getAgentSchedules() {
    return AgentSchedule.array().parse(
      this.sql`select * from cf_agents_schedules order by created_at`,
    );
  }

  getAgentWorkflows() {
    return AgentWorkflowRow.array().parse(
      this.sql`select * from cf_agents_workflows order by created_at`,
    );
  }

  getChatMessages() {
    const rows = this
      .sql`select * from cf_ai_chat_agent_messages order by created_at`;
    return ChatMessage.array().parse(
      rows.map((r) => ({
        ...r,
        message:
          typeof r.message === "string" ? r.message : JSON.stringify(r.message),
      })),
    );
  }

  getChatStreamChunks() {
    return ChatStreamChunk.array().parse(
      this
        .sql`select * from cf_ai_chat_stream_chunks order by stream_id, chunk_index`,
    );
  }

  getChatStreamMetadata() {
    return ChatStreamMetadata.array().parse(
      this.sql`select * from cf_ai_chat_stream_metadata order by created_at`,
    );
  }

  async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        skipCache: false,
        cacheTtl: 7 * 24 * 60 * 60,
      },
    });
    const result = streamText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-awq"),
      messages: await convertToModelMessages(this.messages),
      onFinish,
    });
    return result.toUIMessageStreamResponse();
  }

  private _toApprovalRequest(w: WorkflowInfo): ApprovalRequestInfo {
    const metadata = w.metadata as {
      title?: string;
      description?: string;
    } | null;

    let status: "pending" | "approved" | "rejected" = "pending";
    if (w.status === "complete") {
      status = "approved";
    } else if (w.status === "errored" || w.status === "terminated") {
      status = "rejected";
    }

    return {
      id: w.workflowId,
      title: metadata?.title ?? "Untitled",
      description: metadata?.description ?? "",
      status,
      createdAt: w.createdAt.toISOString(),
      resolvedAt: w.completedAt?.toISOString(),
      reason: w.error?.message,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown,
  ): Promise<void> {
    if (workflowName !== "OrganizationWorkflow") {
      return;
    }
    const approvalProgress = z.object({
      status: z.enum(["pending", "approved", "rejected"]),
      message: z.string(),
    }).parse(progress);
    this.broadcastMessage({ type: "workflow_progress", workflowId, progress: approvalProgress });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown,
  ): Promise<void> {
    if (workflowName !== "OrganizationWorkflow") {
      return;
    }
    const approvalResult = z.object({ approved: z.boolean() }).optional().parse(result);
    this.broadcastMessage({ type: "workflow_complete", workflowId, result: approvalResult });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    if (workflowName === "OrganizationWorkflow") {
      this.broadcastMessage({ type: "workflow_error", workflowId, error });
      return;
    }
    if (workflowName !== "OrganizationImageClassificationWorkflow") {
      return;
    }
    const row = UploadRow.nullable().parse(this
      .sql<UploadRow>`select * from Upload where idempotencyKey = ${workflowId}`[0] ?? null);
    if (row?.idempotencyKey !== workflowId) {
      return;
    }
    this.broadcastMessage({
      type: "classification_error",
      name: row.name,
      idempotencyKey: workflowId,
      error,
    });
  }

  @callable()
  async requestApproval(
    title: string,
    description: string,
  ): Promise<ApprovalRequestInfo> {
    const workflowId = await this.runWorkflow(
      "OrganizationWorkflow",
      { title, description },
      { metadata: { title, description } },
    );

    this.broadcastMessage({ type: "approval_requested", workflowId, title });

    return {
      id: workflowId,
      title,
      description,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
  }

  @callable()
  async approveRequest(workflowId: string): Promise<boolean> {
    const workflow = this.getWorkflow(workflowId);
    if (
      !workflow ||
      workflow.status === "complete" ||
      workflow.status === "errored" ||
      workflow.status === "terminated"
    ) {
      return false;
    }

    await this.approveWorkflow(workflowId, {
      reason: "Approved",
      metadata: { approvedBy: "user" },
    });

    return true;
  }

  @callable()
  async rejectRequest(workflowId: string, reason?: string): Promise<boolean> {
    const workflow = this.getWorkflow(workflowId);
    if (
      !workflow ||
      workflow.status === "complete" ||
      workflow.status === "errored" ||
      workflow.status === "terminated"
    ) {
      return false;
    }

    await this.rejectWorkflow(workflowId, {
      reason: reason ?? "Rejected",
    });

    return true;
  }

  @callable()
  listApprovalRequests(): ApprovalRequestInfo[] {
    const { workflows } = this.getWorkflows({
      workflowName: "OrganizationWorkflow",
    });
    return workflows.map((w) => this._toApprovalRequest(w));
  }

  @callable()
  async feeFi(): Promise<string> {
    const ai = this.env.AI;
    const response = await ai.run(
      "@cf/meta/llama-3.1-8b-instruct-awq",
      { prompt: "fee fi" },
      {
        gateway: {
          id: this.env.AI_GATEWAY_ID,
          skipCache: false,
          cacheTtl: 7 * 24 * 60 * 60,
        },
      },
    );
    const output = response.response;
    return output && output.trim().length > 0 ? output : "No response";
  }

  @callable()
  async feeFi1(): Promise<string> {
    const gatewayUrl = await this.env.AI.gateway(this.env.AI_GATEWAY_ID).getUrl(
      "workers-ai",
    );
    const openai = createOpenAI({
      baseURL: `${gatewayUrl}/v1`,
      apiKey: this.env.WORKERS_AI_API_TOKEN,
      headers: {
        "cf-aig-authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
      },
    });
    const { text } = await generateText({
      model: openai.chat("@cf/meta/llama-3.1-8b-instruct-awq"),
      prompt: "fee fi",
    });
    return text && text.trim().length > 0 ? text : "No response";
  }

  @callable()
  async feeFi2(): Promise<string> {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        skipCache: false,
        cacheTtl: 7 * 24 * 60 * 60,
      },
    });
    const { text } = await generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-awq"),
      prompt: "fee fi",
    });
    return text && text.trim().length > 0 ? text : "No response";
  }
}
