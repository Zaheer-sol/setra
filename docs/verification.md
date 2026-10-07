# Verification results

Recorded on 2026-10-05 on macOS, Node 24.18, PostgreSQL 17 (Docker), Foundry 1.6. Last full run after the final hardening pass.

| Suite | Command | Result |
|---|---|---|
| Unit (money, ids, matching incl. cancelled/expired, events, blockchain decoding, contracts client, SDK) | `npx vitest run --project unit` | **56 passed** |
| Engine on Postgres (pipeline, idempotency, reorg compensation, append-only, RLS) | `packages/engine/test/pipeline.test.ts` | **13 passed** |
| Adversarial money (same amounts, known/unknown senders, wrong token, expired, cancelled, multi-payment, overpaid, the real duplicate regression, replays, 4 concurrency races, DB constraints, audit chain) | `packages/engine/test/adversarial.test.ts` | **19 passed** |
| Real EVM node (Anvil): transfers, restart, RPC outage, payment intents, refund, real reorg, multi-tenant routing | `packages/engine/test/chain.test.ts` | **6 passed** |
| RPC fault injection (HTTP 500, rate limit, garbage, slow, lagging node with empty logs, worker killed mid-stream, lease respect) | `packages/engine/test/rpc-faults.test.ts` | **7 passed** |
| Webhooks against a real receiver (400/401/404/429/500/503, timeout, 410, max attempts, recovery, replay, outbox, orphaned lock, signature variants) | `packages/engine/test/webhooks.test.ts` | **14 passed** |
| Volume (400 open invoices, 400 payments; flat per-payment cost) | `packages/engine/test/volume.test.ts` | **1 passed** (~30 ms/payment through the full pipeline) |
| API (auth, CSRF, validation, object-level authorization on every resource type, keys, roles, idempotency, tenant isolation, webhooks, reconciliation, exports, public page, oversized/malformed input, rate limits, health) | `apps/api/test/api.test.ts` | **31 passed** |
| Payment purpose (definition, exact line items, payer view, inheritance on match/partial/overpaid/confirming, customer history, search, unknown stays unknown, manual resolution with history, duplicate context, API, webhook, export, tenant isolation) | `apps/api/test/purpose.test.ts` | **12 passed** |
| Execution events, Setra side, on a real EVM node (provisional detection → RPC settlement, replay, speculative block never finalized, gap covered by RPC, burst, filtering, chain refusal), plus a real refund transfer ingested from finalized blocks and linked to the duplicate it returns | `packages/engine/test/execution-events.test.ts` | **8 passed** |
| Execution events ingest API (auth, validation, watchlist, hidden from OpenAPI) | `apps/api/test/execution-events.test.ts` | **5 passed** |
| Corrections, refunds, sending (reassign with history, unassign back to review, partial follow-ups, refusal rules, refund of a duplicate / overpaid excess / partial then full, proof rules, reconciliation, email with recipient rules) | `apps/api/test/corrections.test.ts` | **9 passed** |
| Assistant parser (every example phrase, ambiguity inputs, hostile text, amounts, due dates and periods across time zones) | `apps/api/src/assistant/parse.unit.test.ts` | **36 passed** |
| Assistant and notifications (create with confirmation, idempotent double confirm, audit channel, ambiguous customers, missing fields, new customer, missing wallet, cancel/expiry, viewer role, “did they pay?”, backend totals, outstanding/overdue/review/find, accounting record, correction, notification cards for received/partial/overpaid/duplicate/unknown with unread state, test/live isolation, workspace isolation, hostile text, API keys refused) | `apps/api/test/assistant.test.ts` | **18 passed** |
| **Total TypeScript** | `npm test` | **342 passed, 0 failed** across 31 files |
| Sidecar (tracker: log index, reverted txns, sequence gaps, expired payloads, incomplete blocks, commit states, bursts, determinism; filter) | `cd services/execution-events && CPATH=<zstd>/include LIBRARY_PATH=<zstd>/lib BINDGEN_EXTRA_CLANG_ARGS=-I<zstd>/include cargo test --offline` | **12 passed** |
| Sidecar on the SDK's real execution-event snapshot vs canonical Ethereum RPC | `scripts/validate-snapshot.mjs` | **511/511 USDC transfers identical**, 0 missed, 0 gaps; 136,891 events in 23–35 ms |
| Smart contracts (PaymentIntent and BooksAttestation unit, fuzz and invariants) | `npm run test:contracts` | **45 passed, 0 failed** |
| Static analysis | `slither src/SetraPaymentIntent.sol`, `forge lint` | 2 findings, both intended `block.timestamp` expiry checks |
| End-to-end through the real UI (Playwright, Chrome) | `E2E_BROWSER_CHANNEL=chrome npm run test:e2e` | **5 passed**: flagship signup→export; partial→resolve; unknown→assign; reload recovery; phone-width payment links and one-time secrets. Test payments use the real application pipeline and are explicitly labelled simulated |
| **End-to-end with real transactions** (isolated stack: fresh database, Anvil node with real USDC + SetraPaymentIntent contracts, real API, worker and web) | `npm run test:e2e:onchain` | **1 passed**: payer sees purpose and items → signed ERC-20 transfer → worker detects and finalizes → pay page "Payment received" → console shows purpose and the real block → signed `payment.matched` webhook verified → real duplicate transfer flagged with the original's context → merchant's real refund transfer ingested → refund recorded through the UI → `payment.refunded` delivered. No simulation anywhere |
| Live Monad testnet end-to-end (opt-in; your own funded testnet key) | `npm run test:e2e:live` | written; skipped without `E2E_TESTNET_PAYER_KEY` / `E2E_TESTNET_MERCHANT`. Not run here (no key handled) |
| Typecheck | `npm run typecheck` | all workspaces clean |
| Docker images | `docker build --target <api, worker, web> .` | **all three built** (includes the Next.js production build) |
| Production stack | `deploy/compose.production.yml` with bundled Postgres, `NODE_ENV=production` | **verified**: migration exited 0; `setra_app` is not superuser and cannot bypass RLS; API healthy; worker ingesting Monad mainnet and testnet live; web and its `/api` proxy 200 |
| Alerting | stop the worker, run `scripts/health-monitor.mjs --watch` | `/v1/health?strict=true` → **503**; alert webhook received `Setra degraded: ingestion:monad; ingestion:monad-testnet` |

Integration files share one database and one local chain ID, so the integration project runs them in a
single fork, one file at a time. (An earlier configuration let them interleave; the fix is in
`vitest.config.ts`, and suites that start Anvil reset leftover local-chain state first.)

### Performance

`npx tsx scripts/perf/load-test.ts` seeds a busy workspace through the real pipeline (6,000 invoices
paid over a year, 2,000 open, 300 customers: 20,000 journal entries, 40,000 lines) into its own
`setra_perf_*` databases, then measures every run on a fresh copy of the same data. Results below
are medians on a laptop with Postgres in Docker Desktop, before and after the September 2026
performance work.

| Measurement | Before | After |
|---|---|---|
| Cash flow, 12 months | 6,687 ms | 114 ms |
| General ledger, first page | 325 ms | 8 ms |
| General ledger, deep page (offset 36,000) | 412 ms | 114 ms |
| Wallet ledger with running balance, deep page | 72 ms | 50 ms |
| Trial balance / profit and loss / balance sheet | 70–71 ms | 45–46 ms |
| Receivables aging | 93 ms | 63 ms |
| Books health | 278 ms | 231 ms |
| Payment for an open invoice, 2,000 open (p50 / p95) | 137 / 179 ms | 105 / 136 ms |
| Unidentified payment (p50 / p95) | 115 / 148 ms | 77 / 98 ms |
| API list endpoints (payments, invoices, exceptions, customers, wallets, events; limit 50) | 7–13 ms average | unchanged |

What changed: the cash flow report categorizes a period with three batched queries instead of up to
eight per entry; matching reads and locks only the invoices a rule can settle or cite (the sender's
own and exact-amount matches, plus the five closest partial fits as unlocked suggestions) instead of
every open and recently paid invoice on the wallet, which also removes most lock contention between
concurrent payments; general ledger pages are cut from the lines-and-entries join before details are
attached, and walk an index in ledger order; account balances aggregate lines once per account.

A payment is now bound by round trips (about 100 queries across detection and settlement, ~1 ms
each here), not by the size of the books or the number of open invoices. Reports that sum the whole
ledger (balances, books health) still grow linearly with it.

## Live Monad checks

| Check | Result |
|---|---|
| Monad mainnet RPC: chain head, `finalized` tag, USDC `eth_getLogs` | works; 460 USDC transfers in 100 finalized blocks |
| Average block time (10,000 blocks) | 302 ms |
| Worker against a real, busy USDC recipient on **mainnet** (read-only, 50 s) | 34 real transfers observed and recorded; 6 tip→finalized promotions averaging **1.84 s**; 300-block backfill completed; 0 errors |
| Monad testnet RPC | works (head, `finalized`, logs) |
| Real payment into a Setra invoice on **Monad testnet** | **passed**: tx `0xb720…7207` (block 66,179,640) detected at tip, finalized in ~2.5 s, matched to INV-2061, invoice paid, `payment.matched` webhook delivered (200) |
| Duplicate real transfer | **passed**: second 2 USDC transfer `0x1cd4…0e13` flagged as a possible duplicate, not applied, `payment.unknown` delivered |
| Real payment with purpose on **Monad testnet** | **passed**: INV-2062 "September Infrastructure Services" (Cloud architecture $1.20, Deployment $0.50, Monitoring $0.30), paid 2 USDC from Acme's wallet, tx `0x4d17…6e9f` (block 66,214,855, status success). Observed at tip 19:54:46.8, customer and purpose identified in the same transaction, finalized 1.55 s later, matched by rule (all 7 checks), invoice paid, signed `payment.matched` webhook delivered (200) with `invoice.title`, `invoice.purpose`, `purpose_status: known`, `context_source: automatic_match`. Detected by RPC (no Monad node for execution events). |
| Real payment on Monad mainnet | not performed |

## UI review

**Automated audit** (`scripts/ui-audit.mjs`, Playwright): 40 routes (every console page and detail
view, marketing, docs, auth, the hosted payment page in its open, paid, cancelled, expired and
not-found states, a 404) at 1440×900, 820×1100 and 375×812. Checks: horizontal overflow (with the
offending element), console errors and 5xx responses, unnamed controls, unlabelled inputs, images
without alt, heading structure, duplicate ids, target size, stray em dashes, `undefined`/`NaN`.
**2026-10-05 regression result:** 10 representative routes × 3 widths, then the two affected routes
again after fixes. No overflow, console/5xx, labelling, heading, duplicate-id or target-size findings.
The audit now ignores `aria-hidden` native form shims. The homepage code-copy control was enlarged from
its compact 24 px treatment to a 32 px target. The earlier full 40-route audit remains recorded below.

Fixed in this pass:
- Docs navigation overflowed on phones (up to 723 px wide); grid tracks could not shrink.
- Invoice payment link and event breadcrumbs overflowed on desktop and mobile (flex/grid children without `min-width: 0`).
- Developers overview tiles were forced into four columns at every width; now 4 / 2 / 1.
- Copy buttons were 19 px targets; now at least 24 px.
- Hosted payment page: the open state had no `h1`; an invalid link showed a raw validation regex, now a plain explanation; the tab title names the merchant and invoice.

**Keyboard:** tab order checked on the landing page, sign-in and the payment page; skip link first,
logical order, visible focus ring on every stop.

**By eye:** overview, payments, the real testnet payment's evidence page, invoice detail, the resolved
duplicate exception, reconciliation, developers, and the payment page at all three widths.

Earlier review fixes: table/utility class collision, detail-grid overflow from long URLs,
marketing/console class collision, invoice auto-numbering ignoring existing numbers, KV list spacing,
mobile table layout, payment-page manual grid overflow and footer wrapping.
