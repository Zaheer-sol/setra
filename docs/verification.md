# Verification results

Recorded on 2026-09-27 on macOS, Node 24.18, PostgreSQL 17 (Docker), Foundry 1.6. Last full run after the final hardening pass.

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
| **Total TypeScript** | `npm test` | **235 passed, 0 failed** (92 unit, 143 integration) |
| Sidecar (tracker: log index, reverted txns, sequence gaps, expired payloads, incomplete blocks, commit states, bursts, determinism; filter) | `cd services/execution-events && cargo test` | **12 passed** |
| Sidecar on the SDK's real execution-event snapshot vs canonical Ethereum RPC | `scripts/validate-snapshot.mjs` | **511/511 USDC transfers identical**, 0 missed, 0 gaps; 136,891 events in 23–35 ms |
| Smart contract (unit, fuzz ×3 @1,000 runs, invariants ×4 @256×64) | `npm run test:contracts` | **32 passed, 0 failed** |
| Static analysis | `slither src/SetraPaymentIntent.sol`, `forge lint` | 2 findings, both intended `block.timestamp` expiry checks |
| End-to-end through the real UI (Playwright, Chromium) | `npm run test:e2e` | **3 passed**: flagship signup→export (purpose shown to the payer before paying and on the payment after); partial→resolve; unknown→assign. These use test-mode simulated payments through the real pipeline |
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

| Measurement | Result |
|---|---|
| API list endpoints (payments, invoices, exceptions, customers, wallets, events; limit 50) | 7–13 ms average |
| Settlement through the full pipeline, 400 open invoices on one wallet | ~30 ms per payment, flat as invoices are paid |
| Same, 2,000 open invoices on one wallet | ~90–125 ms per payment (measured under concurrent Docker build load) |
| Candidate query at 2,000 open invoices | 6 ms in Postgres; ~30 ms including row transfer. Row locks are not the cost |

Matching reads every open invoice on the receiving wallet (needed to explain ambiguity and near
misses), so decision cost grows linearly, about 15 µs per open invoice. List queries use keyset
pagination on composite indexes and batch related rows (no N+1).

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
**Final result: no findings** except native radio inputs on the test-payments page, which sit inside
clickable labels.

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
