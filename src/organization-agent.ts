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

export const organizationMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upload_complete"), name: z.string(), createdAt: z.number() }),
  z.object({ type: z.literal("upload_error"), name: z.string(), error: z.string() }),
  z.object({ type: z.literal("workflow_progress"), workflowId: z.string(), progress: z.object({ status: z.string(), message: z.string() }) }),
  z.object({ type: z.literal("workflow_complete"), workflowId: z.string(), result: z.object({ approved: z.boolean() }).optional() }),
  z.object({ type: z.literal("workflow_error"), workflowId: z.string(), error: z.string() }),
  z.object({ type: z.literal("approval_requested"), workflowId: z.string(), title: z.string() }),
]);
export type OrganizationMessage = z.infer<typeof organizationMessageSchema>;

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

export class OrganizationAgent extends AIChatAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    void this
      .sql`create table if not exists Upload (name text primary key, createdAt integer not null)`;
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

  onUpload(upload: { name: string }) {
    const createdAt = Date.now();
    void this.sql`insert or replace into Upload (name, createdAt)
      values (${upload.name}, ${createdAt})`;
    this.broadcastMessage({ type: "upload_complete", name: upload.name, createdAt });
  }

  @callable()
  getUploads() {
    return this.sql`select * from Upload order by createdAt desc`;
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
    _workflowName: string,
    workflowId: string,
    progress: { status: "pending" | "approved" | "rejected"; message: string },
  ): Promise<void> {
    this.broadcastMessage({ type: "workflow_progress", workflowId, progress });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: { approved: boolean },
  ): Promise<void> {
    this.broadcastMessage({ type: "workflow_complete", workflowId, result });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    this.broadcastMessage({ type: "workflow_error", workflowId, error });
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
