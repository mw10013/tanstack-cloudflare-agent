# Workflows and AgentWorkflows

## Summary

**Workflows** provide durable, multi-step execution with automatic retries and failure recovery. **AgentWorkflows** extend Workflows to add bidirectional communication with Agents for real-time progress updates and client broadcasting.

From the docs:

- "Build durable multi-step applications on Cloudflare Workers with Workflows." (`refs/cloudflare-docs/src/content/docs/workflows/index.mdx`)
- "Agents excel at real-time communication and state management. Workflows excel at durable execution with automatic retries, failure recovery, and waiting for external events." (`refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx:12-14`)

## How Workflows Execute

### Deterministic Replay Model

When a Workflow is triggered, the entire `run()` function is **re-invoked from the top** whenever the instance resumes (after sleep, retry, or hibernation). However, steps are **cached and replayed deterministically** without re-executing their callbacks.

From the docs:

> "A Workflow contains one or more steps. Each step is a self-contained, individually retriable component of a Workflow. Steps may emit (optional) state that allows a Workflow to persist and continue from that step, even if a Workflow fails due to a network or infrastructure issue." (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:10`)

### Step Identification by Name

Steps are identified by their **name string**. When `run()` re-executes, Cloudflare checks the execution history for steps with matching names. If found, it returns the cached result immediately without running the callback.

Example:
```ts
// First invocation (turn 0):
await step.do("llm-turn-0", async () => { /* executes */ });

// On resume (engine re-invokes run()):
await step.do("llm-turn-0", async () => { /* skipped, cached result returned */ });
await step.do("llm-turn-1", async () => { /* executes */ });
```

This is why **step names must be unique** within a workflow—duplicate names cause incorrect replayed results.

### Non-Durable Code Repeats

Code **outside of steps** (including non-step method calls like `reportProgress()`) runs every time `run()` is invoked:

```ts
async run(event, step) {
  for (let turn = 0; turn < 3; turn++) {
    // This runs on EVERY resume
    await this.reportProgress({ percent: turn / 3 });
    
    // This runs once per step (cached on resume)
    await step.do(`process-${turn}`, async () => { });
  }
}
```

On resume after a crash at turn 1:
- `reportProgress` for turns 0, 1, 2 all execute again
- `step.do` callbacks are skipped for turns 0, 1 (cached), only turn 2 executes

This is **safe for idempotent operations** (state updates, UI broadcasts) but dangerous for non-idempotent ones (API calls, database writes).

From the docs:

> "It is not recommended to write code with any side effects outside of steps, unless you would like it to be repeated, because the Workflow engine may restart while an instance is running." (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:220`)

## Workflows vs. AgentWorkflows

### Base Workflows (`WorkflowEntrypoint`)

Extends `WorkflowEntrypoint` for standalone durable execution:

```ts
export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    await step.do("task", async () => { /* durable */ });
  }
}
```

**Capabilities:**
- ✅ Durable multi-step execution
- ✅ Automatic retries with backoff
- ✅ Sleep and event waiting
- ❌ No bidirectional communication
- ❌ No real-time client updates
- ❌ No WebSocket support

### AgentWorkflows (`AgentWorkflow`)

Extends `AgentWorkflow` to add Agent communication:

```ts
export class MyWorkflow extends AgentWorkflow<MyAgent, Params> {
  async run(event: AgentWorkflowEvent<Params>, step: AgentWorkflowStep) {
    // Non-durable (repeats on every resume)
    await this.reportProgress({ step: "process", percent: 0.5 });
    this.broadcastToClients({ type: "update" });
    
    // Durable steps
    await step.do("work", async () => { /* ... */ });
    
    // Call Agent methods via RPC
    await this.agent.saveResult(result);
    
    // Durable Agent state sync
    await step.mergeAgentState({ progress: 0.5 });
    await step.reportComplete(result);
  }
}
```

**Additional capabilities:**
- ✅ All Workflow features (durable steps, retries, sleep, events)
- ✅ Bidirectional communication with Agent
- ✅ Real-time client updates via `broadcastToClients()`
- ✅ Progress reporting via `reportProgress()`
- ✅ Agent method RPC via `this.agent.*`
- ✅ Durable Agent state updates via `step.updateAgentState()` / `step.mergeAgentState()`

## Method Categories in AgentWorkflow

### Non-Durable Instance Methods

These **repeat on every resume**. Use for lightweight, frequent updates that are idempotent.

From the docs:

> "These methods may repeat on retry. Use for lightweight, frequent updates." (`refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx:157-159`)

```ts
// Called multiple times on resume
await this.reportProgress({
  step: "processing",
  status: "running",
  percent: 0.5,
});

// Called multiple times on resume
this.broadcastToClients({ type: "update", data });
```

### Durable Step Methods

These **won't repeat on retry** and are idempotent. Use for state changes that must persist.

From the docs:

> "These methods are idempotent and will not repeat on retry. Use for state changes that must persist." (`refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx:203-205`)

```ts
// Only runs once, persisted
await step.reportComplete(result);
await step.reportError(error);
await step.updateAgentState({ status: "done" });
await step.mergeAgentState({ progress: 1.0 });
```

## Combined Pattern: AIChatAgent + AgentWorkflow

You can combine `AIChatAgent` (for real-time chat) with `AgentWorkflow` (for long-running background tasks):

```ts
// Agent handles real-time chat
export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    // Start a background workflow
    const instanceId = await this.runWorkflow("PROCESSING_WORKFLOW", {
      taskId,
      data,
    });
    
    // Respond immediately
    return "Processing started, I'll keep you updated...";
  }
  
  // Receive workflow progress updates
  async onWorkflowProgress(
    workflowName: string,
    instanceId: string,
    progress: unknown,
  ) {
    this.broadcast(JSON.stringify({ 
      type: "workflow-progress", 
      progress 
    }));
  }
  
  // Receive workflow completion
  async onWorkflowComplete(
    workflowName: string,
    instanceId: string,
    result?: unknown,
  ) {
    this.broadcast(JSON.stringify({ 
      type: "workflow-complete", 
      result 
    }));
  }
}

// Workflow handles long-running work
export class ProcessingWorkflow extends AgentWorkflow<ChatAgent, TaskParams> {
  async run(event, step) {
    // Send progress updates (non-durable, repeats on retry)
    await this.reportProgress({
      step: "processing",
      status: "running",
      percent: 0.25,
    });
    
    // Durable work with retries
    const result = await step.do("process-data", async () => {
      return await processData(event.payload.data);
    });
    
    // Broadcast to chat clients
    this.broadcastToClients({
      type: "result-preview",
      preview: result.summary,
    });
    
    // Durable completion (won't repeat)
    await step.reportComplete(result);
  }
}
```

**Division of labor:**
- **Agent**: WebSocket connections, chat streaming, immediate responses
- **Workflow**: Durable multi-step work, retries, long waits, background processing

From the docs:

> "Workflows cannot open WebSocket connections directly. Use `broadcastToClients()` to communicate with connected clients through the Agent." (`refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx#limitations`)

## Key Rules

### 1. Store state only in step returns

State outside steps is lost on hibernation:

```ts
// ❌ Bad: lost on hibernation
const images: string[] = [];
await step.do("fetch-1", async () => {
  images.push("cat1");
});
await step.sleep("wait", "1 hour");
// images is empty after hibernation

// ✅ Good: persisted via step returns
const images = await Promise.all([
  step.do("fetch-1", async () => "cat1"),
  step.do("fetch-2", async () => "cat2"),
]);
await step.sleep("wait", "1 hour");
// images still contains ["cat1", "cat2"]
```

From the docs:

> "Workflows may hibernate and lose all in-memory state. This will happen when engine detects that there is no pending work and can hibernate until it needs to wake-up (because of a sleep, retry, or event)." (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:123-125`)

### 2. Use deterministic conditions

Conditions in `run()` must be based on deterministic values (step results, event payload), not `Math.random()` or `Date.now()`:

```ts
// ❌ Bad: non-deterministic, may differ on resume
if (Math.random() > 0.5) {
  await step.do("maybe-do", async () => {});
}

// ✅ Good: deterministic
const shouldRun = await step.do("decide", async () => {
  return Math.random() > 0.5;
});
if (shouldRun) {
  await step.do("maybe-do", async () => {});
}
```

### 3. Make steps granular and idempotent

Steps should be self-contained. Before making non-idempotent API calls, check if the operation already succeeded:

```ts
// ✅ Good: idempotent (check before charge)
await step.do("charge customer", async () => {
  const subscription = await fetch(
    `https://payment.processor/subscriptions/${customerId}`,
  ).then(r => r.json());
  
  if (subscription.charged) return; // Already charged
  
  // Safe to charge now
  return await fetch(
    `https://payment.processor/subscriptions/${customerId}`,
    { method: "POST", body: JSON.stringify({ amount: 10 }) },
  );
});
```

From the docs:

> "Because a step might be retried multiple times, your steps should (ideally) be idempotent." (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:14-17`)

### 4. Await all steps

Using `await` ensures errors propagate and state is persisted:

```ts
// ❌ Bad: dangling Promise, state lost, errors swallowed
const issues = step.do("fetch", async () => {
  return await getIssues();
});

// ✅ Good: awaited, state persisted, errors propagate
const issues = await step.do("fetch", async () => {
  return await getIssues();
});
```

## Use Cases

**Use standalone Workflows when:**
- Running durable background tasks (backups, data pipelines, batch processing)
- No real-time client communication needed
- Simple progress tracking (polling status endpoint)

**Use AgentWorkflows when:**
- Running background tasks that need real-time UI updates
- Combining chat interface with long-running work
- Needing bidirectional communication (workflow can talk back to Agent, Agent can send events to workflow)
- Building interactive agents with WebSocket clients

From the docs:

> "Use Agents alone for chat, messaging, and quick API calls. Use Agent + Workflow for long-running tasks (over 30 seconds), multi-step pipelines, and human approval flows." (`refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx:12-16`)

## Limitations

| Constraint          | Limit               |
| ------------------- | ------------------- |
| Maximum steps       | 1,024 per workflow  |
| State size          | 10 MB per workflow  |
| Event wait time     | 1 year maximum      |
| Step execution time | 30 minutes per step |

From the docs: `refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx:826-833`
