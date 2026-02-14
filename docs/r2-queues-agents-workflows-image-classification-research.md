# R2 Notifications + Queues + Agents + Workflows + Image Classification Research

## Scope

- Cloudflare docs scanned in `refs/cloudflare-docs/src/content/docs/`
- Codebase scanned in:
  - `src/worker.ts`
  - `src/organization-agent.ts`
  - `src/routes/app.$organizationId.upload.tsx`
  - `src/routes/api/org.$organizationId.upload-image.$name.tsx`
  - `wrangler.jsonc`
- Goal: fault-tolerant image classification path for uploads in `OrganizationAgent`

## Current implementation (codebase)

### Upload write path

Source: `src/routes/app.$organizationId.upload.tsx`

```ts
await env.R2.put(key, data.file, {
  httpMetadata: { contentType: data.file.type },
  customMetadata: { organizationId, name: data.name },
});

if (env.ENVIRONMENT === "local") {
  await env.R2_UPLOAD_QUEUE.send({
    account: "local",
    action: "PutObject",
    bucket: env.R2_BUCKET_NAME,
    object: { key, size: data.file.size, eTag: "local" },
    eventTime: new Date().toISOString(),
  });
}
```

What this means:
- Uploads already attach `organizationId` + `name` in R2 `customMetadata`.
- Local dev already simulates notification enqueue.

### Queue consumer path

Source: `src/worker.ts`

```ts
const head = await env.R2.head(notification.object.key);
const organizationId = head.customMetadata?.organizationId;
const name = head.customMetadata?.name;
...
await stub.onUpload({ name });
message.ack();
```

What this means:
- Consumer fetches latest object metadata from R2 by key.
- It acks every processed message, including "missing object" and "missing metadata" branches.
- It does not yet classify images.

### Agent + workflow usage today

Source: `src/organization-agent.ts`

- `OrganizationAgent` extends `AIChatAgent<Env>`.
- `Upload` table is currently:

```sql
create table if not exists Upload (name text primary key, createdAt integer not null)
```

- Existing `OrganizationWorkflow` is approval workflow, not classification workflow.

### Infra config today

Source: `wrangler.jsonc`

- Queue producer/consumer configured with DLQ and retries:

```json
{
  "max_batch_size": 10,
  "max_batch_timeout": 5,
  "max_retries": 3,
  "dead_letter_queue": "r2-upload-notifications-dlq"
}
```

- Durable Object binding for `OrganizationAgent` and workflow binding for `OrganizationWorkflow` exist.

## Cloudflare findings with direct excerpts

### R2 notifications

Source: `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx`

- R2 -> Queue trigger:
  > "Event notifications send messages to your queue when data in your R2 bucket changes."
- Event types include create/overwrite + delete:
  > "`object-create` ... new objects ... existing objects are overwritten"
- Message shape includes:
  > `action`, `object.key`, `object.size`, `object.eTag`, `eventTime`
- Throughput note:
  > "per-queue message throughput is currently 5,000 messages per second"

### eTag and eventTime details (requested)

Source: `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx`

- `object.eTag`:
  > "The entity tag (eTag) of the object. Note: not present for object-delete events."
- `eventTime`:
  > "The time when the action that triggered the event occurred."

Interpretation for this system:
- `eTag` is usable as a version discriminator for object-create notifications.

Track down what this actually is. Don't be sloppy. 

- `eventTime` is useful metadata but not a strict ordering guarantee.

Track down what event time actually is. Go deep. It's obviously metadata but that says nothing useful. and what is your evidence about strict ordering guarentees?

### Queue ordering + delivery semantics

Source: `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx`

- Delivery model:
  > "Queues provides at least once delivery by default"

Source: `refs/cloudflare-docs/src/content/docs/queues/reference/how-queues-works.mdx`

- Ordering:
  > "Queues does not guarantee that messages will be delivered ... in the same order"

Source: `refs/cloudflare-docs/src/content/docs/queues/configuration/javascript-apis.mdx`

- Per-message metadata available:
  > "id: ... unique, system-generated ID"
  > "timestamp: ... when the message was sent"
  > "attempts: ... Starts at 1"

Implications:
- Do not depend on queue order for correctness.
- Build idempotency keys and stale-event checks.
- Use `attempts` for retry policy decisions.

### Queue retries and DLQ

Source: `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx`

- Batch defaults:
  > "max_batch_size ... defaults to 10"
  > "max_batch_timeout ... defaults to 5 seconds"
- Ack behavior:
  > "Messages ... explicitly acknowledged will not be re-delivered"
- Retry behavior:
  > "default behaviour is to retry delivery three times"

Source: `refs/cloudflare-docs/src/content/docs/queues/configuration/dead-letter-queues.mdx`

- DLQ behavior:
  > "Messages are delivered to the DLQ when they reach the configured retry limit"

### Workflows + Agents durability model

Source: `refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx`

- Split of responsibilities:
  > "Agents excel at real-time communication ... Workflows excel at durable execution"
- Non-durable methods:
  > "These methods may repeat on retry"
- Durable step methods:
  > "idempotent and will not repeat on retry"

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx`

- Idempotency:
  > "Because a step might be retried multiple times, your steps should ... be idempotent"
- State rules:
  > "Workflows may hibernate and lose all in-memory state"
- Side effects:
  > "Avoid doing side effects outside of a `step.do`"

Source: `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx`

- Default step retry config:
  > `limit: 5`, `backoff: 'exponential'`, `timeout: '10 minutes'`

## Workers AI model choice for image classification

### Evidence

Source: `refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/explore-workers-ai-models-using-a-jupyter-notebook.mdx`

- Cloudflare image-classification example runs:
  > `client.workers.ai.run("@cf/microsoft/resnet-50", ... image=...)`

Source: `refs/cloudflare-docs/src/content/docs/workers-ai/platform/limits.mdx`

- Task limit:
  > "Image Classification ... 3000 requests per minute"

Source: `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`

- Pricing table includes:
  > `@cf/microsoft/resnet-50 ... $2.51 per M images`

### Recommendation

Primary: `@cf/microsoft/resnet-50`

Why:
- Official Cloudflare example model for this exact task.
- High task-level throughput.
- Per-image pricing model is predictable.

Secondary (if you need custom visual reasoning/taxonomy mapping): `@cf/meta/llama-3.2-11b-vision-instruct`.

## eTag/eventTime strategy: idempotency + ordering

### Can `eTag` be used for idempotency?

Yes, with caveats.

Use idempotency key for create/overwrite events as:
- `(organizationId, object.key, action, object.eTag)`

Why this works:
- Queue is at-least-once, so duplicates happen.
- Same notification redelivery keeps same `eTag`.
- Overwrite to same key usually changes `eTag`, so new version becomes new key.

### Can `eventTime` be used for ordering?

Not as correctness primitive.

Why:
- Queue ordering is explicitly not guaranteed.
- `eventTime` is event occurrence timestamp, not delivery ordering contract.

Use `eventTime` for:
- observability
- UI timestamps
- tie-break display only

Your research is too shallow. Isn't eventTime from r2, not queues? show evidence

### Recommended stale-event guard

Before classifying, compare notification payload with current head:
- `head = await env.R2.head(key)`
- if `head` missing -> object deleted, skip/non-retryable
- if `notification.object.eTag` exists and `head.etag !== notification.object.eTag` -> stale event, ack and skip

This prevents classifying older object versions when newer overwrite already exists.

## Gap analysis (current vs target)

1. No classification pipeline yet.
- Consumer currently just calls `onUpload({ name })`.

2. Idempotency not explicit for future classifier side effects.
- Current dedupe is only `Upload.name`.

3. Retry policy is coarse.
- Missing metadata/object branches are ack+drop.
- No typed transient/permanent failure routing for classification.

4. No durable classification lifecycle state.
- No `queued/running/succeeded/failed` rows.

## Proposed fault-tolerant design

### High-level flow

1. Upload to R2 with custom metadata (already done).
2. R2 event notification to queue (prod) / manual queue send (local, already done).
3. Queue consumer validates payload and starts `ImageClassificationWorkflow`.
4. Workflow handles durable steps:
- `fetch-object`
- `classify-image`
- `persist-result`
- `notify-agent`
5. Queue message ack only after workflow instance creation succeeds.
6. Queue retries transient pre-workflow errors; DLQ catches exhausted failures.

### Workflow payload proposal

```ts
{
  organizationId: string,
  key: string,
  name: string,
  action: string,
  eTag?: string,
  eventTime: string,
  queueMessageId: string,
}
```

### Durable table proposal

`ImageClassification` (in agent SQLite)

- `organizationId text`
- `key text`
- `name text`
- `action text`
- `eTag text null`
- `status text` (`queued|running|succeeded|failed|skipped_stale`)
- `model text`
- `labels_json text null`
- `error text null`
- `eventTime text`
- `queueMessageId text`
- `createdAt integer`
- `updatedAt integer`
- primary key `(organizationId, key, action, coalesce(eTag, 'no-etag'))`

## Concrete changes implied in this repo

1. Add `ImageClassificationWorkflow` class in `src/organization-agent.ts` (or separate file).
2. Add workflow binding in `wrangler.jsonc` for both local + production env.
3. Update `src/worker.ts` `queue()` handler to start classification workflow and include stale-event guard.
4. Extend `OrganizationMessage` union with classification events.
5. Add callable methods to list/get classifications.
6. Update upload route UI to render classification status and top labels.
7. Add DLQ consumer handling path (or operational replay process).

## Implementation order

1. Data model + agent RPC surface.
2. Classification workflow + wrangler binding.
3. Queue consumer -> workflow trigger + eTag stale guard + retry policy.
4. UI integration.
5. DLQ replay tooling + load tests for duplicate and out-of-order notifications.

## References

- `refs/cloudflare-docs/src/content/docs/r2/buckets/event-notifications.mdx`
- `refs/cloudflare-docs/src/content/docs/r2/reference/consistency.mdx`
- `refs/cloudflare-docs/src/content/docs/r2/reference/durability.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/reference/delivery-guarantees.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/reference/how-queues-works.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/configuration/batching-retries.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/configuration/dead-letter-queues.mdx`
- `refs/cloudflare-docs/src/content/docs/queues/configuration/javascript-apis.mdx`
- `refs/cloudflare-docs/src/content/docs/agents/api-reference/agents-api.mdx`
- `refs/cloudflare-docs/src/content/docs/agents/api-reference/run-workflows.mdx`
- `refs/cloudflare-docs/src/content/docs/workflows/build/rules-of-workflows.mdx`
- `refs/cloudflare-docs/src/content/docs/workflows/build/sleeping-and-retrying.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/explore-workers-ai-models-using-a-jupyter-notebook.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/limits.mdx`
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`
- `src/worker.ts`
- `src/organization-agent.ts`
- `src/routes/app.$organizationId.upload.tsx`
- `wrangler.jsonc`
