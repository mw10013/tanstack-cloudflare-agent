# Upload Messages Plan

## Goal

Add real-time broadcast messages to the upload route via `useAgent()`. Users see a live feed of events pushed from the agent.

## Architecture

### WebSocket Ownership

`RouteComponent` owns the single `useAgent()` call (single WebSocket). A `<Messages>` component in the same file receives messages as props — no extra sockets.

```
RouteComponent
  ├── useAgent({ onMessage → pushes to messages state })
  ├── useState<OrganizationMessage[]>([])
  ├── upload form (inline)
  ├── uploads list (inline)
  └── <Messages messages={messages} />  (always renders, shows empty state)
```

### Broadcast Type System

Define a discriminated union `OrganizationMessage` in `organization-agent.ts`. All broadcast message types are custom — no collision with the library's internal `cf_agent_*` / `rpc` types.

The workflow/approval types (`workflow_progress`, `workflow_complete`, etc.) are entirely custom. The base `Agent` class has no-op `onWorkflowProgress/Complete/Error` handlers; it never broadcasts anything for workflows. Our overrides chose those `type` strings.

```ts
export type OrganizationMessage =
  | { type: "upload_complete"; name: string; createdAt: number }
  | { type: "upload_error"; name: string; error: string }
  | { type: "workflow_progress"; workflowId: string; progress: { status: string; message: string } }
  | { type: "workflow_complete"; workflowId: string; result?: { approved: boolean } }
  | { type: "workflow_error"; workflowId: string; error: string }
  | { type: "approval_requested"; workflowId: string; title: string };
```

### Typed broadcast helper

Can't override `broadcast` with a typed signature — the base method takes `string | ArrayBuffer`, and the internal `_workflow_broadcast` calls `this.broadcast(JSON.stringify(message))` which would double-stringify if we changed the contract. A helper method is the clean approach:

ok, let's call it broadcastMessage. 

```ts
protected sendMessage(msg: OrganizationMessage) {
  this.broadcast(JSON.stringify(msg));
}
```

### Agent Changes (`organization-agent.ts`)

1. Add `OrganizationMessage` union type (exported).
2. Add `sendMessage()` helper method.
3. Migrate all existing `this.broadcast(JSON.stringify({...}))` calls to `this.sendMessage(...)`.
4. In `onUpload()`, broadcast after DB insert:

```ts
onUpload(upload: { name: string }) {
  const createdAt = Date.now();
  void this.sql`insert or replace into Upload (name, createdAt)
    values (${upload.name}, ${createdAt})`;
  this.sendMessage({ type: "upload_complete", name: upload.name, createdAt });
}
```

5. Rename `listUploads` → `getUploads` (done).

### Client Changes (`app.$organizationId.upload.tsx`)

1. Import `OrganizationMessage` and `OrganizationAgent`.
2. Add `useAgent()` in `RouteComponent` with `onMessage` that parses and accumulates all message types into `useState`.
3. On `upload_complete`: also call `router.invalidate()` to refresh the uploads list.
4. `<Messages>` component receives `messages` as props.

### Messages Component

- Always renders (shows empty state when no messages).
- Simple list, most recent first.
- Displays any `OrganizationMessage` type that arrives (no filtering).
- Each item: icon (based on type), message text, timestamp.
- `upload_complete` → check icon, "`{name}` uploaded".
- `upload_error` → alert icon, "`{name}` failed: {error}".
- Workflow types → appropriate icon + summary text.
- Messages accumulate (no auto-dismiss, no manual clear for now).

## Decisions

- **Scope**: All `OrganizationMessage` types displayed — no filtering by route.
- **Persistence**: Local `useState` — gone on navigation. No SQLite storage.
- **Dismissal**: Accumulate indefinitely for now.
- **Component location**: `<Messages>` defined in the same route file, not extracted.
- **Empty state**: Always render the Messages card.
