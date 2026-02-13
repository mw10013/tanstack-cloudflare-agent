# R2 Presigned Thumbnail Upload Plan

## Goal

Update `src/routes/app.$organizationId.upload.tsx` to:

- accept images only
- validate upload name with `a-zA-Z`, `_`, `-` only
- display uploaded files as image thumbnails
- use R2 presigned URLs (via `aws4fetch`) for image display access
- improve layout so upload form and messages sit side-by-side

No Cloudflare Images service usage.

## Current Route Snapshot

From `src/routes/app.$organizationId.upload.tsx` now:

- accepts `image/png`, `image/jpeg`, and `application/pdf`
- text says `Upload images or PDF documents`
- upload list renders only filename + timestamp (no image preview)
- layout stacks upload form, uploads list, and messages vertically

## Docs Grounding (Cloudflare refs)

From `refs/cloudflare-docs/src/content/docs/r2/api/s3/presigned-urls.mdx`:

- presigned URLs are for temporary object access without exposing credentials
- supported operations include `GET`, `HEAD`, `PUT`, `DELETE`
- generated client-side using SigV4 credentials
- custom domains are not supported for presigned URLs; S3 API domain is required

From `refs/cloudflare-docs/src/content/docs/r2/examples/aws/aws4fetch.mdx`:

- `AwsClient` supports signing URLs with `aws: { signQuery: true }`
- signing with `X-Amz-Expires` sets validity window
- for signed uploads with content type restrictions, request headers must match signature

From `refs/cloudflare-docs/src/content/docs/r2/examples/aws/aws-sdk-js-v3.mdx`:

- `wrangler dev` cannot use S3-compatible API locally

From `refs/cloudflare-docs/src/content/docs/r2/get-started/workers-api.mdx`:

- local `wrangler dev` uses local R2 simulation by default
- remote bucket access in dev requires remote bindings

From `refs/cloudflare-docs/src/content/docs/r2/buckets/cors.mdx`:

- browser usage of presigned URLs requires CORS policy on bucket
- for image display via signed `GET`, `AllowedOrigins` + `AllowedMethods: ["GET"]` should be configured

## Proposed Approach

### 1) Validation + file type tightening

In both client form schema and server `inputValidator`:

- remove `application/pdf`
- allow only image MIME types (`image/png`, `image/jpeg`, optionally `image/webp`, `image/gif`)
- add strict name regex: `^[A-Za-z_-]+$`
- keep 5MB max (unless we decide to change)

Notes:

- retain `.trim().min(1)` plus regex for user feedback consistency
- keep same key convention `${organizationId}/${name}` unless versioning desired

### 2) Thumbnail URL generation strategy

Add server fn to generate short-lived signed GET URLs for each upload key using `aws4fetch`:

- `new AwsClient({ service: "s3", region: "auto", accessKeyId, secretAccessKey })`
- sign `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}?X-Amz-Expires=...`
- return `{ name, createdAt, thumbnailUrl, thumbnailExpiresAt }`

Auth model:

- keep org auth check in server fn (same pattern as `getUploads`)
- only signed URLs for caller’s active organization

Expiry recommendation:

- 5 to 15 minutes for UI rendering; refresh on route invalidate/reload

### 3) Local dev behavior

Because S3 API signing flow is not supported against local R2 simulation in `wrangler dev`, use environment split:

- production/staging: presigned URL
- local: return app route URL that proxies `env.R2.get(key)` through Worker server fn response

This keeps dev UX working without forcing remote R2 for every local run.

### 4) Thumbnail rendering in route

Replace plain uploads list with image-card/grid rendering:

- fixed thumbnail box (`w-24 h-24` or `w-28 h-28`) with object-cover
- fallback state if image fails to load (expired URL, missing object)
- filename + timestamp below/next to thumb

Implementation options:

- lightweight: use native `<img>`
- enhanced: use existing UI image wrapper if project has one

### 5) Layout changes (form + messages side-by-side)

Restructure `RouteComponent` layout:

- desktop: two-column grid
  - left: upload form
  - right: messages
- mobile: stack columns
- uploads gallery can remain full-width below the two-column section

Suggested Tailwind shape:

- `grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]`

### 6) Security + ops checklist

- ensure R2 API credentials available in worker env for signing
- ensure bucket CORS allows frontend origin(s) for `GET`
- use short URL expiry and regenerate frequently
- continue treating URL as bearer token

## Implementation Steps

1. Update upload validation and UI copy in `src/routes/app.$organizationId.upload.tsx`.
2. Add signed URL generation server fn (or extend loader path) with org authorization checks.
3. Add local-dev proxy path for image URL fallback.
4. Update uploads rendering to thumbnail cards.
5. Refactor layout to side-by-side form/messages on desktop.
6. Run `pnpm typecheck` and `pnpm lint`.

## Open Decisions For Iteration

1. Allowed image MIME set: strict (`png/jpeg`) or broader (`png/jpeg/webp/gif`)?
2. Signed URL TTL: 300s, 900s, or 3600s?
3. Local dev mode: always proxy locally, or require remote R2 when testing signed URLs?
4. Keep overwrite semantics for same `name`, or append suffix/version?

## Out of Scope (for this iteration)

- server-side thumbnail generation/transforms
- Cloudflare Images integration
- object lifecycle/cleanup automation

