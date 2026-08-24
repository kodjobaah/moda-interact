# Moda Interact

Moda Interact is a Shopify application for conversational commerce and abandoned checkout recovery.

It connects Shopify checkout, order, customer, and product data with automated recovery workflows and AI-assisted customer conversations. The platform is designed so merchants can recover lost sales, answer product questions, and manage customer interactions without coupling the Shopify application directly to long-running background processing.

> **Project status:** Active development. The Shopify application, shared persistence layer, billing domain, webhook ingestion, and background workflow architecture are implemented. WhatsApp transport can be run through a development/test provider while live Meta WhatsApp Business integration is configured.

## What this repository owns

`moda-interact` is the Shopify-facing application in the wider Moda Interact platform.

This repository is responsible for:

- Shopify app authentication and session management
- Shopify webhook ingestion
- Merchant onboarding and embedded app UI
- Shop/tenant resolution
- Billing and subscription synchronisation
- Shopify-hosted pricing redirects and callbacks
- Merchant settings
- Prisma client generation against the shared database schema
- Production database migration deployment
- Public application routes such as the privacy policy

Long-running recovery workflows, AI conversations, Shopify commerce tooling, and queue consumers live in the background service.

## Architecture

```mermaid
flowchart LR
    Shopify[Shopify] -->|Webhooks| App[moda-interact]
    Merchant[Merchant Admin] --> App

    Meta[WhatsApp / Meta] -->|Inbound messages| Messaging[moda-messaging]

    App --> Redis[(Redis / BullMQ)]
    Messaging --> Redis

    Redis --> Workers[moda-interact-background]

    Workers --> DB[(PostgreSQL)]
    App --> DB
    Messaging --> DB

    Workers --> Agent[Commerce Agent]
    Agent --> ShopifyAPI[Shopify Admin API]
    Agent --> AI[LLM Provider]

    Workers --> WhatsApp[WhatsApp Provider]
    WhatsApp --> Customer[Customer]
```

The platform is split into focused services:

| Repository | Responsibility |
| --- | --- |
| [`moda-interact`](https://github.com/kodjobaah/moda-interact) | Shopify application, merchant UI, webhook ingress, billing |
| [`moda-interact-background`](https://github.com/kodjobaah/moda-interact-background) | BullMQ workers, recovery workflows, AI commerce agent, entitlements and usage |
| [`moda-interact-database`](https://github.com/kodjobaah/moda-interact-database) | Shared Prisma schema, migrations, seed data and ERD |
| `moda-messaging` | (https://github.com/kodjobaah/moda-interact-messaging)|Messaging ingress service for WhatsApp/Meta webhooks |

## Core product flow

A typical checkout recovery journey looks like this:

```text
Shopify checkout event
        |
        v
moda-interact webhook
        |
        v
BullMQ / Redis
        |
        v
Checkout recovery worker
        |
        +--> PostgreSQL recovery state
        |
        +--> Customer / phone resolution
        |
        +--> Conversation
        |
        +--> WhatsApp recovery message
                         |
                         v
                  Customer reply
                         |
                         v
                   moda-messaging
                         |
                         v
                    BullMQ worker
                         |
                         v
                  Commerce Agent
                         |
              +----------+----------+
              |                     |
              v                     v
      Shopify product tools      AI response
              |                     |
              +----------+----------+
                         |
                         v
                   WhatsApp reply
```

The application deliberately keeps commercial workflow state separate from conversational memory:

- **`CheckoutRecovery`** represents the recovery workflow and its business state.
- **`Conversation`** and **`ConversationMessage`** represent customer interaction history.
- PostgreSQL is the source of truth; the LLM conversation is not used as application state.

## Multi-tenant data model

`Shop` is the tenant root for the Moda Interact domain.

```text
Shop
 ├── ShopSettings
 ├── Subscription*
 ├── UsageEvent*
 ├── Customer*
 │    ├── CustomerPhone*
 │    └── CheckoutRecovery*
 │          └── Conversation*
 │               └── ConversationMessage*
```

Customer identity is scoped to a Shopify store. Shopify customer IDs are preferred when available, while phone numbers are stored separately so number changes can be represented without changing customer identity.

## Billing

Moda Interact uses Shopify for merchant billing while maintaining a local representation of plans, subscriptions, entitlements, and usage.

```text
Shopify App Pricing
        |
        v
BillingService
        |
        v
Subscription + BillingPlan
        |
        v
EntitlementService
        |
        v
Workers / product features
```

The local billing model avoids scattering plan-name checks throughout the codebase.

A `BillingPlan` contains:

- a stable `handle`
- feature entitlements
- usage limits
- active/inactive state

Workers ask the entitlement service whether a feature or usage allowance is available rather than checking plan names directly.

Usage events use deterministic idempotency keys so retries do not double-count billable actions.

## Shopify billing flow

```text
Merchant opens billing page
        |
        v
/app/billing
        |
        v
/app/billing/select
        |
        v
Shopify hosted pricing page
        |
        v
Merchant selects a plan
        |
        v
/app/billing/callback
        |
        v
Verify active subscription with Shopify
        |
        v
Synchronise local Subscription
```

The `plan_handle` returned through the browser is treated as context only. The server verifies the active subscription with Shopify before persisting billing state.

## Webhooks

The Shopify app currently subscribes to commerce events including:

- `carts/create`
- `carts/update`
- `checkouts/create`
- `checkouts/update`
- `orders/create`

Webhook handlers should remain lightweight. Expensive or retryable work is placed onto BullMQ queues and processed by background workers.

## Technology

- **TypeScript**
- **React Router**
- **Vite**
- **Shopify App Bridge**
- **Shopify Admin GraphQL API**
- **Prisma**
- **PostgreSQL**
- **Redis**
- **BullMQ**
- **Node.js**
- **Render**
- AI integration through the background commerce-agent service

## Repository structure

```text
moda-interact/
├── app/
│   ├── components/
│   ├── routes/
│   ├── services/
│   │   ├── billing/
│   │   └── shop/
│   ├── db.server.*
│   └── shopify.server.*
│
├── database/                 # git submodule: moda-interact-database
│   └── prisma/
│       ├── schema.prisma
│       ├── migrations/
│       └── seed.mjs
│
├── shopify.app.moda-interact.toml
├── shopify.web.toml
├── vite.config.*
└── package.json
```

## Getting started

### Prerequisites

You will need:

- Node.js
- npm
- Shopify CLI
- a Shopify Partner/Developer account
- a Shopify development store
- PostgreSQL
- the required Shopify application credentials

For local database development, Docker or Colima can be used to run PostgreSQL.

### Clone

The database schema is included as a Git submodule:

```bash
git clone --recurse-submodules https://github.com/kodjobaah/moda-interact.git
cd moda-interact
```

If the repository has already been cloned without submodules:

```bash
git submodule update --init --recursive
```

### Install dependencies

```bash
npm install
```

### Environment

Typical environment variables include:

```bash
DATABASE_URL=
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=
SHOPIFY_APP_HANDLE=moda-interact

SHOPIFY_PARTNER_ORG_ID=
SHOPIFY_PARTNER_ACCESS_TOKEN=
SHOPIFY_APP_ID=
```


### Generate Prisma Client

```bash
npm run prisma:generate
```

Equivalent command:

```bash
prisma generate --schema database/prisma/schema.prisma
```

### Run locally

```bash
shopify app dev
```

Shopify CLI starts the local React Router application and exposes it to the configured development store through a development tunnel.

## Database workflow

The database schema and migration history are owned by `moda-interact-database`.

### Create migrations locally

Migration authoring should be performed against a local PostgreSQL instance:

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/moda_interact"

npx prisma migrate dev \
  --schema database/prisma/schema.prisma \
  --name <migration_name>
```

Commit the generated migration to the database repository.

### Deploy migrations

For hosted environments:

```bash
npm run prisma:migrate:deploy
```

Do **not** use `prisma migrate dev` against a managed production database.

### Seed reference data

```bash
npm run prisma:seed
```

## Useful commands

```bash
shopify app dev
npm run prisma:generate
npm run prisma:status
npm run prisma:migrate:deploy
npm run prisma:seed
npm run build
```

## Design principles

### Webhooks acknowledge quickly

Webhook routes validate and enqueue work rather than performing recovery workflows synchronously.

### Queues provide retry boundaries

BullMQ provides retry, backoff, concurrency control, and separation between ingress and background work.

### Database constraints provide final idempotency

Queue job IDs reduce duplicate processing, while database uniqueness constraints and usage idempotency keys provide the durable final guard.

### Shopify API calls stay behind service boundaries

Workers and agents use Shopify service/tool abstractions rather than spreading GraphQL calls throughout business logic.

### Billing is not embedded in business logic

Features ask the entitlement layer whether they are available. They do not know whether the merchant is on `starter`, `growth`, or another future plan.

### Tenant identity is explicit

Domain records use `shopId` as the tenant key rather than repeatedly storing a Shopify domain string throughout the application model.

## Deployment

The hosted application is currently deployed on Render:

<https://moda-interact.onrender.com>

The background service is deployed independently so web traffic and worker workloads can scale separately.

## Privacy and security

Moda Interact handles merchant and customer commerce data, so:

- secrets must only be supplied through environment variables
- Shopify webhook authenticity must be verified
- customer data must be scoped by shop
- logs must avoid exposing access tokens or unnecessary personal information
- Shopify privacy/compliance requests must be handled according to Shopify requirements
- production messaging integrations should use provider credentials stored outside the repository

Privacy policy:

<https://moda-interact.onrender.com/privacy>

## Current roadmap

Near-term work includes:

- merchant-facing recovery activity UI
- richer recovery analytics
- production WhatsApp Business transport
- Shopify privacy/compliance webhook handling
- usage reporting and billing reconciliation
- improved onboarding and merchant configuration
- expanded conversational commerce tooling

## Related projects

- [`moda-interact-background`](https://github.com/kodjobaah/moda-interact-background)
- [`moda-interact-database`](https://github.com/kodjobaah/moda-interact-database)

## License

This project is currently maintained as a product-development project.