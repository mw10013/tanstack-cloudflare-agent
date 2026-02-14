# R2 Notifications + Queues + Agents + Workflows + Image Classification Research


The excerpts with just line number are fucking unhelpful. want to see the excerpt in the md file. I'm not going to fucking chase down the other files

## Scope

- Cloudflare docs reviewed in `refs/cloudflare-docs/src/content/docs/`
- App code reviewed: `src/worker.ts`, `src/organization-agent.ts`, `src/routes/app.$organizationId.upload.tsx`, `src/routes/api/org.$organizationId.upload-image.$name.tsx`, `wrangler.jsonc`
- Goal: design fault-tolerant image classification path for uploads handled by `OrganizationAgent`

## Cloudflare doc findings

### R2 event notifications

`refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx`

- R2 emits queue messages when bucket data changes.
  - Excerpt: line 8: "Event notifications send messages to your queue when data in your R2 bucket changes."
- Event rules support event type + prefix/suffix filtering.
  - Excerpt: lines 61-68: rules can filter, includes `object-create` and `object-delete`.
- Queue message body schema is explicit.
  - Excerpt: lines 72-104 include `account`, `action`, `bucket`, `object.key`, `object.size`, `object.eTag`, `eventTime`.
- Throughput note is explicit.
  - Excerpt: line 110: per-queue throughput currently 5,000 msg/s.

  Need more details about eTag and eventTime. What are they exactly? can they be use for idempotency and even ordering?

### R2 consistency/durability

`refs/cloudflare-docs/src/content/docs/r2/reference/consistency.mdx`

- R2 is strongly consistent for read-after-write, metadata updates, deletes, and list.
  - Excerpt: lines 28-31.
- Concurrent writes to same key are last-write-wins.
  - Excerpt: line 38.

`refs/cloudflare-docs/src/content/docs/r2/reference/durability.mdx`

- Durability target is 11 nines.
  - Excerpt: line 9.
- Write success requires persistence to disk before success response.
  - Excerpt: line 19.

### Queues behavior and reliability

`refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx`

- Delivery is at-least-once by default.
  - Excerpt: lines 13-15.
- Duplicate delivery must be handled with idempotency keys.
  - Excerpt: line 17.

`refs/cloudflare-docs/src/content/docs/queues/reference/how-queues-works.mdx`

- Queue keeps messages until successful consume.
  - Excerpt: line 24.
- Delivery order is not guaranteed.
  - Excerpt: line 26.
- One active consumer per queue.
  - Excerpt: line 160.

`refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx`

- Defaults: `max_batch_size=10`, `max_batch_timeout=5s`.
  - Excerpt: lines 22-23.
- Unacked failure causes full-batch redelivery.
  - Excerpt: line 141.
- Explicit `ack()` per message prevents redelivery of successful messages.
  - Excerpt: lines 58-61.
- Default retries is 3; then delete or DLQ if configured.
  - Excerpt: lines 131-134.

`refs/cloudflare-docs/src/content/docs/queues/configuration/dead-letter-queues.mdx`

- DLQ receives messages after retry limit.
  - Excerpt: lines 10-12.
- Without DLQ, failed messages after max retries are deleted.
  - Excerpt: line 12.

`refs/cloudflare-docs/src/content/docs/queues/configuration/local-development.mdx`

- Local queue simulation is supported.
  - Excerpt: lines 8, 29, 35.
- Remote dev mode unsupported for queues.
  - Excerpt: line 67.

### Agents + Workflows model

`refs/cloudflare-docs/src/content/docs/agents/api-reference/agents-api.mdx`

- Agents are server-side classes with state, methods, and client synchronization.
  - Excerpt: lines 20-21.
- Agents require Durable Objects.
  - Excerpt: line 25.

`refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx`

- Agent+Workflow split is explicit: agent for realtime, workflow for durable long tasks.
  - Excerpt: lines 14-17.
- Non-durable workflow operations may repeat on retry (`reportProgress`, broadcasts).
  - Excerpt: lines 157-160.
- Step methods are durable/idempotent boundaries.
  - Excerpt: lines 203-215.
- Agent can start tracked workflows via `runWorkflow()`.
  - Excerpt: lines 232-246.

`refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx`

- Steps should be idempotent.
  - Excerpt: lines 14-17.
- Do not rely on in-memory state outside steps (hibernation).
  - Excerpt: lines 123-126.
- Avoid side effects outside `step.do` unless repetition is acceptable.
  - Excerpt: lines 218-221.
- Step names should be deterministic (cache key).
  - Excerpt: lines 320-323.

`refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx`

- Default step retries: limit 5, exponential backoff, 10 minute timeout.
  - Excerpt: lines 57-67.

`refs/cloudflare-docs/src/content/docs/workflows/reference/limits.mdx`

- Max 1024 steps/workflow.
  - Excerpt: line 30.
- Max persisted state per step 1 MiB, event payload 1 MiB.
  - Excerpt: lines 26-27.
- Waiting instances do not count toward concurrency.
  - Excerpt: lines 56-59.

## Workers AI model research for image classification

### Evidence

`refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/explore-workers-ai-models-using-a-jupyter-notebook.mdx`

- Cloudflare example for image classification uses `@cf/microsoft/resnet-50` with `image=` bytes.
  - Excerpt: lines 366-380.

`refs/cloudflare-docs/src/content/docs/workers-ai/platform/limits.mdx`

- Image Classification task rate limit: 3000 req/min.
  - Excerpt: lines 24-27.

`refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`

- Pricing table includes `@cf/microsoft/resnet-50` priced per image.
  - Excerpt: line 107.

`refs/cloudflare-docs/src/content/docs/workers-ai/index.mdx`

- Workers AI supports image classification and other tasks.
  - Excerpt: line 65.

### Model recommendation

Primary recommendation: `@cf/microsoft/resnet-50` for first implementation.

Why:
- Native image-classification task model documented by Cloudflare examples.
- Task-level limit is high (3000 rpm), good for queue-driven async workloads.
- Priced per image, predictable for upload pipelines.
- Simpler output shape for deterministic post-processing.

Secondary option (if custom taxonomy / richer reasoning needed): `@cf/meta/llama-3.2-11b-vision-instruct`.

Why secondary:
- Better for open-ended visual reasoning and custom class mapping.
- Usually higher latency/cost and prompt-shape complexity than dedicated classifier.

Inference note:
- Cloudflare docs here do not provide benchmark tables comparing accuracy by dataset.
- Recommendation is based on task alignment + documented usage + throughput/pricing characteristics.

## Current codebase behavior (today)

### Upload write path

`src/routes/app.$organizationId.upload.tsx`

- Upload endpoint writes image directly to R2 with custom metadata:
  - `organizationId`, `name` (`lines 86-89`).
- In local env only, it manually sends a queue message to `R2_UPLOAD_QUEUE` (`lines 90-98`).
- Upload list is read from agent SQLite table `Upload` via `stub.getUploads()` (`lines 110-115`).

### Queue consume path

`src/worker.ts`

- `queue()` handler iterates messages (`line 128`).
- Reads object metadata via `env.R2.head(notification.object.key)` (`line 137`).
- Extracts `organizationId` and `name` from object custom metadata (`lines 146-148`).
- Calls `OrganizationAgent` instance by `idFromName(organizationId)` and invokes `onUpload({name})` (`lines 156-158`).
- Acks every processed message, including missing-object/missing-metadata branches (`lines 143, 153, 159`).

### Agent/Workflow usage

`src/organization-agent.ts`

- `OrganizationAgent` is `AIChatAgent<Env>` (`line 175`), maintains `Upload` table (`lines 178-179`), and broadcasts `upload_complete` on `onUpload` (`lines 199-204`).
- Existing `OrganizationWorkflow` is approval-oriented, not upload classification (`lines 113-173`).
- Workflow callbacks are wired to broadcast progress/complete/error (`lines 305-330`).
- Agent can run workflows and approve/reject them (`lines 332-399`).

### Infra bindings

`wrangler.jsonc`

- DO binding for `ORGANIZATION_AGENT` (`lines 28-34`).
- Workflow binding for `OrganizationWorkflow` (`lines 36-41`).
- Queue producer + consumer configured, with `max_retries: 3` and DLQ (`lines 63-77`).
- Same shape exists under production env (`lines 124-138`, `159-164`).

## Gap analysis for fault-tolerant image classification

1. No classification pipeline exists yet.
- Queue consumer currently only writes `{name, createdAt}` to `Upload` table via agent call.

2. Queue processing is at-least-once but downstream action not idempotency-keyed.
- `insert or replace` by `name` partially absorbs duplicates for upload listing.
- Classification side effects (future) would need stronger dedupe keying.

3. Error branches currently ack and drop.
- Missing metadata / missing object are acked immediately.
- For transient errors (AI timeout, network), current handler has no `retry()` strategy.

4. Queue handler currently does synchronous per-message sequential processing.
- Works for now, but classification calls will increase latency and retry surface.

5. No durable lifecycle/state for classification jobs.
- No status model (`queued`, `running`, `succeeded`, `failed`, `dead-lettered`).
- No replay/repair path from DLQ into main flow.

## Recommended architecture for classification

### Design choice

Use both:
- Queues for ingress decoupling from upload request path.
- Workflow for durable multi-step classification orchestration.

Reasoning:
- Queue decouples user upload latency from AI inference latency.
- Workflow gives durable retries, explicit state steps, and robust recovery semantics.

### Proposed flow

1. Upload server fn writes to R2 with metadata (already exists).
2. R2 notification enqueues message to `r2-upload-notifications` (prod) or manual send (local, already exists).
3. Queue consumer validates message + metadata, then starts workflow per object/version:
   - `runWorkflow("ImageClassificationWorkflow", { organizationId, name, key, eTag, eventTime })`
4. Workflow steps:
   - `step.do("fetch-object", ...)` -> `R2.get(key)`
   - `step.do("classify-image", ...)` -> `env.AI.run("@cf/microsoft/resnet-50", { image })`
   - `step.do("persist-result", ...)` -> write durable classification row keyed by `(organizationId, key, eTag)`
   - `step.do("notify-agent", ...)` -> call agent method to broadcast update
5. Queue consumer `ack()` only after workflow instance is successfully created.
6. For transient failures before workflow creation, `retry({delaySeconds})` from queue handler.
7. DLQ consumer path stores failure records and allows replay.

### Idempotency and dedupe keys

Use `(organizationId, key, eTag)` as primary identity.

Why:
- Queue is at-least-once.
- Same key may be overwritten (R2 last-write-wins).
- `eTag` distinguishes versions of same key.

### Suggested data model additions

- `ImageClassification` table in `OrganizationAgent` SQLite:
  - `organizationId text`
  - `key text`
  - `eTag text`
  - `name text`
  - `status text` (`queued|running|succeeded|failed`)
  - `model text`
  - `labels_json text`
  - `error text nullable`
  - `createdAt integer`
  - `updatedAt integer`
  - primary key `(organizationId, key, eTag)`

### Failure-handling policy

- Queue layer:
  - Use `msg.retry()` for transient errors before workflow creation.
  - Keep DLQ configured.
- Workflow layer:
  - Keep classification and persistence in separate deterministic `step.do` blocks.
  - Override retry config on AI step if needed.
  - Throw `NonRetryableError` for permanent validation errors (bad image type, missing object).

### Agent integration pattern

- Keep queue handler thin.
- Keep classification logic in Workflow.
- Use Agent methods for:
  - read model (`getClassifications`)
  - client broadcast (`classification_complete`, `classification_error`)
  - optional workflow status introspection (already supported by existing workflow helpers).

## Concrete implications for `src/organization-agent.ts`

- Extend `OrganizationMessage` union with classification events.
- Add callable list/read methods for classification rows.
- Add small mutation method used by workflow step (or persist directly in workflow if preferred).
- Keep current approval workflow unchanged; add second workflow class for classification to avoid mixing concerns.

## Practical implementation order

1. Add `ImageClassificationWorkflow` + binding in `wrangler.jsonc`.
2. Add classification table + RPC/read methods on `OrganizationAgent`.
3. Change queue consumer to start classification workflow (not direct `onUpload` only).
4. Add UI section in upload route to display classification status/labels.
5. Add DLQ consumer and replay command/script.
6. Load test for duplicate deliveries and overwrite race (`same key`, different `eTag`).

## Key references

- `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx`
- `refs/cloudflare-docs/src/content/docs/r2/reference/consistency.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/configuration/dead-letter-queues.mdx`
- `refs/cloudflare-docs/src/content/docs/agents/api-reference/agents-api.mdx`
- `refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx`
- `refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx`
- `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx`
- `refs/cloudflare-docs/src/content/docs/workflows/reference/limits.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/explore-workers-ai-models-using-a-jupyter-notebook.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/limits.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`
- `src/worker.ts`
- `src/organization-agent.ts`
- `src/routes/app.$organizationId.upload.tsx`
- `wrangler.jsonc`
