# Monad Execution Events in Setra

Setra detects payments two ways on Monad:

```
                        MONAD NODE (same host)
                 execution daemon ──▶ event ring (shared memory, hugetlbfs)
                                          │
                                          ▼
                 services/execution-events  (Rust, official SDK)
                 filter at the node: stablecoin Transfer → monitored wallet,
                 SetraPaymentIntent events → monitored merchant
                 assemble block, compute RPC log index, drop reverted txns,
                 detect sequence gaps / expired payloads
                                          │  POST /v1/internal/execution-events
                                          ▼
   MONAD RPC ──▶ ChainIngestor ──▶  Setra ingestion (one routing function, one decoder)
   tip + finalized    (always on)          │
                                           ▼
                        observation (provisional) → customer + purpose identified
                                           │
                        canonical, finalized RPC data only
                                           ▼
                        allocation → PAYMENT_MATCHED → signed webhook
```

**Execution events make detection earlier. They never make money move.** A log from the event ring
comes from a *speculatively executed* block. Setra records it as a provisional observation (the same
stage as an RPC tip sighting), identifies the customer, invoice and purpose, and shows
"Detected · confirming". The invoice is only paid when Setra's RPC ingestion sees the same log
(same block hash, transaction and block-wide log index) in a finalized block. If the proposal that
contained it is abandoned, the observation is dropped by the normal tip sweep, with history, and
nothing economic ever happened.

## What was built

| Part | Where | Notes |
|---|---|---|
| Sidecar | `services/execution-events` (Rust) | Official Category Labs SDK: `monad-event-ring` + `monad-exec-events`, tag `release/exec-events-sdk-v1.1` (`scripts/fetch-sdk.sh`) |
| Tracker (state machine) | `src/tracker.rs` | Block assembly, RPC-identical log index, reverted-txn exclusion, commit states, gap detection. 9 unit tests |
| Node-level filter | `src/watch.rs` | Only `Transfer(from, to, value)` from registry stablecoins to a monitored wallet, and intent events naming a monitored merchant. 3 unit tests |
| Delivery | `src/sink.rs` | Batched HTTP, bounded backlog, retry with backoff; 4xx from Setra is fatal (misconfiguration); NDJSON on stdout for validation |
| Ingest API | `POST /v1/internal/execution-events`, `GET …/watchlist` | Shared secret `EXEC_EVENTS_INGEST_TOKEN`; hidden from the public API; disabled when unset |
| Engine | `packages/engine/src/execution-events.ts` | Decodes with the RPC path's decoder, routes through the RPC path's routing function, records every signal, tracks stream health |
| Data | migration `0003_execution_events.sql` | `source_observations.detection_source`, `.executed_at`; `observation_sightings` (per source, per stage); `execution_signals` (append-only); `execution_streams` |
| Health | `GET /v1/health` → `checks.execution_events`, `warnings` | A disconnected or recovering sidecar is a warning, never a failure |
| UI | Payment → Detection card (technical); Developers → Payment detection | Merchant screens only say "Detected · confirming" → "Paid" |

### How the sidecar reads events

* Every descriptor is classified through the SDK's own decoder with a zero-copy `try_filter_map`
  (block start/end, commit states, transaction hash, receipt status and log count, log address and
  topics). Only a relevant log's data is copied out of shared memory.
* At `BLOCK_END` the block is complete: the Ethereum block hash is known, every transaction's receipt
  (`status`, `log_count`) has been seen, so the block-wide log index is
  `logs in earlier transactions + index within the transaction`, exactly what RPC reports.
  Logs of transactions whose receipt status is false are never emitted.
* Consensus events (`BLOCK_QC` → voted, `BLOCK_FINALIZED`, `BLOCK_VERIFIED`) are forwarded only for
  blocks that contained a payment.
* The chain id comes from `BLOCK_START`; a sidecar started with `--chain-id` exits if the node is on
  another chain. Setra independently refuses signals for chains it does not monitor.

### Gaps and failure

The event ring overwrites old events; a slow reader loses them. The sidecar treats all of these as
a gap: the SDK's `EventNextResult::Gap`, a non-contiguous sequence number (its own check), an expired
payload, a block that is incomplete (missing receipt or header, or a new `BLOCK_START` before
`BLOCK_END`), a (re)start mid-stream, and a delivery backlog overflow. On a gap it discards the
partial block, never emits it, and sends a `gap` signal with the last block it saw completely.

Setra marks the stream **incomplete** from that block and does not infer anything for the range.
RPC ingestion, which always runs, observes every block anyway; the stream counts as recovered once
the settled RPC cursor has passed the range (`checks.execution_events.streams[].incomplete_range.covered_by_rpc`).
If the sidecar is down, Setra keeps working exactly as before on RPC alone.

Duplicate signals (retries, restarts, replays) are harmless: observations are unique on
`(organization, chain, block hash, transaction, log index, source type)`, and both paths produce the
same key for the same log.

## Evidence

### The SDK consumer on real execution-event data

The official SDK ships snapshot files of real event rings captured from the execution daemon. The
sidecar replayed `exec-events-emn-30b-15m` (the daemon's conformance replay of Ethereum mainnet
blocks 15,000,001–15,000,030) with the USDC contract as the token filter and every recipient
watched, and `scripts/validate-snapshot.mjs` compared its output with a canonical Ethereum RPC node:

| Check | Result |
|---|---|
| Events consumed | 136,891 (30 blocks executed; 30 voted, 30 finalized, 29 verified) |
| USDC transfers emitted by the sidecar | 511 |
| USDC transfers on chain (`eth_getLogs`) | 511 |
| Exact matches (block hash, tx hash, tx index, block-wide log index, from, to, amount) | **511 / 511** |
| Missed / mismatched | 0 / 0 |
| Gaps | 0 |
| Replay throughput (release build, Apple M-series, in-memory snapshot) | 3.9–6.1 million events/s (23–35 ms for the whole snapshot) |

The SDK's other published snapshot (`exec-events-mdn-500b-genesis`, a Monad devnet) is **refused by
the SDK itself** ("event ring schema hash does not match") because its binary schema predates SDK
v1.1. That refusal is the SDK's safety check working; no Monad-chain snapshot compatible with v1.1
was available, so Monad-specific commit-state behavior is validated by unit tests and by the
Ethereum replay (which carries the same consensus events).

### The real sidecar talking to Setra

The release binary was pointed at the running Setra API over HTTP:

* real sidecar output (511 log signals) passes Setra's schema validation, and Setra refuses it for
  the correct reason: chain 1 is not a monitored network (`422 network_not_monitored`); the sidecar
  exits with code 3 instead of retrying a permanent rejection;
* a wrong token is refused (`401`);
* the sidecar loads Setra's live watchlist for Monad testnet (11 monitored wallets, testnet USDC).

This run found and fixed a real defect: nanosecond timestamps exceed JavaScript's exact integer
range, so they now travel as decimal strings and are parsed with BigInt.

### Setra's handling of execution-event signals

`packages/engine/test/execution-events.test.ts` runs against a real EVM node (Anvil). Each signal is
built from a real receipt in exactly the sidecar's output format:

* detected at execution → provisional observation with `detection_source = execution_events`,
  customer and invoice (and so purpose) identified, **invoice still open, no allocation**; then the
  RPC path finalizes the same observation and the invoice is paid; sightings show execution events
  first, RPC at settlement;
* the same signal delivered four times → one observation, one payment;
* a log from a proposal that never finalized (different block hash) → dropped, payment reversed
  with zero net allocation; the canonical transaction paid the invoice exactly once;
* a gap → stream `recovering`; a payment made during the gap (never reported by the sidecar) is
  caught by RPC; the stream returns to `live` with the range marked covered by RPC;
* a burst of 25 payments in one delivery (and the same burst again) → exactly 25 payments;
* unmonitored recipients ignored; unknown chains and chain mismatches refused.

`apps/api/test/execution-events.test.ts` covers authentication, validation, the watchlist and that
the endpoints are absent from the public OpenAPI document.

### Measured latency

| Step | Measured | Where |
|---|---|---|
| Sidecar: event ring → signal | 136,891 events in 23–35 ms on replay (≈0.2 µs/event) | snapshot replay; live latency needs a node |
| Setra: signal received → committed observation with customer and purpose identified | 18–25 ms (one cold outlier: 173 ms) | local Postgres, 5 runs |
| RPC path on real Monad testnet: tip sighting → finalized | 1.55 s (INV-2062), ~2.4 s (INV-2061) | recorded sightings, dev database |

**Not measured, and not claimed:** the live gap between execution and RPC detection on Monad. That
requires a Monad full node on the same host as the sidecar. When one is attached, every payment's
Detection card shows it from recorded timestamps (`execution_to_detection`,
`execution_events_lead_over_rpc`, `detection_to_confirmation`).

## Running it

On the Monad node host (Linux; the execution daemon only runs on Linux), after
[enabling execution events](https://docs.monad.xyz/guides/execution-events/setup) (`hugetlbfs`
mount, `--exec-event-ring` flag on `monad-execution`):

```bash
sudo apt install git curl gcc g++ cmake clang-19 libzstd-dev libhugetlbfs-dev   # SDK build requirements
cd services/execution-events && ./scripts/fetch-sdk.sh && cargo build --release
SETRA_URL=https://api.example.com SETRA_EXEC_EVENTS_TOKEN=… \
  ./target/release/setra-exec-sidecar --chain-id 10143 \
  --event-ring-path /var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings/monad-exec-events
```

Set the same `EXEC_EVENTS_INGEST_TOKEN` (≥ 32 characters) on the Setra API. A systemd unit is in
`services/execution-events/README.md`. Replay a snapshot anywhere (macOS works) to try it:

```bash
./target/release/setra-exec-sidecar --event-ring-path ./testdata/exec-events-emn-30b-15m.zst \
  --token 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 --all-recipients --stdout
```

## What still depends on a full node

* Live consumption of Monad's event ring (the sidecar's live path is the SDK's documented live
  reader, but it has not been run against a live Monad node here).
* Live gap behavior under real load (tested with injected gaps).
* The measured execution-vs-RPC detection advantage on Monad.

Running a Monad full node requires dedicated Linux hardware (see Monad's node requirements); none
was available in this environment, and none was purchased.
