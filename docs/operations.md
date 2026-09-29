# Operations

## Logs

All services log one JSON object per line with `time`, `level`, `service` and `event`. The API adds
`reqId` (also returned as `X-Request-Id` and in error bodies). Key events:

| Event | Meaning |
|---|---|
| `worker_started`, `chain_ingestion_started` | worker boot, per network with settlement policy |
| `wallet_monitor_started` | a new wallet was activated; includes backfill range |
| `block_ingested` | a settled range with activity was processed |
| `source_observation_created` | new evidence (`stage`: tip or settled) |
| `payment_match_attempted` | final decision with outcome and rule version |
| `financial_event_created`, `exception_created`, `exception_resolved` | business state changes |
| `reorg_detected` | tip observation dropped, or settled payment reversed |
| `webhook_sent`, `webhook_failed`, `webhook_replayed` | delivery outcomes with status and latency |
| `payment_intent_created`, `refund_observed` | intent lifecycle |
| `ingestion_<network>_failed` | a tick failed; the loop is backing off |

## Failure behaviour

| Failure | What Setra does |
|---|---|
| RPC unavailable / rate-limited | The tick fails before moving any cursor; exponential backoff up to 60 s; `chain_cursors.last_error` set; wallets show "Provider error"; reconciliation warns totals may be incomplete. Resumes exactly where it stopped. |
| Lagging load-balanced node returns empty logs | The trailing rescan window re-reads recent settled blocks on the next tick and records the payment once. |
| Provider returns "range too large" | The range is halved recursively until accepted. |
| Database unavailable | API returns 500/503 with a request id; worker ticks fail and retry; nothing is half-written (each observation is one transaction). |
| Worker restart / crash | Leases expire after 30 s; the next worker resumes from the committed cursor. Reprocessing is idempotent. |
| Two workers running | Only the lease holder ingests a chain; webhook claims use `FOR UPDATE SKIP LOCKED`. |
| Webhook endpoint down | Retries with backoff (~30 s → 6 h cap), 10 attempts, every attempt recorded; `410 Gone` stops retries; replay any time. |
| Duplicate log / block / transaction | Unique observation key; no second payment, allocation or event. |
| Reorg below the settled cursor (confirmation chains) | Hash mismatch detected; affected payments reversed with compensating allocations; cursor rewound; new canonical blocks rescanned. |
| Stale cursor (worker was down for hours) | Settled stage catches up in bounded chunks (10× the provider range per tick); the tip stage waits until settled is current. |

## Monitoring

Alert on `GET /v1/health?strict=true` returning non-200 (database, ingestion delayed/failing, webhook
queue stalled). `scripts/health-monitor.mjs` does this from cron and posts to a Slack-compatible webhook
on state changes. See `docs/deployment.md`.

## Runbooks

**"Monitoring delayed" in the console.** Check `GET /v1/health` and worker logs for
`ingestion_*_failed`. Usually an RPC outage or rate limit: switch `MONAD_RPC_URL` to another provider
and restart the worker. No data is lost; the cursor hasn't moved.

**A payment is missing.** Search the transaction hash in Payments. If absent: confirm the recipient is a
monitored wallet on the right network and the token is a registry asset; check the wallet's
"Monitoring since" block. For payments before that block, create the wallet again with a
`backfill_from_block` (API); rescans are idempotent.

**Webhook endpoint failing.** Developers → Webhooks shows each attempt's status and response. After the
merchant fixes their endpoint, replay failed deliveries.

**Rotating `ENCRYPTION_KEY`.** Not supported in place. Rotate each webhook endpoint's secret after
deploying a new key only if you've re-encrypted; otherwise keep the existing key.

## Data retention

Financial history (observations, decisions, allocations, events, resolutions, attempts, audit logs)
is retained indefinitely by design. Idempotency keys expire after 24 hours (housekeeping).
