# R2 Notifications Plan

## Why Move

The current reservation pattern (`reserveUpload` → `R2.put` → `confirmUpload`) is three RPC calls orchestrated in the server fn. The server fn must stay alive for the entire upload. If it crashes after `R2.put` but before `confirmUpload`, the Upload table is out of sync and requires scavenging.

R2 event notifications invert this: the server fn does a single `R2.put`, and Cloudflare guarantees a notification fires after successful write. A queue consumer then records metadata in the agent. The upload is the source of truth — no reservation, no scavenging.

## Naming: `title` → `name`

Rename `title` to `name` throughout. Reasons:

- `name` matches R2/filesystem/Cloudflare conventions (`bucket name`, `object key`, `file name`)
- `title` implies a display label — but this value is used as the R2 key segment, making it a proper name/identifier
- `name` is shorter and more idiomatic in code: `upload.name` reads better than `upload.title`

Schema, types, form labels, column names all change from `title` to `name`.

## Architecture

```
Client → FormData (name + file)
  → server fn
    → R2.put(key, file, { httpMetadata, customMetadata })
  → return success

R2 bucket ──notification──→ Queue ──batch──→ Worker queue() handler
                                                ──fail──→ Dead Letter Queue
  → head(key) to get customMetadata
  → agent.onUpload({ name })
```

Two independent paths: upload path (fast, user-facing) and notification path (async, eventually consistent).

## R2 Key Convention

Same as before:

```
${organizationId}/${name}
```

## R2 Custom Metadata

R2 notifications only include `object.key`, `object.size`, `object.eTag` — no custom metadata, no content type. The queue consumer must call `head(key)` to retrieve metadata. To avoid `head()` entirely, we could encode everything in the key, but that's fragile.

**Decision: always `head()` in the queue consumer.** Reasons:

- `head()` is cheap (no body transfer, just metadata)
- Gives us `customMetadata`, `httpMetadata.contentType`, `size`, `uploaded` timestamp — all from one call
- Decouples what we store in R2 metadata from what the notification schema provides
- Future-proof: if we add more custom metadata fields, the consumer automatically gets them

### What to store in `customMetadata` on `R2.put`:

| Key              | Value               | Why                                                      |
| ---------------- | ------------------- | -------------------------------------------------------- |
| `organizationId` | org ID from session | Route notification to correct OrganizationAgent DO       |
| `name`           | user-specified name | The logical name (key suffix), avoids parsing the R2 key |

The `organizationId` is critical: the queue consumer receives a raw R2 key like `org_abc/my-report` and needs to know which agent DO to call. It could parse the key prefix, but explicit metadata is clearer and doesn't break if key convention changes.

`contentType` comes from `httpMetadata` (set via `httpMetadata: { contentType: file.type }` on put), so no need to duplicate it in `customMetadata`.

## Schema

Drop `PendingUpload`. Simplify `Upload`:

```sql
create table if not exists Upload (name text primary key, createdAt integer not null)
```

- `name`: user-specified name, primary key (unique within org, same as before)
- `createdAt`: `Date.now()` at record time (when notification is processed)

No `contentType` or `size` columns — R2 is the source of truth for object metadata. Retrieve via `head()` on demand if needed for display.

No `PendingUpload` table. No scavenging.

## Server Fn (Upload Path)

Simplified — no agent RPC calls in production. In local dev, manually produces a fake notification to the queue since R2 event notifications do not fire locally (confirmed: wrangler dev / miniflare does not simulate the R2 → Queue notification pipeline — see "Local Dev" section below).

```ts
const uploadFile = createServerFn({ method: "POST" })
  .inputValidator(/* same validation */)
  .handler(async ({ context: { session, env }, data }) => {
    const organizationId = session.session.activeOrganizationId;
    const key = `${organizationId}/${data.name}`;
    await env.R2.put(key, data.file, {
      httpMetadata: { contentType: data.file.type },
      customMetadata: { organizationId, name: data.name },
    });
    if (env.ENVIRONMENT === "local") {
      await env.R2_UPLOAD_QUEUE.send({
        account: "local",
        action: "PutObject",
        bucket: "uploads",
        object: { key, size: data.file.size, eTag: "local" },
        eventTime: new Date().toISOString(),
      });
    }
    return { success: true, name: data.name, size: data.file.size };
  });
```

- Production: `R2.put` only. Notification fires via Cloudflare infrastructure.
- Local: `R2.put` + manual `send()` to the queue. Exercises the full `queue()` → `head()` → `onUpload()` path locally.

## Queue Consumer (Notification Path)

New `queue()` handler in `src/worker.ts`. Only processes `object-create` notifications (`PutObject`, `CopyObject`, `CompleteMultipartUpload`). No `object-delete` handling — deletes are managed via the app, not via R2 notifications.

```ts
export default {
  async fetch(request, env) {
    /* existing */
  },
  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) {
      const notification = message.body as {
        account: string;
        action: string;
        bucket: string;
        object: { key: string; size: number; eTag: string };
        eventTime: string;
      };
      const head = await env.R2.head(notification.object.key);
      if (!head) {
        // Object was deleted between notification and processing — skip
        message.ack();
        continue;
      }
      const organizationId = head.customMetadata?.organizationId;
      const name = head.customMetadata?.name;
      if (!organizationId || !name) {
        console.error(
          "Missing customMetadata on R2 object:",
          notification.object.key,
        );
        message.ack();
        continue;
      }
      const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
      const stub = env.ORGANIZATION_AGENT.get(id);
      await stub.onUpload({
        name,
      });
      message.ack();
    }
  },
};
```

## Agent Method

Replace `reserveUpload` + `confirmUpload` with single `onUpload`:

```ts
onUpload(upload: { name: string }) {
  void this.sql`insert or replace into Upload (name, createdAt)
    values (${upload.name}, ${Date.now()})`;
}
```

Idempotent via `insert or replace`. If the notification fires twice (at-least-once delivery), the second call just overwrites with identical data. No `@callable` decorator — only called server-side from the queue consumer, never from client RPC.

## Wrangler Config Changes

Add queue consumer binding and producer binding (producer needed for local dev simulation):

```jsonc
// wrangler.jsonc (both top-level and env.production)
"queues": {
  "producers": [{
    "queue": "r2-upload-notifications",
    "binding": "R2_UPLOAD_QUEUE"
  }],
  "consumers": [{
    "queue": "r2-upload-notifications",
    "max_batch_size": 10,
    "max_batch_timeout": 5,
    "max_retries": 3,
    "dead_letter_queue": "r2-upload-notifications-dlq"
  }]
}
```

- Consumer: receives notifications (from R2 in production, from producer in local dev)
- Producer (`R2_UPLOAD_QUEUE`): only used in local dev to simulate the notification that R2 would normally fire. In production it's unused but harmless — just a binding that sits there.
- Dead letter queue (`r2-upload-notifications-dlq`): auto-created by Cloudflare if it doesn't exist. Messages that fail after `max_retries` (3) land here instead of being permanently deleted. Messages persist for 4 days without a consumer.
- R2 bucket binding stays the same.

## Imperative Setup (Not in wrangler.jsonc)

Create the queue and notification rule via CLI — these are not declarable in config:

```sh
# Create the queue
pnpm exec wrangler queues create r2-upload-notifications

# Create notification rule: object-create events → queue
pnpm exec wrangler r2 bucket notification create uploads \
  --event-type object-create \
  --queue r2-upload-notifications
```

For production bucket (if different name):

```sh
pnpm exec wrangler queues create r2-upload-notifications --env production
pnpm exec wrangler r2 bucket notification create uploads \
  --event-type object-create \
  --queue r2-upload-notifications \
  --env production
```

## Edge Cases

### Same name, concurrent uploads

Two uploads with the same name both write to the same R2 key (last-write-wins). Each fires a notification. Each `head()` returns the latest object's metadata. `insert or replace` in the agent means the last `onUpload` call wins. Consistent because R2 is the source of truth.

### Notification arrives but object was deleted

The `head()` call returns `null`. Consumer acks the message and moves on. No stale data.

### `head()` fails transiently

Consumer throws, message is retried per queue retry config (`max_retries`: 3). After exhausting retries, the message lands in the dead letter queue (`r2-upload-notifications-dlq`) for inspection.

### Object uploaded without customMetadata

Consumer logs an error and acks. Won't happen with our server fn, but guards against direct R2 API uploads.

### Re-upload (same name, different file)

New file overwrites in R2. New notification fires. `head()` returns new metadata. `insert or replace` updates the Upload row. Clean.

### Eventual consistency gap

Between `R2.put` returning and the notification being processed, the Upload table doesn't yet have the record. The upload route returns success immediately, so the UI shows success. If the user navigates to a list view, the upload might not appear for a few seconds. Accept this — it's the tradeoff for simplicity.

## Local Dev

R2 event notifications **do not work locally**. `wrangler dev` / miniflare simulates R2 storage and Queues producer→consumer, but not the R2 → Queue notification pipeline. This is a Cloudflare infrastructure-level feature with no local simulation. Confirmed via:

- [Cloudflare Community thread (Mar 2025)](https://community.cloudflare.com/t/test-r2-event-notifications-queues-locally/782729): zero workarounds, zero replies from Cloudflare
- Queues local dev docs only cover Worker-to-Worker produce/consume
- No GitHub issues or PRs in `cloudflare/workers-sdk` for this
- Queues also don't work in remote mode (`wrangler dev --remote`)

**Workaround: producer-side simulation.** The server fn checks `env.ENVIRONMENT === "local"` and manually sends a fake R2 notification message to the queue via the producer binding (`R2_UPLOAD_QUEUE`). Since Queues producer→consumer _does_ work locally in miniflare, this exercises the real `queue()` handler code path including `head()` and `onUpload()`.

What this tests locally:

- `R2.put` with `customMetadata` ✓
- Queue message delivery and batching ✓
- `queue()` handler parsing ✓
- `R2.head()` retrieving metadata from local R2 ✓
- Agent RPC `onUpload()` ✓

What this does NOT test locally:

- The actual R2 → Queue notification trigger (infrastructure-only, deploy to test)
- Notification filtering by prefix/suffix rules

## Migration Steps

1. Add queue producer + consumer config to `wrangler.jsonc` (both top-level and env.production)
2. Add `queue()` handler to `src/worker.ts`
3. Add `onUpload()` method to `OrganizationAgent`, update `Upload` table schema (rename `title` → `name`)
4. Update upload server fn: remove `reserveUpload`/`confirmUpload` calls, add `customMetadata` to `R2.put`, add local dev queue simulation
5. Remove `reserveUpload()`, `confirmUpload()` methods and `PendingUpload` table from agent
6. Rename `title` → `name` in form schema, UI labels, types
7. Run `wrangler types` to regenerate `worker-configuration.d.ts`
8. CLI setup: create queue and notification rule (manual, per environment)

## Open Questions

- Should we add a `listUploads` loader to the upload page so users see existing uploads? Currently `listUploads()` exists but isn't wired to a route loader.
