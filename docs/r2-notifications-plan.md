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
  → head(key) to get customMetadata
  → agent.recordUpload({ name, contentType, size })
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

| Key | Value | Why |
|-----|-------|-----|
| `organizationId` | org ID from session | Route notification to correct OrganizationAgent DO |
| `name` | user-specified name | The logical name (key suffix), avoids parsing the R2 key |

The `organizationId` is critical: the queue consumer receives a raw R2 key like `org_abc/my-report` and needs to know which agent DO to call. It could parse the key prefix, but explicit metadata is clearer and doesn't break if key convention changes.

`contentType` comes from `httpMetadata` (set via `httpMetadata: { contentType: file.type }` on put), so no need to duplicate it in `customMetadata`.

## Schema

Drop `PendingUpload`. Simplify `Upload`:

```sql
create table if not exists Upload (
  name text primary key,
  contentType text not null,
  size integer not null,
  createdAt integer not null
)
```

- `name`: user-specified name, primary key (unique within org, same as before)
- `contentType`: from `httpMetadata.contentType` via `head()` — useful for serving/display
- `size`: from `head()` response — useful for display
- `createdAt`: `Date.now()` at record time (when notification is processed)

No `PendingUpload` table. No scavenging.

## Server Fn (Upload Path)

Simplified — no agent RPC calls:

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
    return { success: true, name: data.name, size: data.file.size };
  });
```

One call. If `R2.put` fails, the user gets an error. If it succeeds, the notification will eventually fire and the agent will record it.

## Queue Consumer (Notification Path)

New `queue()` handler in `src/worker.ts`:

```ts
export default {
  async fetch(request, env) { /* existing */ },
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
        console.error("Missing customMetadata on R2 object:", notification.object.key);
        message.ack();
        continue;
      }
      const id = env.ORGANIZATION_AGENT.idFromName(organizationId);
      const stub = env.ORGANIZATION_AGENT.get(id);
      await stub.recordUpload({
        name,
        contentType: head.httpMetadata?.contentType ?? "application/octet-stream",
        size: head.size,
      });
      message.ack();
    }
  },
};
```

## Agent Method

Replace `reserveUpload` + `confirmUpload` with single `recordUpload`:

```ts
@callable()
recordUpload(upload: { name: string; contentType: string; size: number }) {
  void this.sql`insert or replace into Upload (name, contentType, size, createdAt)
    values (${upload.name}, ${upload.contentType}, ${upload.size}, ${Date.now()})`;
}
```

Idempotent via `insert or replace`. If the notification fires twice (at-least-once delivery), the second call just overwrites with identical data.

## Wrangler Config Changes

Add queue consumer binding:

```jsonc
// wrangler.jsonc (both top-level and env.production)
"queues": {
  "consumers": [{
    "queue": "r2-upload-notifications",
    "max_batch_size": 10,
    "max_batch_timeout": 5
  }]
}
```

R2 bucket binding stays the same. No producer binding needed — R2 notifications push directly to the queue.

## Imperative Setup (Not in wrangler.jsonc)

Create the queue and notification rule via CLI — these are not declarable in config:

```sh
# Create the queue
npx wrangler queues create r2-upload-notifications

# Create notification rule: object-create events → queue
npx wrangler r2 bucket notification create uploads \
  --event-type object-create \
  --queue r2-upload-notifications
```

For production bucket (if different name):
```sh
npx wrangler queues create r2-upload-notifications --env production
npx wrangler r2 bucket notification create uploads \
  --event-type object-create \
  --queue r2-upload-notifications \
  --env production
```

## Edge Cases

### Same name, concurrent uploads

Two uploads with the same name both write to the same R2 key (last-write-wins). Each fires a notification. Each `head()` returns the latest object's metadata. `insert or replace` in the agent means the last `recordUpload` call wins. Consistent because R2 is the source of truth.

### Notification arrives but object was deleted

The `head()` call returns `null`. Consumer acks the message and moves on. No stale data.

### `head()` fails transiently

Consumer throws, message is retried per queue retry config (`max_retries`, default 3). Eventually lands in dead letter queue if configured.

### Object uploaded without customMetadata

Consumer logs an error and acks. Won't happen with our server fn, but guards against direct R2 API uploads.

### Re-upload (same name, different file)

New file overwrites in R2. New notification fires. `head()` returns new metadata. `insert or replace` updates the Upload row. Clean.

### Eventual consistency gap

Between `R2.put` returning and the notification being processed, the Upload table doesn't yet have the record. The upload route returns success immediately, so the UI shows success. If the user navigates to a list view, the upload might not appear for a few seconds. Accept this — it's the tradeoff for simplicity.

## Migration Steps

1. Add queue consumer config to `wrangler.jsonc`
2. Add `queue()` handler to `src/worker.ts`
3. Add `recordUpload()` method to `OrganizationAgent`, update `Upload` table schema (add `contentType`, `size` columns; rename `title` → `name`)
4. Simplify upload server fn: remove `reserveUpload`/`confirmUpload` calls, add `customMetadata` to `R2.put`
5. Remove `reserveUpload()`, `confirmUpload()` methods and `PendingUpload` table from agent
6. Rename `title` → `name` in form schema, UI labels, types
7. Run `wrangler types` to regenerate `worker-configuration.d.ts`
8. CLI setup: create queue and notification rule (manual, per environment)

## Open Questions

- Should we add a `listUploads` loader to the upload page so users see existing uploads? Currently `listUploads()` exists but isn't wired to a route loader.
- Dead letter queue: configure one for failed notification processing? Probably yes for production.
- Should the queue consumer also handle `object-delete` events to remove Upload rows when objects are deleted directly from R2?
- Local dev: does `wrangler dev` support R2 event notifications locally? If not, we may need a dev-mode fallback that calls `recordUpload` directly from the server fn.
