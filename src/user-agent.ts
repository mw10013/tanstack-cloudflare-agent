import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { convertToModelMessages, generateText, streamText } from "ai";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { createWorkersAI } from "workers-ai-provider";

export const extractAgentName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

export class UserAgent extends AIChatAgent<Env> {
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

  async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        skipCache: false,
        cacheTtl: 3360,
      },
    });
    const result = streamText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-awq"),
      messages: await convertToModelMessages(this.messages),
      onFinish,
    });
    return result.toUIMessageStreamResponse();
  }

  async feeFi(): Promise<string> {
    const ai = this.env.AI;
    const response = await ai.run(
      "@cf/meta/llama-3.1-8b-instruct-awq",
      { prompt: "fee fi" },
      {
        gateway: {
          id: this.env.AI_GATEWAY_ID,
          skipCache: false,
          cacheTtl: 3360,
        },
      },
    );
    const output = response.response;
    return output && output.trim().length > 0 ? output : "No response";
  }

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

  async feeFi2(): Promise<string> {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        skipCache: false,
        cacheTtl: 3360,
      },
    });
    const { text } = await generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-awq"),
      prompt: "fee fi",
    });
    return text && text.trim().length > 0 ? text : "No response";
  }
}
