# Upload Messages Plan

## Goal

Add real-time broadcast messages to the upload route via `useAgent()`. Users see a live feed of upload-related events pushed from the agent.

## Architecture

### WebSocket Ownership

`RouteComponent` owns the single `useAgent()` call (single WebSocket). A `<Messages>` component in the same file receives messages as props — no extra sockets.

```
RouteComponent
  ├── useAgent({ onMessage → pushes to messages state })
  ├── useState<OrganizationBroadcast[]>([])
  ├── upload form (inline)
  ├── uploads list (inline)
  └── <Messages messages={messages} />
```

### Broadcast Type System

Define a discriminated union in `organization-agent.ts` covering all broadcast message types. Add a typed `_broadcast` helper to replace raw `this.broadcast(JSON.stringify(...))` calls.

```ts
export type OrganizationBroadcast =
  | { type: "upload_complete"; name: string; createdAt: number }
  | { type: "upload_error"; name: string; error: string }
  | { type: "workflow_progress"; workflowId: string; progress: { status: string; message: string } }
  | { type: "workflow_complete"; workflowId: string; result?: { approved: boolean } }
  | { type: "workflow_error"; workflowId: string; error: string }
  | { type: "approval_requested"; workflowId: string; title: string };
```

Typed helper:

```ts
private _broadcast(msg: OrganizationBroadcast) {
  this.broadcast(JSON.stringify(msg));
}
```

### Agent Changes (`organization-agent.ts`)

1. Add `OrganizationBroadcast` union type (exported).
2. Add `_broadcast()` helper method.
3. Migrate all existing `this.broadcast(JSON.stringify({...}))` calls to `this._broadcast(...)`.
4. In `onUpload()`, broadcast after DB insert:

```ts
onUpload(upload: { name: string }) {
  const createdAt = Date.now();
  void this.sql`insert or replace into Upload (name, createdAt)
    values (${upload.name}, ${createdAt})`;
  this._broadcast({ type: "upload_complete", name: upload.name, createdAt });
}
```

5. Rename `listUploads` → `getUploads` (done).

### Client Changes (`app.$organizationId.upload.tsx`)

1. Import `OrganizationBroadcast` and `OrganizationAgent`.
2. Add `useAgent()` in `RouteComponent` with `onMessage` that parses and accumulates upload-related broadcasts into `useState`.
3. On `upload_complete`: also call `router.invalidate()` to refresh the uploads list.
4. `<Messages>` component: renders the accumulated messages as a list. Props: `messages: OrganizationBroadcast[]`.

### Messages Component

- Simple list, most recent first.
- Each item: icon (based on type), message text, timestamp.
- `upload_complete` → check icon, "`{name}` uploaded".
- `upload_error` → alert icon, "`{name}` failed: {error}".
- Messages accumulate (no auto-dismiss, no manual clear for now).

## Decisions

- **Scope**: Upload-only events in this route's `<Messages>`. Union type supports all broadcast types for reuse elsewhere.
- **Persistence**: Local `useState` — gone on navigation. No SQLite storage.
- **Dismissal**: Accumulate indefinitely for now.
- **Component location**: `<Messages>` defined in the same route file, not extracted.

## Open Questions

- Should `<Messages>` filter to upload-only types, or display any broadcast that arrives?
- Should the messages card always render (empty state), or only when messages exist?
