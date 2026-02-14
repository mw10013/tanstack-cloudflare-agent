# Organization Image Classification Workflow Plan (Iteration 2)

## Goal

When an image upload lands in R2 and emits an R2 event notification, run `OrganizationWorkflow` to classify the image with Workers AI `@cf/microsoft/resnet-50`, then persist latest classification in the organization agent SQLite.

Remove human approval behavior from `OrganizationWorkflow` as part of this work.

## Current Baseline

- Upload route writes to R2 with custom metadata: `src/routes/app.$organizationId.upload.tsx:86`
- Queue consumer reads R2 notification, calls `R2.head()`, then calls agent `onUpload({ name })`: `src/worker.ts:128`
- Agent table is currently minimal `Upload(name, createdAt)`: `src/organization-agent.ts:179`
- `OrganizationWorkflow` exists but is approval workflow today: `src/organization-agent.ts:113`

## Platform Facts That Drive Design

- Queues are at-least-once delivery. Duplicates can happen.
  - `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`
- `ack()` marks message delivered and prevents redelivery.
  - `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx:58`
- Workflow side effects outside `step.do` may repeat on restart/retry.
  - `refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:220`
- `runWorkflow()` does `workflow.create(...)` then DB tracking insert. Not atomic.
  - `refs/agents/packages/agents/src/index.ts:1906`
- ResNet output is ordered `{ label, score }[]`.
  - `refs/cloudflare-docs/src/content/workers-ai-models/resnet-50.json:61`

## Conceptual Challenges

1. Duplicate queue deliveries for the same object event.
2. Crash between DB write and workflow start.
3. Crash after workflow creation but before local bookkeeping.
4. Multiple uploads with same `name` (overwrite semantics in R2).
5. Old workflow completion arriving after a newer upload for same `name`.

## Requirements / Invariants

1. Each R2 object event kicks off at most one workflow.
2. Duplicate delivery of the same queue message is no-op.
3. Uploading same `name` replaces current object and current classification.
4. Old workflow result must not overwrite newer upload state.
5. Queue message is acked only after durable ingest + workflow dispatch outcome is known.

## Approaches Considered

## A) Event History Table + Projection Table

- Keep immutable event rows (`uploadEvent`) plus current row (`uploadCurrent`).
- Strong auditability and replay.
- More schema and query complexity than needed now.

Flesh this approach out. I don't understand it.

## B) Single Current-State Row per `name` + Event Idempotency (Recommended)

- One row per `name`, track only latest upload/event/workflow/classification.
- Generate deterministic ids from event payload.
- Enforce stale-write guards on workflow completion.
- Minimal schema, matches overwrite semantics.

Flesh this approach out. I don't understand it.

## C) Workflow-First then DB write

- Start workflow first, write DB later.
- Unsafe due to crash window and no durable local trace.
- Rejected.

## Recommended Design

Use approach B.

### Deterministic IDs

- `eventId = sha256("${key}:${eTag}")`
- `workflowId = "imgcls_" + eventId`

Properties:
- Duplicate queue deliveries for same event collapse on `eventId`.
- Retried `runWorkflow(..., { id: workflowId })` is safe.

### Minimal SQLite Schema (camelCase)

`Upload` becomes current-state row keyed by `name`.

```sql
create table if not exists Upload (
  name text primary key,
  eventId text not null unique,
  workflowId text not null unique,
  status text not null check (status in ('queued', 'running', 'classified', 'failed')),
  classificationLabel text,
  classificationScore real,
  classificationModel text,
  error text,
  createdAt integer not null,
  updatedAt integer not null,
  completedAt integer
);

I don't think we need classificationModel.

create index if not exists idx_upload_status on Upload (status);
create index if not exists idx_upload_updatedAt on Upload (updatedAt desc);
```

Pruned intentionally:
- No `r2` columns
- No `contentType`
- No full classification JSON (top-1 only for now)

## End-to-End Sequence

1. Upload route writes `key = ${organizationId}/${name}` to R2 (already exists).
2. R2 sends queue notification (or local simulation).
3. Queue consumer does `R2.head(key)` and extracts `organizationId`, `name`, `eTag`.
4. Queue consumer calls `stub.ingestUploadEvent({ name, key, eTag })`.
5. Agent computes `eventId` and `workflowId`.
6. Agent upserts row for `name`:
   - set `eventId`, `workflowId`, `status='queued'`
   - reset classification/error fields
7. Agent starts workflow with deterministic `workflowId`.
   - if duplicate workflow/tracking error: treat as already-started success
8. Agent sets `status='running'` for this `name` only when `eventId` still matches.
9. Queue handler `ack()` message.
10. Workflow runs:
    - `step.do("load-image")` from R2 using `key`
    - `step.do("classify-image")` with `@cf/microsoft/resnet-50`
    - `step.do("persist-result")` call agent to store top label/score
11. Agent persist methods always include stale guard:
    - update only `where name = ? and eventId = ?`
    - if 0 rows changed, result is stale and ignored

## Stale Completion Protection (critical)

Scenario:
- Upload A (`name=hero`) starts workflow A
- Upload B (`name=hero`) replaces object, starts workflow B
- Workflow A completes after B

Guard:
- Workflow A persists with `where name='hero' and eventId=eventA`
- Row now has `eventId=eventB`, so update count is 0
- Old result discarded; newer upload remains authoritative

## Failure and Recovery

1. Crash before ingest write:
   - message unacked -> redelivery -> normal.
2. Crash after upsert, before `runWorkflow`:
   - message unacked -> redelivery -> same row/event -> starts workflow.
3. Crash after workflow create, before local state update:
   - redelivery retries same deterministic `workflowId`; duplicate means already created.
4. Duplicate queue deliveries:
   - same `eventId`/`workflowId`; no duplicate logical work.
5. Workflow retries:
   - durable writes only in `step.do`.

## Implementation Changes

### 1) Agent (`src/organization-agent.ts`)

- Replace constructor table SQL with new `Upload` schema.
- Replace `onUpload` with `ingestUploadEvent({ name, key, eTag })`.
- Add:
  - `startClassificationWorkflow(...)`
  - `persistClassificationSuccess({ name, eventId, label, score })`
  - `persistClassificationFailure({ name, eventId, error })`
- Convert `OrganizationWorkflow` from approval flow to image classification flow.

### 2) Queue Consumer (`src/worker.ts`)

- Replace `stub.onUpload({ name })` with `stub.ingestUploadEvent({ name, key, eTag })`.
- Keep `head()` lookup for metadata routing.
- `ack()` only after ingest returns.

### 3) Upload UI Data (`src/routes/app.$organizationId.upload.tsx`)

- Extend `getUploads()` shape with:
  - `status`
  - `classificationLabel`
  - `classificationScore`
- Initial UI can stay minimal, but backend should expose fields.

### 4) Workers AI Parse

- Parse response with zod:
  - `z.array(z.object({ label: z.string(), score: z.number() }))`
- Use top result only:
  - `const top = results[0]`

## Suggested Workflow Payload

```ts
{
  name: string;
  key: string;
  eventId: string;
}
```

## Suggested Progress Type

```ts
{
  status: "running" | "classified" | "failed";
  step: "load-image" | "classify-image" | "persist-result";
  message: string;
}
```

## Open Decisions

1. Keep class name `OrganizationWorkflow` for classification vs add dedicated `OrganizationImageClassificationWorkflow`.
2. Keep top-1 only vs store full top-k JSON later.
3. Add manual retry endpoint for `failed` rows now vs later.

## Validation Checklist

- Same queue message delivered twice => single effective workflow.
- Upload same `name` twice quickly => final row reflects second upload only.
- Old workflow completion after newer upload => old write ignored.
- Inject crash after DB upsert before workflow start => redelivery recovers.
- Force AI failure => row status `failed`, with error.

