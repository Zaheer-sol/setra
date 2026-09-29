import type { Hex, Log } from "viem";
import { networks } from "@setra/config";
import { decodeActivity, TOPICS, type Activity } from "@setra/blockchain";
import { withSystem } from "@setra/database";
import { log } from "./context";
import { routeActivities, type MonitoredWallet } from "./ingestion";

/**
 * Monad execution events → Setra.
 *
 * The sidecar (services/execution-events) reads the node's event ring with the official SDK and
 * posts batches here. Its logs come from *speculatively executed* blocks, so they enter Setra's
 * pipeline exactly like RPC tip observations: provisional, matched for display, no economic effect.
 * Money only moves when the canonical RPC ingestion sees the same log in a finalized block (same
 * block hash, transaction and log index, so the two paths deduplicate). A log from a block that is
 * never finalized is dropped by the normal tip sweep, with history.
 *
 * Gaps (the ring overwrote events, a payload expired, the sidecar restarted or its delivery backlog
 * overflowed) mark the stream incomplete for a block range. Nothing is inferred for that range:
 * RPC ingestion, which always runs, covers it, and the stream counts as recovered once the settled
 * RPC cursor has passed it.
 */

export interface ExecLogSignal {
  kind: "log";
  seqno: number;
  chain_id: number;
  block_number: number;
  block_id: string;
  block_hash: string;
  block_timestamp: number;
  transaction_hash: string;
  transaction_index: number;
  log_index: number;
  address: string;
  topics: string[];
  data: string;
  /** Nanosecond timestamps are decimal strings (64-bit values). */
  executed_at_ns: string;
  block_executed_at_ns?: string;
  emitted_at_ns?: string;
}

export interface ExecBlockStateSignal {
  kind: "block_state";
  seqno: number;
  chain_id: number;
  block_number: number;
  block_id: string | null;
  state: "voted" | "finalized" | "verified" | "rejected";
  recorded_at_ns: string;
  emitted_at_ns?: string;
}

export interface ExecGapSignal {
  kind: "gap";
  reason: "sequence_gap" | "sequence_discontinuity" | "payload_expired" | "incomplete_block" | "sidecar_start" | "delivery_backlog";
  chain_id: number | null;
  last_complete_block: number | null;
  last_seqno: number | null;
  emitted_at_ns?: string;
}

export type ExecSignal = ExecLogSignal | ExecBlockStateSignal | ExecGapSignal;

export interface ExecBatch {
  chain_id: number;
  sidecar_id: string;
  stats?: { events_consumed?: number; events_relevant?: number; payment_signals?: number; gaps?: number; last_seqno?: number | null; last_block_number?: number | null };
  signals: ExecSignal[];
}

export interface ExecBatchReport {
  accepted: number;
  observations: number;
  ignored: number;
  gaps: number;
}

export class ExecutionEventsError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** Exact: nanoseconds (decimal string) → Date with millisecond resolution, via BigInt. */
const nsToDate = (ns: string | undefined) => (ns && /^\d+$/.test(ns) && ns !== "0" ? new Date(Number(BigInt(ns) / 1_000_000n)) : null);

/** Where the sidecar should look: stablecoins and intent contract on this chain, and every monitored wallet. */
export async function executionWatchlist(chainId: number) {
  const network = networks().byChainId(chainId);
  if (!network || !network.enabled) throw new ExecutionEventsError("network_not_monitored", `Chain ${chainId} is not monitored by this deployment.`);
  const wallets = await withSystem((c) =>
    c.query<{ address: string }>("SELECT DISTINCT address FROM wallets WHERE chain_id = $1 AND monitoring_enabled AND archived_at IS NULL", [chainId])
  );
  return {
    chain_id: chainId,
    tokens: network.assets.map((a) => a.address.toLowerCase()),
    intent_contracts: network.paymentIntent ? [network.paymentIntent.address.toLowerCase()] : [],
    intent_topics: network.paymentIntent ? [TOPICS.PAID_TOPIC, TOPICS.REFUNDED_TOPIC] : [],
    recipients: wallets.rows.map((w) => w.address)
  };
}

export async function ingestExecutionBatch(batch: ExecBatch): Promise<ExecBatchReport> {
  const network = networks().byChainId(batch.chain_id);
  if (!network || !network.enabled) throw new ExecutionEventsError("network_not_monitored", `Chain ${batch.chain_id} is not monitored by this deployment.`);
  const report: ExecBatchReport = { accepted: 0, observations: 0, ignored: 0, gaps: 0 };
  const receivedAt = new Date();

  const wallets = await withSystem(
    async (c) =>
      (
        await c.query(
          `SELECT id, organization_id, environment, chain_id, name, address, monitor_from_block, requested_backfill_from_block
             FROM wallets WHERE chain_id = $1 AND monitoring_enabled AND archived_at IS NULL`,
          [batch.chain_id]
        )
      ).rows.map((r) => ({ ...r, chain_id: Number(r.chain_id) })) as MonitoredWallet[]
  );
  const tokens = new Set(network.assets.map((a) => a.address.toLowerCase()));
  const intent = network.paymentIntent?.address.toLowerCase();

  const activities: Activity[] = [];
  const executedAt = new Map<string, Date>();
  const gaps: ExecGapSignal[] = [];
  let maxBlock: number | null = null;

  for (const s of batch.signals) {
    if (s.kind === "gap") {
      gaps.push(s);
      continue;
    }
    if (s.chain_id !== batch.chain_id) throw new ExecutionEventsError("chain_mismatch", `Signal for chain ${s.chain_id} in a batch for chain ${batch.chain_id}.`);
    if (s.kind === "block_state") continue;
    maxBlock = Math.max(maxBlock ?? 0, s.block_number);
    const emitter = s.address.toLowerCase();
    if (!tokens.has(emitter) && emitter !== intent) {
      report.ignored++;
      continue;
    }
    // The same decoder the RPC path uses: identical activities, identical observations.
    const logShape = {
      address: emitter as Hex,
      topics: s.topics as [Hex, ...Hex[]],
      data: s.data as Hex,
      blockNumber: BigInt(s.block_number),
      blockHash: s.block_hash as Hex,
      transactionHash: s.transaction_hash as Hex,
      transactionIndex: s.transaction_index,
      logIndex: s.log_index,
      removed: false
    } as unknown as Log;
    const activity = decodeActivity(batch.chain_id, logShape, BigInt(s.block_timestamp));
    if (!activity) {
      report.ignored++;
      continue;
    }
    activities.push(activity);
    const at = nsToDate(s.executed_at_ns);
    if (at) executedAt.set(`${activity.blockHash}:${activity.logIndex}`, at);
  }

  // Record every signal (append-only) before acting on it.
  await withSystem(async (c) => {
    for (const s of batch.signals) {
      await c.query(
        `INSERT INTO execution_signals (chain_id, kind, seqno, block_number, block_id, block_hash, transaction_hash, log_index, state, executed_at, emitted_at, received_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          batch.chain_id,
          s.kind,
          s.kind === "gap" ? s.last_seqno : s.seqno,
          s.kind === "gap" ? s.last_complete_block : s.block_number,
          s.kind === "gap" ? null : s.block_id,
          s.kind === "log" ? s.block_hash.toLowerCase() : null,
          s.kind === "log" ? s.transaction_hash.toLowerCase() : null,
          s.kind === "log" ? s.log_index : null,
          s.kind === "block_state" ? s.state : s.kind === "gap" ? s.reason : null,
          s.kind === "log" ? nsToDate(s.executed_at_ns) : s.kind === "block_state" ? nsToDate(s.recorded_at_ns) : null,
          nsToDate(s.emitted_at_ns),
          receivedAt,
          JSON.stringify(s.kind === "log" ? { address: s.address, topics: s.topics, data: s.data, block_timestamp: s.block_timestamp } : s)
        ]
      );
    }
  });

  if (activities.length) {
    report.observations = await routeActivities(activities, wallets, "tip", {
      detectionSource: "execution_events",
      executedAt: (a) => executedAt.get(`${a.blockHash}:${a.logIndex}`)
    });
    log().info("execution_events_ingested", { chain: network.key, activities: activities.length, observations: report.observations, sidecar: batch.sidecar_id });
  }

  // Stream health: counters, last position, and any incomplete range.
  await withSystem(async (c) => {
    await c.query(
      `INSERT INTO execution_streams (chain_id, sidecar_id, last_seqno, last_block_number, last_signal_at, events_consumed, events_relevant, payment_signals, gaps, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (chain_id) DO UPDATE SET
         sidecar_id = excluded.sidecar_id,
         last_seqno = COALESCE(excluded.last_seqno, execution_streams.last_seqno),
         last_block_number = GREATEST(COALESCE(excluded.last_block_number, 0), COALESCE(execution_streams.last_block_number, 0)),
         last_signal_at = excluded.last_signal_at,
         events_consumed = COALESCE($10, execution_streams.events_consumed),
         events_relevant = COALESCE($11, execution_streams.events_relevant),
         payment_signals = COALESCE($12, execution_streams.payment_signals),
         gaps = execution_streams.gaps + excluded.gaps,
         updated_at = now()`,
      [
        batch.chain_id,
        batch.sidecar_id,
        batch.stats?.last_seqno ?? null,
        batch.stats?.last_block_number ?? maxBlock,
        receivedAt,
        batch.stats?.events_consumed ?? 0,
        batch.stats?.events_relevant ?? 0,
        batch.stats?.payment_signals ?? 0,
        gaps.length,
        batch.stats?.events_consumed ?? null,
        batch.stats?.events_relevant ?? null,
        batch.stats?.payment_signals ?? null
      ]
    );
    for (const g of gaps) {
      report.gaps++;
      // The incomplete range starts after the last block the sidecar saw completely and runs to the
      // current head; RPC ingestion covers it. A later gap extends the range.
      const head = batch.stats?.last_block_number ?? maxBlock;
      await c.query(
        `UPDATE execution_streams SET
           incomplete_from_block = CASE WHEN incomplete_from_block IS NULL OR incomplete_to_block IS NULL THEN $2 ELSE LEAST(incomplete_from_block, $2) END,
           incomplete_to_block = GREATEST(COALESCE(incomplete_to_block, 0), $3),
           last_gap_at = now(), last_gap_reason = $4, updated_at = now()
         WHERE chain_id = $1`,
        [batch.chain_id, g.last_complete_block !== null ? g.last_complete_block + 1 : (head ?? 0), head ?? g.last_complete_block ?? 0, g.reason]
      );
      log().warn("execution_events_gap", { chain: network.key, reason: g.reason, lastCompleteBlock: g.last_complete_block, sidecar: batch.sidecar_id });
    }
  });

  report.accepted = batch.signals.length;
  return report;
}

/** Stream status for health checks and the developer view. */
export async function executionStreams() {
  return withSystem(async (c) => {
    const rows = (
      await c.query(
        `SELECT s.*, cur.block_number AS settled_block FROM execution_streams s
           LEFT JOIN chain_cursors cur ON cur.chain_id = s.chain_id AND cur.stage = 'settled'
          ORDER BY s.chain_id`
      )
    ).rows;
    return rows.map((r) => {
      const age = r.last_signal_at ? (Date.now() - new Date(r.last_signal_at).getTime()) / 1000 : null;
      const incomplete = r.incomplete_to_block !== null && (r.settled_block === null || Number(r.settled_block) < Number(r.incomplete_to_block));
      const status = age === null || age > 30 ? "offline" : incomplete ? "recovering" : "live";
      return {
        chain_id: Number(r.chain_id),
        network: networks().byChainId(Number(r.chain_id))?.key ?? null,
        status,
        sidecar_id: r.sidecar_id,
        seconds_since_signal: age === null ? null : Math.round(age),
        last_block_number: r.last_block_number === null ? null : String(r.last_block_number),
        events_consumed: String(r.events_consumed),
        events_relevant: String(r.events_relevant),
        payment_signals: String(r.payment_signals),
        gaps: String(r.gaps),
        incomplete_range: r.incomplete_to_block !== null ? { from_block: String(r.incomplete_from_block), to_block: String(r.incomplete_to_block), covered_by_rpc: !incomplete } : null,
        last_gap: r.last_gap_at ? { at: new Date(r.last_gap_at).toISOString(), reason: r.last_gap_reason } : null
      };
    });
  });
}
