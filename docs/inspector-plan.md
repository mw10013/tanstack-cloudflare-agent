# Inspector Route Implementation Plan

## Overview

Add an inspector route at `/app/$organizationId/inspector` to view internal DO SQLite tables. Server fn calls OrganizationAgent via DO RPC (not `@callable`). Zod schemas defined locally in organization-agent.ts.

## Tables

| Table | Package | Notes |
|---|---|---|
| `cf_agents_state` | agents | `state` column is arbitrary JSON → `z.unknown()` |
| `cf_agents_queues` | agents | `payload`/`callback` are JSON strings |
| `cf_agents_schedules` | agents | includes migration columns: `intervalSeconds`, `running`, `execution_started_at` |
| `cf_agents_workflows` | agents | `metadata` is JSON string |
| `cf_ai_chat_agent_messages` | ai-chat | `message` column is serialized `UIMessage` → `z.unknown()` |
| `cf_ai_chat_stream_chunks` | ai-chat | `body` is text |
| `cf_ai_chat_stream_metadata` | ai-chat | stream status tracking |

## 1. organization-agent.ts — Zod Schemas & Methods

### Zod Schemas

```ts
const AgentState = z.object({
  id: z.string(),
  state: z.unknown(),
});

const AgentQueue = z.object({
  id: z.string(),
  payload: z.string().nullable(),
  callback: z.string().nullable(),
  created_at: z.number().nullable(),
});

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

const ChatMessage = z.object({
  id: z.string(),
  message: z.unknown(),
  created_at: z.string(),
});

const ChatStreamChunk = z.object({
  id: z.string(),
  stream_id: z.string(),
  body: z.string(),
  chunk_index: z.number(),
  created_at: z.number(),
});

const ChatStreamMetadata = z.object({
  id: z.string(),
  request_id: z.string(),
  status: z.string(),
  created_at: z.number(),
  completed_at: z.number().nullable(),
});
```

### Methods on OrganizationAgent

Seven public methods, one per table. Each uses `this.sql` (sync, returns `T[]`) then parses with zod. The `state` column in `cf_agents_state` and `message` column in `cf_ai_chat_agent_messages` store JSON strings — parse them with `JSON.parse` before zod validation.

```ts
getAgentState() {
  const rows = this.sql`select * from cf_agents_state`;
  return AgentState.array().parse(
    rows.map((r) => ({ ...r, state: typeof r.state === "string" ? JSON.parse(r.state) : r.state }))
  );
}

getAgentQueues() {
  const rows = this.sql`select * from cf_agents_queues order by created_at`;
  return AgentQueue.array().parse(rows);
}

getAgentSchedules() {
  const rows = this.sql`select * from cf_agents_schedules order by created_at`;
  return AgentSchedule.array().parse(rows);
}

getAgentWorkflows() {
  const rows = this.sql`select * from cf_agents_workflows order by created_at`;
  return AgentWorkflow.array().parse(rows);
}

getChatMessages() {
  const rows = this.sql`select * from cf_ai_chat_agent_messages order by created_at`;
  return ChatMessage.array().parse(
    rows.map((r) => ({ ...r, message: typeof r.message === "string" ? JSON.parse(r.message) : r.message }))
  );
}

getChatStreamChunks() {
  const rows = this.sql`select * from cf_ai_chat_stream_chunks order by stream_id, chunk_index`;
  return ChatStreamChunk.array().parse(rows);
}

getChatStreamMetadata() {
  const rows = this.sql`select * from cf_ai_chat_stream_metadata order by created_at`;
  return ChatStreamMetadata.array().parse(rows);
}
```

### Export Types

Export inferred types for each schema so the route can use them:

```ts
export type AgentState = z.infer<typeof AgentState>;
export type AgentQueue = z.infer<typeof AgentQueue>;
// ... etc
```

## 2. app.$organizationId.inspector.tsx — Route File

### Server Fn

Access DO via RPC through `context.env.ORGANIZATION_AGENT`:

```ts
const inspectorServerFn = createServerFn({ method: "GET" })
  .inputValidator((organizationId: string) => organizationId)
  .handler(async ({ context: { env }, data: organizationId }) => {
    const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
    const stub = env.ORGANIZATION_AGENT.get(id);
    return {
      agentState: await stub.getAgentState(),
      agentQueues: await stub.getAgentQueues(),
      agentSchedules: await stub.getAgentSchedules(),
      agentWorkflows: await stub.getAgentWorkflows(),
      chatMessages: await stub.getChatMessages(),
      chatStreamChunks: await stub.getChatStreamChunks(),
      chatStreamMetadata: await stub.getChatStreamMetadata(),
    };
  });
```

### Route Definition

```ts
export const Route = createFileRoute("/app/$organizationId/inspector")({
  loader: ({ params }) => inspectorServerFn({ data: params.organizationId }),
  component: RouteComponent,
});
```

### Component

Simple tabular display of each table's data. Use Route.useLoaderData() to get data. Render each table in a section with heading and a `<pre>` or table. Start minimal — can enhance UI later.

## 3. app.$organizationId.tsx — Sidebar Link

Add `SidebarMenuItem` for "Inspector" after the Chat link:

```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    isActive={Boolean(matchRoute({ to: "/app/$organizationId/inspector" }))}
    render={
      <Link
        to="/app/$organizationId/inspector"
        params={{ organizationId: organization.id }}
      >
        Inspector
      </Link>
    }
  />
</SidebarMenuItem>
```

## File Changes Summary

| File | Change |
|---|---|
| `src/organization-agent.ts` | Add 7 zod schemas, 7 public methods, export types |
| `src/routes/app.$organizationId.inspector.tsx` | New route file with server fn, loader, component |
| `src/routes/app.$organizationId.tsx` | Add Inspector sidebar link after Chat |

## Verification

```bash
pnpm typecheck
pnpm lint
```
