# Organization Image Classification Workflow Plan

## Goal

When an image upload lands in R2 and emits an R2 event notification, run `OrganizationWorkflow` to classify the image with Workers AI `@cf/microsoft/resnet-50`, then persist classification state/results in agent SQLite.

## Current Baseline

- Upload route writes file to R2 and sets `customMetadata` (`organizationId`, `name`): `src/routes/app.$organizationId.upload.tsx:86`
- Queue consumer receives R2 notifications, does `R2.head()`, and calls `stub.onUpload({ name })`: `src/worker.ts:128`
- Agent currently stores only `Upload(name, createdAt)`: `src/organization-agent.ts:179`
- `OrganizationWorkflow` exists but is approval-oriented today: `src/organization-agent.ts:113`

## Platform Constraints (drives design)

- Queues delivery is at-least-once; duplicates can happen.
  - `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`
- Explicit `ack()` prevents re-delivery of that message.
  - `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx:58`
- Workflow side effects outside steps may duplicate on retries/restarts.
  - `refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:220`
- `Agent.runWorkflow()` creates workflow instance, then inserts tracking row; not an atomic transaction.
  - `refs/agents/packages/agents/src/index.ts:1906`
- ResNet output is ranked `{ label, score }[]`.
  - `refs/cloudflare-docs/src/content/workers-ai-models/resnet-50.json:61`

## Design Principles

1. Idempotency at ingress (queue event to DB).
2. Deterministic workflow IDs to collapse duplicate starts.
3. Durable classification logic inside workflow `step.do(...)`.
4. Queue message `ack()` only after durable ingest/dispatch is successful.
5. Persist full state machine in SQLite for recovery/observability.

## Proposed Data Model (Agent SQLite)

Replace current minimal `Upload` shape with classification-aware table.

```sql
create table if not exists Upload (
  upload_event_id text primary key,
  organization_id text not null,
  name text not null,
  r2_key text not null,
  r2_etag text not null,
  r2_size integer not null,
  content_type text,
  workflow_id text not null unique,
  status text not null check (status in ('ingested', 'workflow_running', 'classified', 'classification_failed')),
  classification_model text,
  classification_top_label text,
  classification_top_score real,
  classification_json text,
  classification_error text,
  created_at integer not null,
  updated_at integer not null,
  completed_at integer
);

create index if not exists idx_upload_org_created on Upload (organization_id, created_at desc);
create index if not exists idx_upload_status on Upload (status);
create unique index if not exists idx_upload_org_name_etag on Upload (organization_id, name, r2_etag);
```

Notes:
- `upload_event_id` is dedupe key for queue retries.
- `workflow_id` unique ensures one workflow per ingested event.
- `classification_json` stores full top-k output for future UI/API use.

## Deterministic IDs

- `upload_event_id = sha256("${r2_key}:${r2_etag}")`
- `workflow_id = "imgcls_" + upload_event_id`

Why:
- Queue duplicate deliveries for same R2 object collapse to same record/workflow.
- Retry after crash can safely call `runWorkflow` again with same `id`.

## End-to-End Sequence

1. User upload route writes object to R2 (already implemented).
2. R2 notification enters queue (prod) or simulated producer (local).
3. Queue consumer reads message, `R2.head(key)`, extracts metadata.
4. Queue consumer calls agent `ingestUploadEvent(payload)`.
5. Agent computes `upload_event_id`, upserts `Upload` with `status='ingested'`.
6. Agent starts workflow with deterministic `workflow_id`.
   - If duplicate workflow-id/tracking conflict => treat as idempotent success.
7. Agent updates row to `status='workflow_running'`.
8. Queue handler `ack()` message.
9. Workflow runs durable steps:
   - `step.do("load-image")`: read R2 object bytes
   - `step.do("classify-image")`: `env.AI.run("@cf/microsoft/resnet-50", { image: number[] })`
   - `step.do("persist-classification")`: agent RPC to write top label/score/full json and mark `classified`
10. On workflow error path, agent marks `classification_failed` with error string.

## Failure/Recovery Matrix

1. Crash before agent ingest call:
   - Message unacked -> retried -> normal path.
2. Crash after DB upsert, before workflow start:
   - Message unacked -> retried -> upsert no-op, workflow start retried.
3. Crash after workflow create, before row update:
   - Retry attempts same deterministic `workflow_id`; duplicate treated as success.
4. Duplicate queue deliveries:
   - Same `upload_event_id`; no duplicate logical work.
5. Workflow retries/restarts:
   - Non-durable calls may repeat; only side effects inside `step.do`.
6. AI transient failure:
   - workflow step retry semantics handle re-attempts.

## Implementation Changes

### 1) Agent: schema + ingest + persistence methods

File: `src/organization-agent.ts`

- Replace upload table initialization SQL.
- Replace `onUpload(upload: { name: string })` with `ingestUploadEvent(...)`.
- Add helper methods:
  - `upsertIngestedUpload(...)`
  - `markWorkflowRunning(...)`
  - `persistClassificationResult(...)`
  - `persistClassificationFailure(...)`
- Keep WebSocket broadcasts; add new message types for classification progress/complete/failure.

### 2) Queue consumer: pass full payload

File: `src/worker.ts`

- In `queue()`, after `head()`, call `stub.ingestUploadEvent({...})` with:
  - `organizationId`
  - `name`
  - `key`
  - `eTag`
  - `size`
  - `contentType`
  - `eventTime`

### 3) Workflow: repurpose `OrganizationWorkflow` for image classification

File: `src/organization-agent.ts`

- Update `OrganizationWorkflow` generic payload/progress/result types to image-classification domain.
- Workflow `run()` executes durable steps and writes back via agent RPC.
- Avoid side effects outside steps except lightweight progress broadcasts.

### 4) Upload listing/query shape

Files:
- `src/organization-agent.ts`
- `src/routes/app.$organizationId.upload.tsx`

- Update `getUploads()` return type/SQL for new columns.
- UI can remain minimal initially (name + createdAt) while storing classification fields for later display.

### 5) Type safety for Workers AI output

Files:
- `src/organization-agent.ts` (or shared schema module)

- Parse AI response with zod:
  - `z.array(z.object({ label: z.string(), score: z.number() }))`
- Handle empty array as classification failure.

## Suggested Workflow Payload Type

```ts
{
  uploadEventId: string;
  organizationId: string;
  name: string;
  key: string;
  eTag: string;
  size: number;
  contentType?: string;
}
```

## Suggested Progress Type

```ts
{
  status: "running" | "classified" | "failed";
  step: "load-image" | "classify-image" | "persist-classification";
  message: string;
}
```

## Open Decisions For Annotation

1. Version retention:
   - keep one row per `(organization_id, name, r2_etag)` (history) vs only latest per `name`
2. Classification storage:
   - top-1 only vs full top-k json
3. UI behavior:
   - show classification inline in upload list now vs defer
4. Failure policy:
   - terminal `classification_failed` only vs auto-requeue/manual retry endpoint
5. Workflow class split:
   - repurpose existing `OrganizationWorkflow` vs add `OrganizationImageClassificationWorkflow`

## Incremental Rollout Plan

1. Add schema + ingest path + deterministic IDs, keep existing UI.
2. Wire workflow classification + persistence.
3. Expose classification fields in `getUploads`.
4. Add UI rendering for top label/score + failed state.
5. Add retry action for failed rows (optional).

## Validation Checklist

- Upload one image locally -> row inserted -> workflow running -> classified.
- Re-send same queue message -> no duplicate row/workflow.
- Force crash between ingest and workflow start -> retry recovers.
- Force AI error -> row ends as `classification_failed`.
- Confirm queue message ack only after ingest success.

