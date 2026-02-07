import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
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

const AgentWorkflow = z.object({
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
export type AgentWorkflow = z.infer<typeof AgentWorkflow>;

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

export class OrganizationAgent extends AIChatAgent<Env> {
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

  getAgentState() {
    const rows = this.sql`select * from cf_agents_state`;
    return AgentState.array().parse(
      rows.map((r) => ({
        ...r,
        state:
          typeof r.state === "string"
            ? r.state
            : JSON.stringify(r.state),
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
    return AgentWorkflow.array().parse(
      this.sql`select * from cf_agents_workflows order by created_at`,
    );
  }

  getChatMessages() {
    const rows = this.sql`select * from cf_ai_chat_agent_messages order by created_at`;
    return ChatMessage.array().parse(
      rows.map((r) => ({
        ...r,
        message:
          typeof r.message === "string"
            ? r.message
            : JSON.stringify(r.message),
      })),
    );
  }

  getChatStreamChunks() {
    return ChatStreamChunk.array().parse(
      this.sql`select * from cf_ai_chat_stream_chunks order by stream_id, chunk_index`,
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
