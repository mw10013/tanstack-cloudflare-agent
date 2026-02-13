# Cloudflare Images & R2 Thumbnails

Guide for handling image uploads and serving thumbnails using Cloudflare Images for processing and R2 for storage.

## Overview

This setup:

- Stores original images in private R2 bucket
- Pre-generates thumbnails on upload using Cloudflare Images
- Serves thumbnails via presigned URLs (production) or Worker proxy (local dev)

## Why This Approach

**Problem:** User uploads 4000x3000px (5MB) image. Site needs:

- 100x100px avatar
- 200x200px preview
- 400x300px card view

Without processing: 5MB sent to mobile users for a tiny thumbnail. Slow, expensive, bad UX.

**Solution:**

1. Store original in private R2
2. Generate thumbnails once on upload
3. Serve thumbnails efficiently

## Architecture

```
User Upload
    ↓
Worker receives image
    ↓
┌─────────────────┐
│ 1. Save original │ → R2: /originals/{id}.jpg
│    to R2         │
├─────────────────┤
│ 2. Generate      │ → Cloudflare Images binding
│    thumbnails    │    (width, height, format)
├─────────────────┤
│ 3. Save thumbs   │ → R2: /thumbnails/{id}-100x100.avif
│    to R2         │     R2: /thumbnails/{id}-200x200.avif
└─────────────────┘
    ↓
Serve Request
    ↓
┌─────────────────┐
│ Production:     │ → Redirect to presigned URL
│ Presigned URL   │    (client downloads from R2 directly)
├─────────────────┤
│ Local Dev:      │ → Worker proxies from local R2
│ Worker Proxy    │    (presigned URLs don't work locally)
└─────────────────┘
```

## Implementation

### 1. Configuration

```toml
# wrangler.toml
name = "image-service"
main = "src/index.ts"
compatibility_date = "2025-02-12"

[images]
binding = "IMAGES"

[[r2_buckets]]
binding = "R2"
bucket_name = "my-images"

[vars]
ACCOUNT_ID = "your-account-id"

[env.production.vars]
NODE_ENV = "production"

[env.local.vars]
NODE_ENV = "development"
```

### 2. Upload Handler

```typescript
// src/handlers/upload.ts
import { Env } from "../types";

export const handleUpload = async (
  imageStream: ReadableStream,
  filename: string,
  env: Env,
): Promise<void> => {
  // Read once, use multiple times
  const imageBuffer = await new Response(imageStream).arrayBuffer();
  const id = crypto.randomUUID();

  // 1. Save original
  await env.R2.put(`originals/${id}.jpg`, imageBuffer, {
    httpMetadata: { contentType: "image/jpeg" },
  });

  // 2. Generate thumbnails
  const sizes = [
    { suffix: "thumb-sm", width: 100, height: 100 },
    { suffix: "thumb", width: 200, height: 200 },
    { suffix: "card", width: 400, height: 300 },
  ];

  await Promise.all(
    sizes.map(async ({ suffix, width, height }) => {
      const transformed = await env.IMAGES.input(imageBuffer)
        .transform({ width, height, fit: "cover" })
        .output({ format: "image/avif", quality: 85 });

      await env.R2.put(
        `thumbnails/${id}-${suffix}.avif`,
        transformed.response().body,
        { httpMetadata: { contentType: "image/avif" } },
      );
    }),
  );

  return id; // Return ID for reference
};
```

### 3. Serving Thumbnails

```typescript
// src/handlers/serve.ts
import { AwsClient } from "aws4fetch";
import { Env } from "../types";

const IS_LOCAL = process.env.NODE_ENV !== "production";

// Production: Presigned URL
const getPresignedUrl = async (key: string, env: Env): Promise<string> => {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  const signed = await client.sign(
    new Request(
      `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${key}?X-Amz-Expires=3600`,
      { method: "GET" },
    ),
    { aws: { signQuery: true } },
  );

  return signed.url.toString();
};

// Local: Worker proxy
const proxyFromR2 = async (key: string, env: Env): Promise<Response> => {
  const object = await env.R2.get(key);

  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/avif",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
};

export const serveThumbnail = async (
  request: Request,
  env: Env,
  key: string,
): Promise<Response> => {
  // Add auth check here if needed
  // const session = await validateSession(request);
  // if (!session) return new Response('Unauthorized', { status: 401 });

  if (IS_LOCAL) {
    // Local dev: Worker proxy (presigned URLs don't work with local R2)
    return proxyFromR2(`thumbnails/${key}`, env);
  }

  // Production: Redirect to presigned URL (cheaper, faster)
  const signedUrl = await getPresignedUrl(`thumbnails/${key}`, env);
  return Response.redirect(signedUrl, 302);
};
```

## Approach Comparison

### Presigned URLs vs Worker Proxy

| Aspect               | Presigned URLs                | Worker Proxy                                    |
| -------------------- | ----------------------------- | ----------------------------------------------- |
| **Local Dev**        | ❌ Doesn't work               | ✅ Works offline                                |
| **Cost**             | Lower (no Worker egress)      | Higher (Worker egress + R2 read)                |
| **Speed**            | Faster (direct R2 → Client)   | Slower (Client → Worker → R2 → Worker → Client) |
| **URL Format**       | Ugly (long signature params)  | Clean (`/thumbnails/abc.avif`)                  |
| **Custom Headers**   | ❌ Can't modify               | ✅ Full control                                 |
| **Auth Flexibility** | Generate URL after auth check | Check auth on every request                     |

**Recommendation:** Use presigned URLs in production (cheaper/faster), Worker proxy in local dev (only option).

### Cost Analysis (1M thumbnail requests/month)

**Presigned URL approach:**

- Worker: $0.50 (1M URL generations)
- R2: $0 (free egress, 1M reads = $0 within free tier)
- **Total: ~$0.50**

**Worker Proxy approach:**

- Worker: $0.50 (1M requests)
- R2: $0.36 (1M Class B reads)
- Worker egress: ~$0.09/GB (depends on thumbnail size)
- **Total: ~$0.86 + bandwidth**

**Winner:** Presigned URLs (~40% cheaper for thumbnails)

## Local Development

### The Problem

Presigned URLs use AWS Signature Version 4, which requires real R2 credentials and the S3-compatible API endpoint. The local R2 simulation in `wrangler dev` only implements the Workers binding API (`env.R2.get()`, `env.R2.put()`, etc.), not the S3 API.

### Solutions

**Option 1: Environment-based routing (Recommended)**

```typescript
// Route to different implementations based on environment
const serveThumbnail = IS_LOCAL
  ? proxyFromR2 // Local: Worker proxy
  : redirectToPresigned; // Production: Presigned URL
```

**Option 2: Use remote R2 in local dev**

```toml
# wrangler.toml
[[r2_buckets]]
binding = "R2"
bucket_name = "my-images"
remote = true  # Use real R2 bucket locally
```

⚠️ **Warning:** This consumes real R2 operations and requires internet.

**Option 3: Mock/stub for tests**

```typescript
// test/mocks/r2.ts
export const mockR2 = {
  get: async (key: string) => {
    // Return test fixture
    return new Response(mockImageBuffer);
  },
};
```

### Testing with Vitest

```typescript
// test/upload.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleUpload } from "../src/handlers/upload";

describe("image upload", () => {
  it("generates thumbnails", async () => {
    const imageBuffer = await fetch("fixtures/test-image.jpg").then((r) =>
      r.arrayBuffer(),
    );

    const id = await handleUpload(
      new Response(imageBuffer).body!,
      "test.jpg",
      env,
    );

    // Verify thumbnails created
    const thumb = await env.R2.get(`thumbnails/${id}-thumb.avif`);
    expect(thumb).not.toBeNull();
  });
});
```

**Note:** Images binding uses low-fidelity offline version in tests (resizing only, no blur/overlays).

## Alternative Approaches

### On-Demand Transformation

Generate thumbnails on each request instead of pre-generating:

```typescript
// NOT recommended for thumbnails
export const onDemandThumbnail = async (
  key: string,
  width: number,
  env: Env,
) => {
  const original = await env.R2.get(`originals/${key}`);
  const transformed = await env.IMAGES.input(original!.body)
    .transform({ width, fit: "cover" })
    .output({ format: "image/avif" });

  return transformed.response();
};
```

**When to use:** Unpredictable sizes, user-defined crops, or very low view rates.

**Why not for thumbnails:**

- Higher latency on first view
- Pay transformation cost per view (not once per upload)
- No CDN caching of transformed images

### Hybrid: Pre-generate common + on-demand rare

```typescript
const serveImage = async (key: string, size: string, env: Env) => {
  // Common sizes: check R2
  if (["thumb", "card"].includes(size)) {
    const cached = await env.R2.get(`thumbnails/${key}-${size}.avif`);
    if (cached) return new Response(cached.body);
  }

  // Rare sizes: generate on-demand
  return generateOnDemand(key, parseInt(size), env);
};
```

## Security Considerations

### Private Bucket

Keep bucket private. Never enable public access.

### Access Control

Add auth check before serving:

```typescript
const serveThumbnail = async (request: Request, env: Env, key: string) => {
  const session = await getSession(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  // Check if user can access this image
  const hasAccess = await checkImageAccess(session.userId, key);
  if (!hasAccess) return new Response("Forbidden", { status: 403 });

  // ... serve thumbnail
};
```

### Presigned URL Expiration

Keep expiration short (1 hour default). Regenerate URLs as needed.

## References

- [Cloudflare Images](https://developers.cloudflare.com/images/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [aws4fetch](https://www.npmjs.com/package/aws4fetch)
