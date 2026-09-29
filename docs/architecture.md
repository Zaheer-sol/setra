# Architecture

```
            Browser (console, hosted payment page)            Merchant backend
                         │  same-origin /api/*                     │  Bearer sk_…
                         ▼                                          ▼
   ┌──────────────── apps/web (Next.js) ────────┐        ┌──────── apps/api (Fastify) ────────┐
   │ marketing · docs · console · /pay/[token]  │──────▶ │ auth · RBAC · tenancy · idempotency │
   └────────────────────────────────────────────┘ proxy  │ /v1 REST · OpenAPI · public pay API │
                                                          └───────────────┬────────────────────┘
                                                                          │ packages/engine
   ┌──────────────── apps/worker ───────────────┐                        │ (same functions)
   │ ChainIngestor per network (lease-held)     │────────────────────────┤
   │ webhook delivery (SKIP LOCKED) · housekeeping                        ▼
   └───────────────┬────────────────────────────┘                PostgreSQL (RLS, append-only)
                   │ packages/blockchain (MonadAdapter)
                   ▼
          Monad RPC (latest / finalized tags, eth_getLogs)
```

The browser only talks to the web origin. `/api/*` is proxied server-side to the API by a route handler that reads `API_INTERNAL_URL` at request time, so session
cookies are first-party and the API host isn't exposed to page scripts. Merchant servers call the API
directly with API keys.

The web app's UI is built on shadcn/ui: the generated components live in `apps/web/src/components/ui`
(Radix primitives styled with Tailwind v4), themed in `apps/web/src/app/globals.css` with the standard
shadcn tokens tuned toward Apple's design language (system blue, SF Pro, large radii, Apple's dark
palette). `components/app-ui.tsx` composes them into Setra's product vocabulary (money, statuses,
cards, key/value lists, timelines); light, dark and system appearance come from next-themes.

The Setra Assistant (`apps/api/src/assistant`) is a console interface on top of the same API: it
parses a message into an intent and calls the API in-process as the signed-in user (a per-process
token marks those calls so the audit label records the channel). It has no business logic of its
own. Notifications are the financial events, formatted as cards. See `docs/assistant.md`.

## The pipeline

All business state changes go through `packages/engine`, used by the worker (chain data), the API
(operator resolutions, test-mode simulations) and the seed script. There is one implementation of
"what a payment means".

```
Monad log ──▶ source_observation (immutable evidence)
          ──▶ payment (status: confirming)          ──▶ PAYMENT_OBSERVED        [no economic effect]
          ──▶ provisional match decision            ──▶ "Payment detected" in UI / pay page
  finalized
          ──▶ final match decision (versioned rules, checks, candidates)
          ──▶ allocation (append-only ledger) ──▶ invoice balance/status recomputed from ledger
          ──▶ PAYMENT_MATCHED / PARTIALLY_PAID / OVERPAID / UNKNOWN_PAYMENT (+ exception)
              (events carry the invoice title and purpose, purpose_status, context_source)
          ──▶ webhook deliveries enqueued in the same transaction
  dropped / reorged
          ──▶ compensating allocation ──▶ PAYMENT_REVERSED (reverses_event_id) ──▶ reversal exception
```

### Ingestion (`packages/engine/src/ingestion.ts`)

Two cursors per chain, shared by all tenants and held by one worker via a lease row:

- **tip** scans `(settled, latest]` for sub-second detection. Provisional.
- **settled** scans up to `finalized − settledLagBlocks` (Monad) or `latest − confirmations` (others).
  Only this stage creates economic effects.

Logs are fetched per chain (not per wallet) with OR'd recipient topics in groups of 50, chunked by the
provider's `eth_getLogs` limit, deduplicated by `(block_hash, log_index)`, and ordered canonically
(intent events before transfers within a transaction). A tip observation not found again in the
settled range is dropped with history. Each settled fetch also re-reads a trailing window below the
cursor (`rescanBlocks`, Monad default 30 blocks ≈ 9 s): load-balanced RPC nodes can briefly return empty
logs for blocks they haven't indexed, and the rescan recovers those payments. Re-reads are idempotent
(unique observation key), so the window costs one extra `eth_getLogs` range, never a duplicate. On confirmation-based chains the settled cursor's block hash
is rechecked every tick; a mismatch reverses affected payments and rewinds the cursor.

New wallets start live monitoring at the next settled block and get a backfill job covering recent
history (default 1,500 blocks ≈ 7.5 minutes on Monad) or the block the merchant asked for.

Failure policy: any RPC or DB error aborts the tick without moving a cursor; the loop backs off
exponentially. Nothing is ever marked paid on a guess.

### Two-tier detection on Monad

RPC ingestion (above) always runs and is the only path to economic effects. When a Monad node is
available, the execution-events sidecar (`services/execution-events`, Rust, official SDK) reads the
node's event ring, filters at the node for payments to monitored wallets, and posts them to
`/v1/internal/execution-events`. They are routed through the same decoder and routing function as
RPC logs into the tip stage: provisional, customer and purpose identified, no allocation. The RPC
settled stage later finalizes the same observation (identical block hash, transaction and log
index). Gaps mark the stream incomplete and RPC covers the range. See `docs/execution-events.md`.

### Matching (`packages/matching`)

Pure function, no I/O, no scoring. Rule order: approved asset → verified payment-intent reference →
known customer wallet → exact unique remaining amount → exception with explained candidates. See the
docs page `/docs/payments` for the full rule list. Every decision stores its checks, candidates,
explanation and `rule_version` (`match-v1.1`). Equal-amount invoices for the same known customer need
review unless a verified payment intent identifies one. Expired invoices and invoices cancelled in the last 30
days stay visible to matching so a payment against them becomes a `late_payment` exception that says
why (never an automatic application).

## Data model

| Table | Purpose | Mutability |
|---|---|---|
| organizations, users, organization_members, sessions, invitations, password_resets | Identity & access | mutable |
| api_keys | SHA-256 hashed keys, test/live, scope | revocable |
| networks, assets | Registry synced from code; tokens keyed by (chain_id, address) | reference |
| chain_cursors, wallet_backfills | Ingestion progress and leases | operational |
| wallets, wallet_assets | Monitored public addresses + accepted assets | mutable (archived, never deleted) |
| customers, customer_addresses | Payers and the wallets they pay from | mutable |
| invoices, invoice_sequences | Payment requests: `title` (what the payment is for), `purpose`; balance derived from allocations | mutable projection |
| **invoice_line_items** | Itemization; integer quantity × exact unit price; must sum to the amount (deferred constraint) | immutable |
| payment_intents | Offchain-computed commitments for the intent contract | status only |
| **source_observations** | What the chain said | immutable; only confirmation state may advance (trigger) |
| **observation_state_changes** | observed → finalized / dropped history | append-only |
| **observation_sightings** | Each path (RPC, execution events) that saw an observation, per stage, with time | append-only |
| **execution_signals**, execution_streams | Sidecar signals (global, public chain data) and stream health/gaps | signals append-only |
| payments | One per economic observation; current interpretation; `context_source` (automatic_match / payment_intent / manual_resolution) | mutable projection |
| **match_decisions** | Provisional and final decisions with checks | append-only |
| **allocations** | Ledger: payment → invoice amounts, reversals as negative rows | append-only |
| **financial_events** | Versioned conclusions with evidence; unique dedupe key | append-only |
| exceptions | Review queue; unique dedupe key | status only |
| **resolutions** | Operator/system decisions; `new_state` written once | append-only |
| **payment_corrections** | Operator moves an applied payment to another invoice or back to review; compensating allocations reference it | append-only |
| outgoing_transfers | Stablecoin sent from monitored wallets, from finalized blocks (refund evidence) | immutable except `canonical` |
| **refunds** | A payment's money sent back, each backed by one outgoing transfer | append-only |
| webhook_endpoints | URL, events, encrypted secrets (current + previous during rotation) | mutable |
| webhook_deliveries, **webhook_attempts** | Payload snapshot per delivery; every HTTP attempt | attempts append-only |
| idempotency_keys | Request fingerprint + cached response, 24h | expiring |
| **audit_logs** | Who did what, before/after, request id | append-only |

Bold tables are enforced append-only by PostgreSQL triggers. Every tenant table carries
`organization_id` and has a row-level security policy; the application connects as the non-superuser
`setra_app` role so RLS cannot be bypassed.

## Invariants and where they're enforced

| Invariant | Enforcement |
|---|---|
| One source observation → at most one economic effect | unique observation key; `payments.observation_id` unique; settle only from `confirming`; event dedupe keys |
| Every financial event references evidence and a rule version | columns are NOT NULL; event `data.evidence` built from the observation |
| Money is never floating point | numeric(78,0) + bigint; decimal strings at the API; SQL aggregates in numeric |
| Unsupported assets/chains never satisfy an invoice | matching rule 1; manual assign requires a registry asset with matching peg |
| Pending observations never auto-confirm | only the settled stage (finality) calls `settlePayment` |
| Reorgs create compensating history | `reversePayment` writes reversal allocations + PAYMENT_REVERSED; observation marked non-canonical |
| Manual resolutions don't erase state | resolutions append-only; original decisions/events untouched |
| Corrections don't erase state | a correction writes negative allocations referencing the originals, emits `PAYMENT_UNASSIGNED`, and (for a move) a new settlement event; payments identified by a payment-intent reference cannot be moved |
| Refunds are proven | a refund links an outgoing transfer from the same wallet, same token, after the payment, used once, no larger than what is refundable |
| Tenant isolation | service-level org+environment filters **and** RLS under a non-superuser role |
| A payment's purpose comes only from authoritative data | `business_object` is the applied (or, while confirming, provisionally matched) invoice; otherwise `null` with `purpose_status: unknown`; one serializer feeds API, webhooks and exports |
| Execution-level observations are not financial truth | execution-event signals enter only the tip stage; allocations are written only from finalized RPC data |
| Outages don't fabricate completeness | cursors advance only after commit; UI/API report "delayed"; reconciliation shows coverage warnings |
| Webhook retries don't duplicate effects | deliveries are notifications of already-committed events; unique (endpoint, event) |

## Environments

Every tenant row carries `environment` (`test` | `live`). Test mode resolves `network: "monad"` to Monad
testnet (10143); live mode to Monad mainnet (143). API keys are bound to one environment; the console
session has a mode switch.
