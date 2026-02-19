<h1 align="center">
<code>TanStack Cloudflare Agent</code>
</h1>

<div align="center">
  <p>
  Lightweight saas template packed with essential functionality for TanStack and Cloudflare
  </p>
  <p>
  TanStack • Cloudflare • Better Auth • Stripe • Shadcn on Base UI
  </p>
  <p>
    <a href="https://tca.devxo.workers.dev/">Demo</a>
  </p>

</div>

## Stack

- TanStack: Start, Router, Query, Form
- Cloudflare: D1 with read replication, KV, Cron, Rate Limiting, Web Analytics
- Better Auth: Magic Link, Admin, Organization, Stripe, D1 Database Adapter
- UI: Shadcn on Base UI
- Testing: Vitest, Playwright

## Template Functionality

- **Authentication & Organizations:**
  - Magic link authentication using Better Auth
  - Multi-tenant organization management with automatic organization creation
  - Role-based access control (user/admin/organization member roles)
  - Organization invitations and membership management

- **Payments & Subscriptions:**
  - Stripe integration with subscription processing
  - Monthly and annual pricing plans with configurable trial periods
  - Stripe Checkout and Customer Portal integration
  - Webhook handling for subscription lifecycle events
  - Subscription management (cancel, reactivate, billing portal access)

- **Database & Data Management:**
  - Cloudflare D1 (SQLite) database with read replication and schema migrations
  - Type-safe database operations with Zod schema validation
  - Session management with automatic cleanup of expired sessions
  - Database seeding utilities for development and testing

- **Admin Panel:**
  - Admin interface for user management
  - Session monitoring and administration
  - Customer and subscription oversight

- **UI/UX Components:**
  - Shadcn with Base UI and TanStack Form integration
  - Theme switching (light/dark/system) with persistence

- **Testing Infrastructure:**
  - Unit and integration tests using Vitest
  - End-to-end testing with Playwright

- **Email Integration:**
  - AWS SES for transactional email delivery
  - Demo mode support for development without external email services

- **Security & Performance:**
  - IP-based rate limiting for authentication endpoints using Cloudflare Rate Limiting
  - Server-side route protection and authorization
  - Secure session handling with database storage

## Quick Start

### Stripe

- Install the [Stripe CLI](https://stripe.com/docs/stripe-cli).
- Go to stripe and create a sandbox for testing named `tca-int`
  - Remember secret key for `STRIPE_SECRET_KEY` environment variable.

### Local Env

- Copy `.env.example` to `.env`.
- Edit the `BETTER_AUTH_SECRET` and `STRIPE_SECRET_KEY` keys.
- Set `STRIPE_WEBHOOK_SECRET` later after you run `pnpm stripe:listen` below.

```
pnpm i
pnpm d1:reset
stripe login --project-name=tca-int
pnpm stripe:listen
# copy webhook signing secret to STRIPE_WEBHOOK_SECRET in .env
pnpm dev

# cron
curl "http://localhost:3000/cdn-cgi/handler/scheduled?cron=0%200%20*%20*%20*"
```

## Testing

### Stripe Test Card Details

- Card Number: `4242 4242 4242 4242`
- Expiration: Any future date
- CVC: Any 3-digit number

### Unit and Integration Tests

```
pnpm test
```

### E2E Tests

```
pnpm dev
pnpm stripe:listen
pnpm test:e2e
```

## Deploy

- Create stripe webhook
  - Endpoint URL: `https://[DOMAIN]/api/auth/stripe/webhook`
  - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`

- Cloudflare Web Analytics | Add a site
  - Remember token from script for ANALYTICS_TOKEN secret below.

- pnpm exec wrangler kv namespace create tca-kv-production
- Update wrangler.jsonc production kv_namespaces
- pnpm exec wrangler queues create r2-upload-notifications
- pnpm exec wrangler r2 bucket notification create uploads --event-type object-create --queue r2-upload-notifications
- pnpm exec wrangler r2 bucket notification create uploads --event-type object-delete --queue r2-upload-notifications
- pnpm d1:reset:PRODUCTION
- pnpm deploy:PRODUCTION
- pnpm exec wrangler secret put SECRET --env production
  - BETTER_AUTH_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ANALYTICS_TOKEN
- Workers & Pages Settings: tca
  - Git repository: connect to git repo
  - Build configuration
    - Build command: CLOUDFLARE_ENV=production pnpm build
    - Deploy command: pnpm exec wrangler deploy --env production
- Storage & databases: tca-d1-production: Settings
  - Enable read replication

## Shadcn with Base UI

```bash
pnpm dlx shadcn@latest add --overwrite accordion alert-dialog alert aspect-ratio avatar badge breadcrumb button-group button calendar card carousel chart checkbox collapsible combobox command context-menu dialog drawer dropdown-menu empty field hover-card input-group input item label pagination popover progress radio-group scroll-area select separator sidebar sonner spinner switch tabs table textarea toggle tooltip

pnpm dlx shadcn@latest add https://ai-sdk.dev/elements/api/registry/all.json
```

## Llms

```
ln -s AGENTS.md CLAUDE.md
pnpm add -g @playwright/cli@latest

codex -m gpt-5.3-codex -c 'model_reasoning_effort="high"'
codex -m gpt-5.3-codex -c 'model_reasoning_effort="xhigh"'

npm install -g @openai/codex
```

- OpenAI model docs: GPT-5.2-Codex supports low, medium, high, xhigh

## Ledger

```
https://www.pgrs.net/2025/06/17/double-entry-ledgers-missing-primitive-in-modern-software/
https://dev.to/lerian/what-is-double-entry-and-how-to-use-it-on-a-financial-operation-1ae5

```

Several programming blog posts highlight that the 500-year-old principles of double-entry accounting are actually powerful **state-management patterns** for maintaining data integrity, even when you aren't building a finance app.

The core idea is that instead of updating a single "balance" field (e.g., `inventory = inventory - 1`), you treat every change as a movement of value between two "buckets" (accounts). This ensures that nothing is ever "lost" or "created from nothing."

### Key Blog Posts and Use Cases

#### 1. Tracking State Machines and Distributed Value
**Blog:** [Books, an immutable double-entry accounting database service](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/) (Square Engineering)
*   **The Concept:** Square treats different stages of a payment (Pending, Refunded, Paid Out) as "books."
*   **Non-Accounting Use:** They describe it as a **state machine** where they "move pennies" between states. By using double-entry, they ensure that the total number of pennies in the system remains constant, making it impossible for a bug to "lose" a transaction in transit between states.

#### 2. API Quotas and Content Moderation
**Blog:** [Double-Entry Ledgers: The Missing Primitive in Modern Software](https://pgrs.net/2025/06/17/double-entry-ledgers-the-missing-primitive-in-modern-software/) (Paul Gross)
*   **API Usage:** Instead of a simple integer for "remaining credits," you use a ledger. Buying credits "debits" the system's quota and "credits" the user's account. Spending credits moves them to a "Usage" account.
*   **Content Moderation:** Gross suggests tracking user behavior like a ledger: "Offenses" are one account, "Warnings" are another, and "Appeals" are a third. This creates a perfect audit trail of why a user was banned, rather than just having a `is_banned` boolean.

#### 3. Inventory and Logistics Management
**Blog:** [What is Double Entry and how to use it on a financial operation](https://dev.to/matheus_m_guimaraes/what-is-double-entry-and-how-to-use-it-on-a-financial-operation-1k1j) (Matheus Guimarães)
*   **Physical Goods:** The post explains that double-entry is essential for logistics. When a product moves from a warehouse to a delivery truck, it is "credited" from Warehouse A and "debited" to Truck B. If the truck breaks down, the "value" (the item) is still sitting in the Truck B account, preventing it from disappearing from the database.

#### 4. Conceptual Parallels: Double-Entry vs. Testing (BDD)
**Blog:** [What Software Development Can Learn from Double-Entry Bookkeeping](https://itsadeliverything.com/what-software-development-can-learn-from-double-entry-bookkeeping)
*   **The Analogy:** This post argues that **Behaviour-Driven Development (BDD)** is the "double-entry" of programming. Just as accounting requires two entries (debit/credit) to verify a transaction, BDD requires two records (the test and the code) to verify a feature. If they don't "balance" (pass), you know exactly where the error lies.

#### 5. Database Integrity and Audit Trails
**Blog:** [Why Every Developer Should Know About Double-Entry Bookkeeping: And It's Not About Accounting](https://freerangetolic.com/blog/double_entry_bookkeeping_for_developers/) (Tolics Engineering)
*   **The Argument:** Simple `UPDATE` statements are "ticking time bombs." If a database crash happens mid-update, you lose data.
*   **General Use:** The post suggests using double-entry for **loyalty points, upvote systems, or gaming energy**. It turns "state" into "events," allowing you to reconstruct a user's status at any point in history just by summing the ledger entries.

### Summary of "Non-Accounting" Benefits
*   **Auditability:** You never ask "How did this value get here?" The history is baked into the movement.
*   **Immutability:** You never delete or overwrite; you only add "reversing entries" to fix mistakes, which is a core principle of reliable distributed systems.
*   **Error Detection:** If the sum of all "accounts" in your system doesn't equal zero (or your starting constant), you have a bug. It's a built-in "checksum" for your entire application state.

## Credit

Homepage / Pricing design by [dev-xo](https://github.com/dev-xo). See his [remix-saas](https://github.com/dev-xo/remix-saas) for a production-ready saas template for remix.

## License

Licensed under the [MIT License](https://github.com/mw10013/tanstack-cloudflare-agent/blob/main/LICENSE).
