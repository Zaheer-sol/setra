# Setra

**Stablecoin payment operations on Monad: the financial event layer for onchain commerce.**

Businesses receive stablecoins. Setra makes receiving, understanding, reconciling and operating those
payments simple. A merchant creates an invoice, the customer pays USDC on Monad directly to the
merchant's own wallet, and Setra detects the payment, verifies it, matches it to the right customer
and invoice, explains why, handles anything that doesn't match, and exposes the result through a
console, an API and signed webhooks.

> Blockchains tell you where money moved. Setra tells your business what it means.

Setra is non-custodial: it only ever sees public addresses and never holds funds or keys.

---

## What's in this repository

```
apps/
  api/        Fastify HTTP API (/v1), auth, OpenAPI, hosted-payment-page API
  worker/     Chain ingestion (Monad first), webhook delivery, housekeeping
  web/        Next.js + shadcn/ui (Tailwind v4): marketing site, docs, merchant console, hosted payment page
packages/
  config/     Env validation + network/asset registry (Monad mainnet/testnet, Base, local devnet)
  schemas/    Money math (bigint), ids, domain vocabulary, zod API schemas
  database/   Postgres pool, migrations, network sync, demo seed
  blockchain/ Chain adapter (MonadAdapter/BaseAdapter), log fetching, decoders
  matching/   Deterministic, explainable matching engine (pure)
  events/     Webhook envelope, HMAC signing/verification, retry policy
  engine/     The payment pipeline shared by API + worker: observe → settle → allocate → events
  contracts-client/  SetraPaymentIntent ABI + offchain intent-id computation
  sdk/        @setra/sdk: API client + verifySetraWebhook
  devchain/   Anvil devnet helper for end-to-end tests (never presented as Monad)
contracts/    Solidity + Foundry: SetraPaymentIntent, tests (unit/fuzz/invariant), deploy script
services/     execution-events: Rust sidecar reading Monad execution events (official SDK) next to a node
e2e/          Playwright end-to-end tests through the real UI
docs/         Architecture, Monad, security, contract, deployment, operations, demo, OpenAPI
```

## Local setup

Requirements: Node.js 22+, npm 10+, Docker, Foundry (`forge`, `anvil`).

```bash
npm install
cp .env.example .env            # then set SESSION_SECRET and ENCRYPTION_KEY (see comments)
docker compose up -d            # Postgres 17; creates the non-superuser setra_app role + setra_test DB
npm run db:migrate
npm run db:seed                 # optional demo workspace "Acme Infrastructure" (simulated payments)
npm run dev                     # api :4000, worker, web :3000
```

Open http://localhost:3000. Demo login (development only): `owner@acme.test` / `SetraDemo!2026`.

- API explorer: http://localhost:4000/docs · OpenAPI: http://localhost:4000/openapi.json (also `docs/openapi.json`)
- Webhook receiver for demos: `npm run webhook-receiver` (verifies signatures, prints events)
- Local devnet with the intent contract: `npm run local-chain` (prints the `.env` lines to enable it)

> If you already had a `setra` volume from an earlier checkout, the init script won't rerun. Create
> the role yourself: `docker exec -it setra-postgres-1 psql -U setra -c "CREATE ROLE setra_app LOGIN PASSWORD 'setra_app'" -c "CREATE DATABASE setra_test OWNER setra"`.

## Verification

```bash
npm run typecheck
npm test                 # unit + integration (Postgres, Anvil-backed chain e2e, API security)
npm run test:contracts   # forge test: unit, fuzz, invariants
npm run test:e2e         # Playwright through the real console + hosted page
npm run build            # API + worker bundles, Next.js production build
```

Current results are listed in [docs/verification.md](docs/verification.md).

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | Services, pipeline, data model, invariants |
| [Monad integration](docs/monad.md) | Networks, tokens, finality policy, what was verified live |
| [Setra Assistant](docs/assistant.md) | Payment requests from one message, answers from real data, business-ready notifications |
| [Execution events](docs/execution-events.md) | Two-tier detection with Monad execution events: design, evidence, limits |
| [Smart contract](docs/smart-contract.md) | SetraPaymentIntent design, states, security review |
| [Security](docs/security.md) | Tenancy, auth, keys, webhooks, SSRF, audit |
| [Deployment](docs/deployment.md) | Production stack, environment, health checks and monitoring, contracts |
| [Operations](docs/operations.md) | Observability, failure recovery, runbooks |
| [Demo script](docs/demo.md) | The 3-minute walkthrough |
| [Verification](docs/verification.md) | Every test suite, live Monad checks, performance, UI audit |
| [Status and limitations](docs/status.md) | What is done, what isn't, what's next |
| Developer docs | In the product at `/docs` |
