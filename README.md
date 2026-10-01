# Setra

**Invoices, payments and automatic books for businesses paid in USDC on Monad.**

A business sends an invoice, the customer pays USDC on Monad straight to the business's own wallet,
and about two seconds later Setra has matched the payment to the invoice and posted it to a
double-entry ledger. When a month is closed, the business can publish it on Monad: a fingerprint of
the books, the books themselves encrypted, and public statements, which anyone can check on a public
verify page. Setra is non-custodial: it reads public addresses and never holds funds or keys.

**Try it:** https://setra.up.railway.app (Monad testnet). Sign in with `owner@acme.test` /
`SetraDemo!2026` (a test-mode demo workspace with simulated data), or create your own. Verify a published month at
https://setra.up.railway.app/verify.

## Where Setra uses Monad

Everything below is on Monad testnet (chain 10143) unless it says mainnet, and every transaction links
to the explorer.

| What | Evidence |
|---|---|
| **Setra's own contracts**, deployed from the team's wallet `0xEb58…3eF0` | [SetraPaymentIntent `0x1eF2…9B5c`](https://testnet.monadscan.com/address/0x1eF2Ca1b4426D7e942EAd749F4C7eF5580fd9B5c) ([deploy](https://testnet.monadscan.com/tx/0x9d0b0fc0ee845d080473bc6c38edcb105bf43beb01916d07702363803a02fe0e)) and [SetraBooksAttestation v2 `0xD4b8…8A73`](https://testnet.monadscan.com/address/0xD4b87CE59e2dcf5F597ea0EDf7dEC17c21D78a73) ([deploy](https://testnet.monadscan.com/tx/0x17c046200ad1f29bcfc25d9a0d294242f413fa46c1655101da87792eff394492)). v1 [`0xBc89…C9cA`](https://testnet.monadscan.com/address/0xBc89b80F680046E23e53b2650Ca574E96Fb5C9cA) is kept in [`contracts/deployments/monad-testnet.json`](contracts/deployments/monad-testnet.json). No owner, no admin, no funds held |
| **A customer paying an invoice through the contract** | [`0x1113…5708`](https://testnet.monadscan.com/tx/0x11132718581db2df3628989467ca721968cd2c1be34d8d12a7e062b116cf5708): the hosted payment page created a payment intent, the wallet paid through `SetraPaymentIntent` (the invoice reference is inside the transaction), and the worker matched it to its invoice |
| **A direct USDC payment matched and booked** | [`0xb720…7207`](https://testnet.monadscan.com/tx/0xb7208e823382be10d1dcc390eef18f6a68499dad0788e095740c073c121d7207): seen at the chain tip, applied at finality 2.4 s later, matched to INV-2061; an identical second transfer was flagged as a possible duplicate ([`docs/monad.md`](docs/monad.md)) |
| **A month of books attested on Monad** | [`0xd24e…2cef`](https://testnet.monadscan.com/tx/0xd24e95df8a40356023b03828e8881c5b4cae2286d5a255f9c3466b2b50f22cef): September 2026, 62 posted entries, fingerprint `0x95f4…8505`, signed by the business's wallet. [Check it on the verify page](https://setra.up.railway.app/verify?chain=10143&tx=0xd24e95df8a40356023b03828e8881c5b4cae2286d5a255f9c3466b2b50f22cef) |
| **Finality-aware detection** | Payments show as detected at Monad's `latest` block and are applied only at `finalized` ([`packages/blockchain/src/adapter.ts`](packages/blockchain/src/adapter.ts), [`packages/engine/src/ingestion.ts`](packages/engine/src/ingestion.ts)). Detected to paid: **1.8 s on average on Monad mainnet**, read-only, 34 real USDC transfers, zero errors ([`docs/monad.md`](docs/monad.md)) |
| **Books on Monad, end to end** | Encryption, fingerprint and verification share one implementation ([`packages/contracts-client/src/books.ts`](packages/contracts-client/src/books.ts)); the verify page reads the chain from the visitor's browser ([`apps/web/src/app/(site)/verify`](apps/web/src/app/(site)/verify)); an end-to-end test decrypts books from the chain and matches the fingerprint ([`packages/engine/test/books-attestation.test.ts`](packages/engine/test/books-attestation.test.ts)) |
| **Monad execution events** | A Rust sidecar on Monad's official execution-events SDK reproduced 511 of 511 USDC transfers exactly from the SDK's replay data ([`services/execution-events`](services/execution-events), [`docs/execution-events.md`](docs/execution-events.md)). Not yet run against a live Monad node |

Not done yet: no payment on Monad mainnet (mainnet ingestion was verified read-only), and the
contracts are deployed on testnet only.

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

Open http://localhost:3000. Demo login: `owner@acme.test` / `SetraDemo!2026` (the same demo workspace as the hosted site).

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
