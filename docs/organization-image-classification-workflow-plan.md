# Organization Image Classification Workflow Plan (Design Review + Revision)

## Goal

When an image upload lands in R2 and emits an R2 event notification, run `OrganizationWorkflow` to classify the image with Workers AI `@cf/microsoft/resnet-50` through AI Gateway, and persist the latest classification in organization-agent SQLite.

This plan is design-only. No implementation steps executed yet.

## Review Verdict

### Correct in prior plan

- Queue delivery is at-least-once, duplicates possible (`refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`).
- `ack()` marks per-message delivery success (`refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx:58`).
- Workflow side effects outside `step.do` can repeat (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:218`).
- `runWorkflow()` creates workflow then inserts tracking row (non-atomic sequence): `refs/agents/packages/agents/src/index.ts:1906`, `refs/agents/packages/agents/src/index.ts:1917`.

### Incorrect / stale in prior plan

- Typo: `AI Gatewayy`.
- Baseline omitted current approval UI and RPC coupling:
  - `requestApproval`/`approveRequest`/`rejectRequest`/`listApprovalRequests` in `src/organization-agent.ts:333`.
  - Approval route depends on them: `src/routes/app.$organizationId.workflow.tsx:33`.
- Current queue->agent handoff drops event metadata (`eventTime`, `eTag`) and only sends `{ name }`: `src/worker.ts:130`, `src/worker.ts:158`, `src/organization-agent.ts:199`.
- Requirements numbering inconsistent and duplicated.

### Feasibility

Feasible with current stack (TanStack Start + Agents + Workflows + R2 + Queue). Core constraints are ordering and idempotency under:

- at-least-once queue delivery,
- non-atomic `runWorkflow` tracking,
- overwrite semantics for same object key.

## Evidence Excerpts

- Queue duplicates: “at least once delivery” and “may be delivered more than once” (`refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx:13`).
- Explicit ack semantics: “call the `ack()` method on the message” (`refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx:63`).
- Workflow side effects guidance: “side effects outside of steps… may be duplicated” (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:220`).
- Workflow `create` with custom ID can throw if ID exists (`refs/cloudflare-docs/src/content/docs/workflows/build/workers-api.mdx:277`).
- R2 notification includes `object.eTag` and `eventTime` (`refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:102`).
- ResNet output schema is array of `{ score, label }` (`refs/cloudflare-docs/src/content/workers-ai-models/resnet-50.json:56`).

## Revised Plan

## 1) Scope and non-goals

- Replace approval semantics in `OrganizationWorkflow` with classification workflow semantics.
- Preserve existing upload UX route; workflow route may be repurposed or deprecated in follow-up.
- No multi-label storage initially; store top-1 only.

## 2) Data contracts

- Upload write must include immutable per-upload id:
  - `idempotencyKey` (UUID) in R2 `customMetadata`.
- Queue notification payload already carries:
  - `object.key`, `object.eTag`, `eventTime` (`refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:74`).
- Worker queue handler passes to agent:
  - `organizationId`, `name`, `key`, `eventTime`, `eTag`, `idempotencyKey`.

## 3) Agent state model (single source of truth per `name`)

Keep `name` as PK and add latest-upload + latest-classification columns so stale writes are rejected deterministically.

Required logical fields:

- `name` (pk)
- `key`
- `latest_event_time`
- `latest_etag`
- `latest_idempotency_key`
- `last_workflow_id`
- `workflow_status`
- `classification_label`
- `classification_score`
- `classification_model` (e.g. `@cf/microsoft/resnet-50`)
- `classified_at`
- `updated_at`

Use camelCase. remove key, etag, workflow id (idempotencyKey is used as workflow id), model

## 4) Ordering and staleness rules

For every queue event:

- Compare incoming `(eventTime, eTag)` against row’s latest marker.
- If older than current marker: no-op + `ack()`.
- If newer: upsert latest marker first, then trigger workflow.

Forget eTag. queue handler can't do comparison of eventTime. onUpdate handler of agent should do it.

For workflow completion:

- Completion must include expected marker (`eventTime`, `eTag`, `idempotencyKey`).
- Before writing classification, re-check row marker still matches expected marker.
- If marker mismatch, drop completion as stale (do not overwrite newer upload state).

You are getting confused by the eTag. Maybe we should leave it out entirely so it doesn't confuse you. We don't care about the eTag. The idempotencyKey is generic.

Workflow must always check idenpotencyKey. That is the guard.



## 5) Workflow launch/idempotency strategy

- Workflow ID = upload `idempotencyKey` (stable retry key).
- Call `runWorkflow(..., { id: idempotencyKey, metadata: ... })`.
- Handle duplicate-ID case (create error) as idempotent success path.
- Reconciliation path for create/tracking split-brain:
  - if workflow exists but tracking row missing, insert tracking row explicitly in agent sqlite.
  - rationale: `runWorkflow` does `create` then tracking insert (`refs/agents/packages/agents/src/index.ts:1906`, `refs/agents/packages/agents/src/index.ts:1917`).

The agent helpers around workflows are not atomic or fault tolerant. I think we need to ensure a workflow with idempotency key is not running before we kick off a workflow. That is tricky because the agent workflow helpers are not atomic and the tracking insert may get missed.

We don't want to have to manually insert tracking row since that's implementation details we don't want to know. So we just need to make sure that agent doesn't think it's running a workflow and also the workflow is not running untracked by agent. 

## 6) Workflow definition changes

- Replace approval payload (`title`, `description`) with classification payload (object identity + marker fields).
- Remove `waitForApproval` path entirely.
- Ensure external side effects (AI inference, result persistence callback) are wrapped in `step.do` (`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx:218`).
- Return durable classification result payload from workflow and propagate via `onWorkflowComplete`.

## 7) AI invocation path

- Use Workers AI with AI Gateway pattern already present in agent (`src/organization-agent.ts:265`).
- Model: `@cf/microsoft/resnet-50`.
- Store top-1 label + score only.

## 8) Queue consumer behavior

- Keep explicit per-message `ack()`.
- On validation failures (missing metadata, missing object): log + `ack()` (terminal for that message).
- On transient internal failures: do not `ack()` message so queue retries by default policy.

## 9) App/UI impact (planned)

- Upload page message schema currently expects approval-era workflow states (`src/routes/app.$organizationId.upload.tsx:44`).
- Workflow page is approval-specific (`src/routes/app.$organizationId.workflow.tsx:33`).
- Plan update:
  - introduce classification-centric workflow message types/status.
  - decide whether to repurpose `/workflow` route to classification history/diagnostics or remove.

## 10) Validation plan (no code yet)

- Duplicate queue delivery for same event => one durable classification write.
- Two uploads same `name` out of order notifications => newest marker wins.
- Old workflow completion arriving late => rejected as stale.
- `runWorkflow` partial-failure simulation (create succeeded, tracking insert failed) => reconciliation restores tracking.
- Local and production parity for queue flow (`src/routes/app.$organizationId.upload.tsx:90` local synthetic queue message path).

## Gaps / Decisions Needed (for your annotation)

1. Should `/app/$organizationId/workflow` be kept and repurposed, or removed from MVP scope?
2. Should classification be persisted in `Upload` table (extend) or split into dedicated `UploadClassification` table?
3. For stale comparison, do we require both `eventTime` and `eTag` match, or `idempotencyKey` alone authoritative?
4. On AI/model failure, do we persist terminal `workflow_status=errored` only, or include retryable backoff policy beyond default step retries?
