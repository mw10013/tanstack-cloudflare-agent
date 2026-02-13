# R2 Presigned Thumbnail Upload Plan

## Goal

Update `src/routes/app.$organizationId.upload.tsx` to:

- accept images only
- validate upload name with `a-zA-Z`, `_`, `-` only
- display uploaded files as image thumbnails
- use R2 presigned URLs (via `aws4fetch`) for image display access
- improve layout so upload form and messages sit side-by-side

No Cloudflare Images service usage.

## Decisions (from iteration)

- image MIME allowlist: broader set (`image/png`, `image/jpeg`, `image/webp`, `image/gif`)
- signed URL TTL: `900` seconds (15 minutes)
- local development: use proxy path, not presigned URLs
- same name behavior: keep overwrite semantics (last write wins)
- image rendering component: native `<img>` (no project image wrapper)

## Docs Grounding

Cloudflare refs used:

- `refs/cloudflare-docs/src/content/docs/r2/api/s3/presigned-urls.mdx`
- `refs/cloudflare-docs/src/content/docs/r2/examples/aws/aws4fetch.mdx`
- `refs/cloudflare-docs/src/content/docs/r2/examples/aws/aws-sdk-js-v3.mdx`
- `refs/cloudflare-docs/src/content/docs/r2/get-started/workers-api.mdx`
- `refs/cloudflare-docs/src/content/docs/r2/buckets/cors.mdx`

Key constraints reflected in plan:

- presigned URLs require S3 API signing and use `<ACCOUNT_ID>.r2.cloudflarestorage.com`
- local `wrangler dev` uses local R2 simulation and does not support S3 API flows
- browser usage of presigned URLs requires bucket CORS

## Current System Notes

From code:

- `src/routes/app.$organizationId.upload.tsx` currently accepts PNG/JPEG/PDF
- `src/worker.ts` queue consumer reads `customMetadata.organizationId` + `customMetadata.name` from R2 object and calls `stub.onUpload({ name })`
- `src/organization-agent.ts` stores uploads as `Upload(name, createdAt)`

Implication:

- we should keep existing R2 `customMetadata` keys unchanged

## aws4fetch Dependency + refs script

- `aws4fetch` is present in lockfile transitively, not direct dependency in `package.json`
- plan: add direct dependency pinned to latest available stable via `pnpm view aws4fetch version`
- plan: add `refs:aws4fetch` script in `package.json` to mirror existing `refs:*` workflow (download source tarball into `refs/aws4fetch`)

## Required Env Vars For Signing

Existing env already has `CF_ACCOUNT_ID`. For presigned URL generation add:

What are these S3 keys? where do I get them? i don't have an aws account or s3 bucket.

- `R2_S3_ACCESS_KEY_ID`
- `R2_S3_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME` (value: `uploads`)

Where:

- add to `wrangler.jsonc` (`vars` and `env.production.vars` placeholders)
- add to `.env.example`
- regenerate types with `pnpm typecheck` (runs `wrangler types`)

## URL Strategy

### Production / non-local

- generate presigned GET URLs with `aws4fetch`
- endpoint format: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}?X-Amz-Expires=900`
- sign with `AwsClient.sign(request, { aws: { signQuery: true } })`

### Local

- return app-local proxy URL instead of presigned URL
- proxy handler fetches object using `env.R2.get(key)` and returns bytes
- enforce same org auth check before returning bytes

## Local Proxy Details

Add new route for thumbnail proxy, example:

- `src/routes/api/org.$organizationId.upload-image.$name.tsx` (exact naming flexible)

Behavior:

1. verify session exists
2. verify `session.session.activeOrganizationId === organizationId`
3. load `key = ${organizationId}/${name}` from `env.R2`
4. return `404` if missing
5. return object body with:
   - `Content-Type` from `httpMetadata.contentType` (fallback `application/octet-stream`)
   - `Cache-Control: private, max-age=60`
   - optional `ETag`

## Route Data Shape Changes

In upload page loader result, return per row:

- `name: string`
- `createdAt: number`
- `thumbnailUrl: string`
- `thumbnailExpiresAt: number | null` (null for local proxy)

i don't think we need expiresAt. or do we? should the agent DO or the server fn generate the thumbnailUrl? and why?

Data source remains `stub.getUploads()` then enrich in server fn before return.

## UI Changes in `src/routes/app.$organizationId.upload.tsx`

### Validation

- client and server schema: remove PDF MIME
- name rule: `z.string().trim().min(1).regex(/^[A-Za-z_-]+$/)`
- input copy updates to image-only messaging

### Layout

- top area becomes responsive 2-column grid:
  - left: upload form card
  - right: messages card
- uploads gallery remains below as full-width section

### Thumbnail gallery

- render cards with fixed thumb frame and native `<img>`
- set `loading="lazy"`
- use `object-cover`
- include fallback placeholder on load error
- retain filename + timestamp text

## CORS Checklist

is cors really necessary? check cloudflare-docs.

For non-local browser display via presigned GET, R2 bucket CORS should include:

- `AllowedOrigins`: app origin(s)
- `AllowedMethods`: `GET` (and `HEAD` optional)
- `AllowedHeaders`: minimal needed for requests

## Implementation Steps

1. Add `aws4fetch` direct dependency and add `refs:aws4fetch` script.
2. Add new env vars to Wrangler config / env examples.
3. Update upload route validation + copy to image-only and strict name regex.
4. Add URL enrichment server fn (presigned for non-local, proxy URL for local).
5. Add local proxy route for image bytes with org auth guard.
6. Convert uploads list into thumbnail gallery.
7. Refactor layout to side-by-side form/messages on desktop.
8. Run `pnpm typecheck` and `pnpm lint`.

## Acceptance Criteria

- selecting PDF is rejected by accept filter + validation
- invalid names (`a b`, `a/b`, `foo.png`) are rejected
- valid names (`avatar_main`, `team-photo`) are accepted
- uploads render image thumbnails
- desktop layout shows upload form and messages side-by-side
- local env thumbnails work without remote R2
- production/staging thumbnails use presigned GET URLs

## Out of Scope

- Cloudflare Images transforms
- thumbnail preprocessing pipeline
- lifecycle cleanup and retention automation
