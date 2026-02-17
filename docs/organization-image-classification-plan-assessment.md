# Plan vs. Implementation Assessment

## Overview

Assessment of how faithfully the [organization image classification workflow plan](./organization-image-classification-workflow-plan.md) is implemented across the codebase.

Files reviewed:

- `src/organization-agent.ts`
- `src/organization-messages.ts`
- `src/worker.ts`
- `src/routes/app.$organizationId.upload.tsx`
- `src/routes/app.$organizationId.workflow.tsx`
- `wrangler.jsonc`
- `worker-configuration.d.ts`

## Section-by-section

### 1) Scope and non-goals — Faithful

- Approval workflow (`OrganizationWorkflow`) preserved unchanged at `src/organization-agent.ts:123-183`.
- Separate `OrganizationImageClassificationWorkflow` class at `src/organization-agent.ts:185-233`.
- Wrangler workflow binding configured for both local and production in `wrangler.jsonc:36-47` and `:164-175`.
- Workflow route (`app.$organizationId.workflow.tsx`) left untouched for approval use.
- Top-1 only classification stored (single label + score).

### 2) Data contracts — Faithful

- `idempotencyKey` generated as `crypto.randomUUID()` and written to R2 `customMetadata` alongside `organizationId` and `name` (`upload.tsx:79-83`).
- Queue handler reads `organizationId`, `name`, `idempotencyKey` from `head.customMetadata` and passes `{ name, eventTime, idempotencyKey, r2ObjectKey }` to `onUpload` (`worker.ts:150-168`).
- Implementation also passes `r2ObjectKey` (needed by workflow). Reasonable addition not contradicted by plan.

### 3) Agent state model — Faithful

- `Upload` table schema at `src/organization-agent.ts:239-247` has all planned columns: `name` (PK), `eventTime`, `idempotencyKey`, `classificationLabel`, `classificationScore`, `classifiedAt`.
- `UploadRow` zod schema at `:85-94` matches, plus `createdAt`.

### 4) Ordering and staleness rules — Faithful

- `onUpload` at `:286-291` parses `eventTime`, loads existing row by `name`, skips if incoming `eventTime < existing.eventTime` (`:292-299`).
- On skip, broadcasts `classification_workflow_skipped` and returns.
- On newer event, upserts marker fields and clears classification columns (`:300-325`).
- `applyClassificationResult` at `:359-385` guards by checking `idempotencyKey` before writing classification. Stale completions are dropped.

**Minor observation**: The guard in `applyClassificationResult` is structurally tautological — see gap #2 below.

### 5) Workflow launch/idempotency — Mostly faithful (2 gaps)

- Workflow ID = `idempotencyKey` (`:345`).
- No manual writes to `cf_agents_workflows`.
- Reset-first flow implemented:
  - Agent tracking check via `getWorkflow` (`:326-329`).
  - Workflow binding ground truth check via `env.OrganizationImageClassificationWorkflow.get()` (`:330-338`).
  - Both layers attempt terminate if active.
- Local-dev policy: workflow control throws naturally and propagates to queue handler catch block resulting in `retry()`. Matches plan intent.

Gaps described in detail below.

### 6) Workflow definition — Faithful

- `OrganizationImageClassificationWorkflow` at `:185-233` with payload `{ idempotencyKey, r2ObjectKey }`.
- All side effects in `step.do`: image fetch (`:199-207`), AI classification (`:208-223`), result apply (`:224-230`).
- Returns classification result payload.
- Exported from `worker.ts:15`.

### 7) AI invocation path — Faithful

- Workers AI with `@cf/microsoft/resnet-50` (`:209`).
- AI Gateway with `AI_GATEWAY_ID` (`:213-216`).
- Top-1 only via `predictions[0]` (`:221`).

### 8) Queue consumer behavior — Faithful

- Explicit per-message `ack()` on terminal paths (missing head: `:147`, missing metadata: `:158`).
- On transient failure: `message.retry()` (`:181`). Plan says "do not `ack()`"; implementation explicitly retries, which is functionally equivalent and arguably better.
- Error logging includes relevant context (`:174-179`).

### 9) App/UI impact — Faithful

- Upload page renders classification label/score per card (`upload.tsx:342-346`) with "Classifying..." placeholder.
- Upload page wires classification websocket messages to `router.invalidate()` (`:166-172`).
- Workflow page unchanged, remains approval-specific.
- Message schema in `organization-messages.ts` includes all four classification event types: `classification_workflow_started`, `classification_workflow_skipped`, `classification_updated`, `classification_error`.
- Plan's optional inspector updates not implemented. Acceptable — plan marked as "Optional."

### 10) Validation plan — N/A

Plan described manual testing scenarios with "no code yet." No automated test code exists. Expected at this stage.

## Summary table

| Plan Section | Status |
|---|---|
| 1. Scope/non-goals | Faithful |
| 2. Data contracts | Faithful |
| 3. Agent state model | Faithful |
| 4. Ordering/staleness | Faithful (minor observation) |
| 5. Workflow launch/idempotency | Mostly faithful (2 gaps) |
| 6. Workflow definition | Faithful |
| 7. AI invocation | Faithful |
| 8. Queue consumer | Faithful |
| 9. UI impact | Faithful |
| 10. Validation | N/A |

## Gaps

### Gap 1: Binding `.get()` error swallowed

`src/organization-agent.ts:330-332`

```ts
const existingInstance = await this.env.OrganizationImageClassificationWorkflow
  .get(upload.idempotencyKey)
  .catch(() => null);
```

`.catch(() => null)` treats all errors — including transient network failures — as "no instance found." This undermines the plan's requirement that binding status is ground truth (plan section 5: "Use workflow binding status as ground truth when tracking and binding disagree").

A transient binding error would skip the terminate step and potentially allow a duplicate create attempt. The plan says if stop/terminate fails at the binding layer, treat as reset failure and throw (no `ack()`).

**Risk**: Under transient binding failures, the reset-first invariant is violated. A duplicate-ID create could follow, which the plan classifies as an invariant violation.

### Gap 2: Tautological staleness guard in `applyClassificationResult`

`src/organization-agent.ts:365-366`

```ts
const row = UploadRow.nullable().parse(this
  .sql<UploadRow>`select * from Upload where idempotencyKey = ${input.idempotencyKey}`[0] ?? null);
if (row?.idempotencyKey !== input.idempotencyKey) {
  return;
}
```

The query uses `WHERE idempotencyKey = ?`, so any returned row already has a matching `idempotencyKey`. The subsequent `row?.idempotencyKey !== input.idempotencyKey` check can only be true when `row` is null (no row found). It is never true when a row is found.

The guard still works correctly — stale writes are dropped because the query returns null when a newer upload has overwritten the idempotencyKey. However, the plan describes the logic as: "read current row by `name`, then check if `idempotencyKey` matches." The plan's pattern would be more defensive if multiple names could theoretically share an idempotencyKey. By design they cannot (UUID), so this is not a bug — but the code structure doesn't match the documented intent.

## Verdict

Implementation is **substantially faithful** to the plan. Both gaps involve edge-case resilience rather than core correctness under normal operation. The plan's design constraints around ground-truth verification and explicit invariant-violation handling are the areas where implementation takes shortcuts.
