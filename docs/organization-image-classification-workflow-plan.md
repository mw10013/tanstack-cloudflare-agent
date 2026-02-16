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
  - `object.key`, `eventTime` (`refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx:74`).
- Worker queue handler passes to agent:
  - `organizationId`, `name`, `eventTime`, `idempotencyKey`.

## 3) Agent state model (single source of truth per `name`)

Keep `name` as PK and add latest-upload + latest-classification columns so stale writes are rejected deterministically.

Required logical fields (camelCase):

- `name` (pk)
- `latestEventTime`
- `latestIdempotencyKey`
- `workflowStatus`
- `classificationLabel`
- `classificationScore`
- `classifiedAt`
- `updatedAt`

Get rid of the `latest` prefix. we don't fucking need it

## 4) Ordering and staleness rules

For every queue event:

- Queue handler forwards event metadata to agent; it does not do ordering logic.
- Agent `onUpload` compares incoming `eventTime` against stored `latestEventTime`.
- If older than current marker: no-op + `ack()`.
- If newer: upsert latest marker (`latestEventTime`, `latestIdempotencyKey`) first, then trigger workflow.

For workflow completion:

- Completion must include expected marker (`idempotencyKey`).
- Before writing classification, re-check row marker still matches expected `latestIdempotencyKey`.
- If marker mismatch, drop completion as stale (do not overwrite newer upload state).

`idempotencyKey` is the only authoritative stale-write guard.

## 5) Workflow launch/idempotency strategy

- Workflow ID = upload `idempotencyKey` (stable retry key).
- Call `runWorkflow(..., { id: idempotencyKey, metadata: ... })`.
- Handle duplicate-ID case (create error) as idempotent success path.
- No manual writes to `cf_agents_workflows` (avoid coupling to SDK internals).
- Pre-start guard must check both:
  - agent-visible state (`getWorkflow(idempotencyKey)` / tracked status), and
  - underlying workflow instance state via workflow binding status for `idempotencyKey`.
- If either indicates active/running/waiting, do not start another workflow for that key.
- If duplicate-ID create happens anyway, treat as equivalent to “already started” and continue with status polling/reconciliation via public APIs only.
- Rationale: `runWorkflow` create+tracking is non-atomic (`refs/agents/packages/agents/src/index.ts:1906`, `refs/agents/packages/agents/src/index.ts:1917`), so guards must not rely on tracking row alone.

We can't allow a duplicate-Id create haapens anyway. that is so fucking sloppy. Stop that shit. we need to reset to a known state.

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
- `runWorkflow` partial-failure simulation (create succeeded, tracking insert failed) => no duplicate workflow start; agent still converges using idempotency/status checks via public APIs.
- Local and production parity for queue flow (`src/routes/app.$organizationId.upload.tsx:90` local synthetic queue message path).

## Gaps / Decisions Needed (for your annotation)

1. Should `/app/$organizationId/workflow` be kept and repurposed, or removed from MVP scope?
2. Should classification be persisted in `Upload` table (extend) or split into dedicated `UploadClassification` table?
3. On AI/model failure, do we persist terminal `workflowStatus=errored` only, or include retryable backoff policy beyond default step retries?

ai/model failure should be retried at queue level.
