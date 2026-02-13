# Workers AI Image Classification: Clear Cost + Limits

## TL;DR

- For **Workers AI task = Image Classification**, use `@cf/microsoft/resnet-50`.
- Cost is low per image: **$2.51 per 1,000,000 images**.
- Neuron usage: **228,055 neurons per 1,000,000 images** = **0.228055 neurons/image**.
- Free tier (10,000 neurons/day) covers about **43,848 images/day**.

## Exact Model

Cloudflare model catalog entry for `@cf/microsoft/resnet-50` shows task:

> `"name": "Image Classification"`

Source:
- `refs/cloudflare-docs/src/content/workers-ai-models/resnet-50.json`
- https://developers.cloudflare.com/workers-ai/models/resnet-50

## Exact Cost Math

Cloudflare pricing table lists:

> `@cf/microsoft/resnet-50 | $2.51 per M images | 228055 neurons per M images`

Math:

- Neurons per image = `228055 / 1,000,000 = 0.228055`
- Free images/day = `10,000 / 0.228055 = 43,848.19`
- Cost per image = `$2.51 / 1,000,000 = $0.00000251`

Sources:
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx`
- https://developers.cloudflare.com/workers-ai/platform/pricing/

## Is AI Gateway Cheaper?

Not by itself. Gateway adds observability/caching/security.

Gateway helps cost only when you get cache hits on identical requests:

> `AI Gateway can cache responses ... for identical requests.`

> `Cost Savings: Minimize the number of paid requests ...`

Sources:
- `refs/cloudflare-docs/src/content/docs/ai-gateway/features/caching.mdx`
- https://developers.cloudflare.com/ai-gateway/features/caching/

## How Big Can Images Be?

### Model-specific limit (`resnet-50`)

No explicit max image size is documented in the `resnet-50` model schema. It documents input type (`binary` or byte array), not max size.

Source:
- `refs/cloudflare-docs/src/content/workers-ai-models/resnet-50.json`

### If using AI Gateway caching

Cloudflare lists:

> `Cacheable request size ... 25 MB per request`

Source:
- `refs/cloudflare-docs/src/content/docs/ai-gateway/reference/limits.mdx`
- https://developers.cloudflare.com/ai-gateway/reference/limits/

### If image is uploaded to Worker over HTTP first

Cloudflare Workers request-body limits apply by plan. Docs list Free/Pro as 100 MB max request body.

Source:
- `refs/cloudflare-docs/src/content/docs/workers/platform/limits.mdx`
- https://developers.cloudflare.com/workers/platform/limits/

## How Classification Output Works

`resnet-50` returns ranked labels with confidence score:

- `label`: predicted class
- `score`: confidence in `[0, 1]`

Cloudflare schema excerpt:

> `"score": "A confidence value, between 0 and 1"`

> `"label": "The predicted category or class"`

Cloudflare notebook example output for a burrito image shows:

- `BURRITO` with very high confidence
- lower-confidence alternatives (`GUACAMOLE`, `BAGEL`, ...)

Sources:
- `refs/cloudflare-docs/src/content/workers-ai-models/resnet-50.json`
- `refs/cloudflare-docs/src/content/docs/workers-ai/guides/tutorials/explore-workers-ai-models-using-a-jupyter-notebook.mdx`
- https://developers.cloudflare.com/workers-ai/guides/tutorials/explore-workers-ai-models-using-a-jupyter-notebook/

## Practical Choice for Test Code

- If you want basic image classification quickly and cheapest inside this task type: use `@cf/microsoft/resnet-50`.
- For test usage volume, free tier is usually enough unless you exceed roughly **43.8k images/day**.
