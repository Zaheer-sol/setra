# Status, limitations and remaining work

## Built and working

- Standalone merchant product: signup, workspaces, roles, onboarding, wallets, customers, invoices,
  hosted payment page (wallet checkout + manual send with EIP-681 QR), payments, needs-review queue with
  resolutions, reconciliation, CSV exports, settings, team invitations, audit log. No QuickBooks or any
  other external system is required.
- Monad ingestion (mainnet + testnet): tip detection, `finalized`-tag settlement with a safety lag,
  per-chain cursors with leases, backfill, idempotent reprocessing, provider range splitting, drop of
  non-canonical tip observations. Verified read-only against real Monad mainnet traffic.
- Deterministic, explainable matching (`match-v1.1`) with exceptions for unknown, ambiguous, partial,
  overpaid, duplicate, late, wrong-token and wrong-network payments.
- Append-only evidence, decisions, allocations, events, resolutions, attempts and audit logs,
  enforced by the database; compensating history for reversals.
- Versioned REST API with OpenAPI 3.1, API keys (test/live, read-only), idempotency, pagination, rate
  limits, consistent errors; signed webhooks with retries, attempt history, replay, rotation.
- Test mode on Monad testnet plus simulations through the real pipeline, including controlled reorgs.
- SetraPaymentIntent contract with unit/fuzz/invariant tests, Slither/forge-lint clean except intended
  timestamp use, deploy + record scripts, end-to-end ingestion on Anvil (pay, refund, reference match).
- Marketing site, product/security/pricing/developer pages, in-product developer docs, `@setra/sdk`.
- Payment purpose as a first-class concept: every payment request says what it is for (`title`,
  optional `purpose`, optional exact line items). The payer sees it before paying; payments, the
  dashboard, customer history, reconciliation, exceptions (including what a duplicate duplicates),
  search, API, webhooks and CSV exports carry it. Unmatched payments stay "purpose unknown"; a manual
  resolution establishes it and the history keeps both steps.
- Operator corrections: move an applied payment to another invoice or take it back to review, with a
  required reason; compensating allocations, reopened invoices, `payment.unassigned` webhook, full
  history. Refunds proven onchain: Setra records stablecoin sent from monitored wallets and lets an
  operator link the transfer that returned a duplicate, unknown or overpaid amount (`refunded`
  status, `payment.refunded` webhook, reconciliation). Payment requests can be emailed to the customer.
- Setra Assistant in the console: create a payment request from one message (with a confirmation
  card), ask whether a customer paid, today's totals, outstanding/overdue, review items, accounting
  details, and move a payment; answers come from the regular API as the signed-in user. A
  notification bell turns payment events into business-ready cards. See `docs/assistant.md`.
- Monad execution events: a Rust sidecar on the official SDK (`services/execution-events`), a
  two-tier ingestion path (execution events for early provisional detection, RPC for canonical
  settlement), gap detection with RPC recovery, stream health, per-payment detection timings.
  Validated on the SDK's real execution-event snapshot (511/511 USDC transfers identical to a
  canonical RPC node). See `docs/execution-events.md`.
- Hardening: adversarial money tests, RPC fault injection, webhook failure classes, object-level
  authorization tests, a volume test, and an automated UI audit of 40 routes at three widths (see
  `docs/verification.md`).
- Deployment: one Dockerfile with three targets and a production compose stack
  (`deploy/compose.production.yml`) verified in production mode; liveness, readiness and a strict health
  endpoint for uptime monitors; `scripts/health-monitor.mjs` for alerts.

## Known limitations (honest)

1. **Live Monad payments have been exercised on testnet only, via direct transfer.** On 2026-09-27 a real
   2 USDC transfer on Monad testnet (tx `0xb7208e823382be10d1dcc390eef18f6a68499dad0788e095740c073c121d7207`,
   block 66,179,640) was paid from the hosted payment page, observed at the tip, finalized ~2.5 s later,
   matched to INV-2061 and delivered as a signed `payment.matched` webhook. A second real transfer two
   seconds later was flagged as a possible duplicate and not applied. No mainnet payment has been made.
2. **SetraPaymentIntent is deployed on Monad testnet only** (`0x1eF2…9B5c`, see
   `contracts/deployments/monad-testnet.json`), not on mainnet. Without a configured address, the hosted page
   uses direct transfers (fully supported). The contract has not been audited.
3. Rate limiting is in-memory: correct for one API instance; multiple instances need a shared store.
4. Email (password reset, invitations) needs `SMTP_URL`. Without it, development logs the link and
   production sends nothing; invitation links are also shown once in the console.
5. Wrong-network detection only works when the same address is monitored on both networks. Base is
   implemented but disabled by default.
6. Outgoing transfers are observed from finalized blocks and linked to refunds by an operator (Setra
   suggests the likely transfer; it does not link automatically). Refunds of unsupported tokens are
   not tracked. On confirmation-based chains (Base), an outgoing transfer is not re-verified after a
   deep reorg.
7. USD-pegged stablecoins only, settled 1:1 (USDC; USDT0 on mainnet). No FX, no non-USD invoices.
8. No per-invoice deposit addresses (by design: non-custodial, merchant-owned wallets). Colliding amounts
   from unknown senders go to review, or are avoided with known customer wallets or payment intents.
9. `ENCRYPTION_KEY` can't be rotated in place (webhook secrets would need re-encryption).
10. Polling at 1 s; Monad's `monadNewHeads`/`monadLogs` subscriptions could cut detection latency further.
11. Accessibility: semantic HTML, labelled controls, visible focus, reduced motion, and an automated
    audit (labels, names, headings, target size, overflow) that passes on every page. Not yet tested
    with a screen reader.
12. No invoice PDFs or receipts; payment requests are emailed as plain text with the payment link.
    Merchants get no email notifications (webhooks and the console only). No invoice lifecycle
    webhooks (`invoice.expired` etc.); customers can't be archived; invoices can't be edited.
13. Pricing is presentational; no billing is implemented (intentionally).
14. Docker images build and run but are not slimmed (~1.1 GB each; they include all dependencies).
15. Matching reads every open invoice on the receiving wallet, so settlement cost grows linearly with
    open invoices on one wallet: ~30 ms per payment at 400, ~100 ms at 2,000. Fine for current scale;
    a merchant with tens of thousands of simultaneously open invoices on one wallet would need the
    candidate set narrowed in SQL.
16. Not hosted on a public URL. The production stack is verified locally; hosting needs an account on
    a container platform or VM, a managed Postgres, an authenticated Monad RPC and SMTP.
17. **Execution events have not been consumed live from a Monad node.** The sidecar, its SDK
    integration and Setra's ingestion are built and tested (snapshot replay validated against
    canonical RPC; Setra side on a real EVM node), but no Monad full node was available, so the live
    execution-vs-RPC detection advantage on Monad is not measured. The SDK's published Monad devnet
    snapshot is refused by the SDK's schema check (older format).
18. Line items use integer quantities; an invoice's title, purpose and items cannot be edited after
    creation (cancel and reissue). Invoices created before titles existed show their old description
    as the title; those without one show "No purpose recorded".
19. The assistant understands a fixed set of payment and payment-request questions (deterministic
    parsing, English only); it does not hold open-ended conversations. It can't add line items or
    change due dates after creation.

## Remaining work

**Before hackathon submission**
- Deploy SetraPaymentIntent to Monad testnet (the deployer signs with their own keystore), then
  `npm run contracts:record`, configure, and run the intent flow live.
- Host the stack on a public URL: build the three images, fill `deploy/production.env`, run the
  compose stack or one service per image on a container platform.
- Record the live Monad testnet demo on video (the flow itself has been run successfully).

**Before a real pilot**
- Authenticated Monad RPC provider with an SLA; point an uptime monitor at `/v1/health?strict=true`.
- SMTP provider; custom domain and TLS; database backups and restore drill.
- Shared rate-limit store; log shipping; error tracking.
- Terms of service, privacy policy, data processing agreement.

**Before production customers on mainnet**
- Third-party security review of the application; audit of SetraPaymentIntent if used on mainnet.
- Secrets in a KMS; `ENCRYPTION_KEY` rotation procedure; key/role review.
- Load and soak testing of ingestion under provider failures; on-call runbooks exercised.
- Formal retention/export policies for financial history.
