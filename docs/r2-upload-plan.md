# R2 Upload Plan

## Overview

Upload files to R2 with metadata tracked in OrganizationAgent's SQLite using a reservation pattern to handle the non-atomic nature of R2 put + metadata recording.

## R2 Setup

Bucket name: `uploads` (plural — matches Cloudflare convention: `screenshots`, `employee-avatars`, `d1-backups`, etc.). Binding: `R2`.

```jsonc
// wrangler.jsonc (both top-level and env.production)
"r2_buckets": [{ "binding": "R2", "bucket_name": "uploads" }]
```

## Key Convention

```
${organizationId}/${title}
```

- `organizationId`: from `session.session.activeOrganizationId` in server fn context
- `title`: user-specified, no file extension required
- Same title = same R2 key = overwrite (intentional, last-write-wins)

## Schema

Two tables in OrganizationAgent's SQLite. Convention: singular PascalCase table names, camelCase columns.

`title` is the primary key in both tables — it's the unique identifier within an org (the DO is already org-scoped). The R2 key is derived from orgId + title at the server fn level.

```sql
create table PendingUpload (
  title text primary key,
  createdAt integer not null
);

create table Upload (
  title text primary key,
  createdAt integer not null
);
```

## Flow

```
Client → FormData (title + file)
  → server fn
    → 1. stub.reserveUpload(title)       -- insert or replace into PendingUpload
    → 2. env.R2.put(key, file)           -- key = ${orgId}/${title}
    → 3. stub.confirmUpload(title)       -- delete PendingUpload + insert or replace Upload
  → return success
```

### `reserveUpload(title)`

```sql
insert or replace into PendingUpload (title, createdAt) values (?, ?)
```

Idempotent. Handles:
- Fresh upload: inserts new row
- Retry / double-click: replaces existing pending
- Re-upload of previously completed title: creates pending alongside existing Upload

### `confirmUpload(title)`

Atomic within DO's single-writer SQLite. `createdAt` is carried over from the PendingUpload row (represents when the user initiated the upload, not when confirm runs):

```sql
-- read createdAt from PendingUpload first
delete from PendingUpload where title = ?;
insert or replace into Upload (title, createdAt) values (?, ?);  -- createdAt from PendingUpload
```

Handles:
- Fresh upload: deletes pending, inserts upload
- Re-upload: deletes pending, replaces existing upload with new createdAt

### Server fn error handling

```ts
await stub.reserveUpload(title);
try {
  await env.R2.put(key, file, { httpMetadata, customMetadata });
  await stub.confirmUpload(title);
} catch (e) {
  // R2 put or confirm failed.
  // PendingUpload remains for future scavenging.
  throw e;
}
```

No attempt to clean up on failure — scavenging handles it.

## Edge Cases

### Same title, concurrent uploads

Two uploads with the same title race. Both reserve (last `insert or replace` wins in PendingUpload). Both R2 puts write to same key (last-write-wins). Last confirm wins in Upload. Consistent because same key everywhere.

### PendingUpload coexists with Upload (same title)

Occurs when a re-upload's confirm fails. PendingUpload.createdAt is always newer than Upload.createdAt.

| R2 state | Meaning | Scavenger action (future) |
|---|---|---|
| Has new file | R2 put succeeded, confirm failed | `head()` confirms existence → delete PendingUpload, update Upload.createdAt |
| Has old file | R2 put failed | delete PendingUpload (Upload still valid with old file) |

### Stale PendingUpload with no corresponding Upload

First upload attempt failed after reserve. No Upload row, R2 may or may not have the file.

| R2 state | Scavenger action (future) |
|---|---|
| Object exists | Confirm it: delete PendingUpload, insert Upload |
| No object | Delete PendingUpload |

## Scavenging (Future)

Not implemented now. Notes for later:

- Agent has access to `this.env.R2` for `head()` calls
- Query: `select * from PendingUpload where createdAt < ?` (e.g., 5 minutes old)
- For each stale pending: `head(${orgId}/${title})` to determine R2 state, then reconcile
- Trigger: cron (already configured in wrangler.jsonc) or agent `setInterval`
- The agent needs to know its orgId to derive R2 keys — store it or receive it

## Open Questions

- How does the agent know its organizationId for deriving R2 keys during scavenging? Options: store in agent state on first use, or pass it to scavenger method.
- Should `Upload.createdAt` reflect the original reserve time or the confirm time? Currently using confirm time (when the upload is actually ready).
- File extension: title has no extension. `contentType` from the file's MIME type is set via `httpMetadata` on R2 put but not tracked in SQLite. Add later if needed for display/serving.

## Components to Implement

1. **wrangler.jsonc**: Add R2 binding
2. **OrganizationAgent**: `reserveUpload()`, `confirmUpload()` callable methods + table creation
3. **upload route server fn**: Use session for orgId, call reserve → R2 put → confirm
4. **worker-configuration.d.ts**: Regenerate with `wrangler types`
