import type { NetworkConfig } from "@setra/config";
import { fetchActivity, type Activity, type ChainAdapter } from "@setra/blockchain";
import { withSystem, withTenant } from "@setra/database";
import { newId } from "@setra/schemas";
import { log } from "./context";
import { recordOutgoingTransfer } from "./corrections";
import { dropObservation, ingestObservation, recordIntentRefund, reversePayment, type ObservationInput, type Stage, type WalletRef } from "./pipeline";
import type { Hex } from "viem";

/**
 * Chain ingestion for one network.
 *
 * Two cursors per chain, shared by every tenant:
 *   tip      scans up to `latest` for sub-second "payment detected" feedback. Provisional only.
 *   settled  scans up to the settled head (Monad: `finalized` − safety lag). Creates economic effects.
 *
 * Correctness rules:
 *   - Cursors only advance after a range is fully processed and committed, so restarts resume safely.
 *   - Observations are unique by (org, chain, block hash, tx hash, log index, source), reprocessing a
 *     range, a duplicate log or a duplicate block is a no-op.
 *   - A tip observation that is not found again in the settled scan is dropped (with history).
 *   - On confirmation-based chains, the settled cursor's block hash is re-checked every tick; if the
 *     chain reorganized below it, affected settled payments are reversed and the range is rescanned.
 *   - RPC failures stop the tick without moving any cursor ("pause and retry", never "guess").
 */

export interface MonitoredWallet extends WalletRef {
  monitor_from_block: string | null;
  requested_backfill_from_block: string | null;
}

export interface IngestorOptions {
  workerId: string;
  /** Max blocks scanned by the settled stage per tick (bounded work while catching up). */
  maxSettledBlocksPerTick?: number;
  /** Max blocks behind `latest` the tip stage looks at; older blocks are left to the settled stage. */
  maxTipBlocks?: number;
  /** Recent blocks to backfill when a wallet starts being monitored (covers the gap between creation and pickup). */
  backfillSafetyBlocks?: number;
  leaseSeconds?: number;
  /**
   * Blocks behind the settled cursor that are re-read every tick. Load-balanced RPC endpoints can
   * serve eth_getLogs from a node that is a few blocks behind and silently return nothing for the
   * newest blocks; re-reading a short trailing window recovers those logs. Reprocessing is idempotent.
   */
  rescanBlocks?: number;
}

export interface TickReport {
  chain: string;
  skipped?: string;
  tip?: { from: string; to: string; activities: number };
  settled?: { from: string; to: string; activities: number; dropped: number };
  backfill?: { wallet: string; from: string; to: string; activities: number };
  headLag?: string;
}

export class ChainIngestor {
  private readonly opts: Required<IngestorOptions>;

  constructor(
    readonly adapter: ChainAdapter,
    options: IngestorOptions
  ) {
    const range = adapter.network.logsBlockRange;
    this.opts = {
      maxSettledBlocksPerTick: range * 10,
      maxTipBlocks: Math.max(range, 50),
      backfillSafetyBlocks: 1500,
      leaseSeconds: 30,
      rescanBlocks: adapter.network.settlement.mode === "finality-tag" ? adapter.network.settledLagBlocks * 6 : 0,
      ...options
    };
  }

  get network(): NetworkConfig {
    return this.adapter.network;
  }

  /** One ingestion cycle. Safe to call concurrently from several workers: only the lease holder proceeds. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { chain: this.network.key };
    if (!(await this.acquireLease())) return { ...report, skipped: "lease_held_elsewhere" };
    try {
      const wallets = await this.loadWallets();
      const settledHead = await this.adapter.getSettledHead();
      const target = settledHead.number - BigInt(this.network.settledLagBlocks);
      const cursor = await this.ensureCursor(target);

      if (this.network.settlement.mode === "confirmations") {
        const rewound = await this.checkForReorg(cursor);
        if (rewound !== null) {
          report.settled = { from: rewound.toString(), to: rewound.toString(), activities: 0, dropped: 0 };
          return report;
        }
      }

      await this.activateWallets(wallets, cursor);
      const active = wallets.filter((w) => w.monitor_from_block !== null);

      // Settled stage.
      const from = cursor + 1n;
      const to = target < from + BigInt(this.opts.maxSettledBlocksPerTick) - 1n ? target : from + BigInt(this.opts.maxSettledBlocksPerTick) - 1n;
      if (from <= to) {
        const rescanFrom = from - BigInt(this.opts.rescanBlocks) > 0n ? from - BigInt(this.opts.rescanBlocks) : 0n;
        const activities = await this.fetch(active, rescanFrom, to, true);
        await this.route(activities, active, "settled");
        const dropped = await this.sweepUnconfirmed(to);
        // Confirmation-based chains keep the cursor block's hash for reorg detection; finality-tag chains don't need it.
        const endHash = this.network.settlement.mode === "confirmations" ? (await this.adapter.getBlock(to, false)).hash : null;
        await this.saveCursor("settled", to, endHash, settledHead.number);
        report.settled = { from: from.toString(), to: to.toString(), activities: activities.length, dropped };
        if (activities.length) log().info("block_ingested", { chain: this.network.key, stage: "settled", from, to, activities: activities.length });
      }

      // Tip stage: only once the settled stage has caught up, so provisional data is always fresh.
      const settledNow = to >= from ? to : cursor;
      if (target - settledNow <= BigInt(this.network.logsBlockRange)) {
        const latest = await this.adapter.getLatestBlockNumber();
        const tipCursor = await this.readCursor("tip");
        let tipFrom = (tipCursor ?? settledNow) + 1n;
        if (tipFrom <= settledNow) tipFrom = settledNow + 1n;
        if (latest - tipFrom > BigInt(this.opts.maxTipBlocks)) tipFrom = latest - BigInt(this.opts.maxTipBlocks);
        if (tipFrom <= latest) {
          const activities = await this.fetch(active, tipFrom, latest);
          await this.route(activities, active, "tip");
          await this.saveCursor("tip", latest, null, latest);
          report.tip = { from: tipFrom.toString(), to: latest.toString(), activities: activities.length };
        }
        report.headLag = (latest - settledHead.number).toString();
      }

      await this.runBackfill(report);
      await this.clearError();
      return report;
    } catch (error) {
      await this.recordError(error as Error);
      throw error;
    } finally {
      await this.releaseLease();
    }
  }

  // ── wallets ────────────────────────────────────────────────────────────────────────────────

  private async loadWallets(): Promise<MonitoredWallet[]> {
    return withSystem(async (client) => {
      const rows = await client.query(
        `SELECT id, organization_id, environment, chain_id, name, address, monitor_from_block, requested_backfill_from_block
           FROM wallets WHERE chain_id = $1 AND monitoring_enabled AND archived_at IS NULL`,
        [this.network.chainId]
      );
      return rows.rows.map((r) => ({ ...r, chain_id: Number(r.chain_id) })) as MonitoredWallet[];
    });
  }

  /**
   * Newly added wallets start live monitoring at the next settled block, and get a backfill job
   * covering recent history (or the block the merchant asked for) so nothing between creation and
   * pickup is missed.
   */
  private async activateWallets(wallets: MonitoredWallet[], cursor: bigint): Promise<void> {
    for (const wallet of wallets.filter((w) => w.monitor_from_block === null)) {
      const startLive = cursor + 1n;
      const safety = cursor > BigInt(this.opts.backfillSafetyBlocks) ? cursor - BigInt(this.opts.backfillSafetyBlocks) : 0n;
      const requested = wallet.requested_backfill_from_block !== null ? BigInt(wallet.requested_backfill_from_block) : null;
      const backfillFrom = requested !== null && requested < safety ? requested : safety;
      await withTenant(wallet.organization_id, async (client) => {
        const updated = await client.query("UPDATE wallets SET monitor_from_block = $1, updated_at = now() WHERE id = $2 AND monitor_from_block IS NULL RETURNING id", [
          startLive.toString(),
          wallet.id
        ]);
        if (!updated.rows[0]) return;
        if (backfillFrom <= cursor) {
          await client.query(
            `INSERT INTO wallet_backfills (id, organization_id, wallet_id, chain_id, from_block, to_block, next_block) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
            [newId("backfill"), wallet.organization_id, wallet.id, this.network.chainId, backfillFrom.toString(), cursor.toString()]
          );
        }
      });
      wallet.monitor_from_block = startLive.toString();
      log().info("wallet_monitor_started", { chain: this.network.key, walletId: wallet.id, organizationId: wallet.organization_id, fromBlock: startLive, backfillFrom });
    }
  }

  private async runBackfill(report: TickReport): Promise<void> {
    const job = await withSystem(async (client) => {
      const r = await client.query(
        `SELECT b.*, w.organization_id, w.environment, w.name, w.address, w.chain_id AS wallet_chain_id
           FROM wallet_backfills b JOIN wallets w ON w.id = b.wallet_id
          WHERE b.chain_id = $1 AND b.status IN ('pending','running') AND w.archived_at IS NULL
          ORDER BY b.created_at LIMIT 1`,
        [this.network.chainId]
      );
      return r.rows[0];
    });
    if (!job) return;
    const from = BigInt(job.next_block);
    const end = BigInt(job.to_block);
    const span = BigInt(this.network.logsBlockRange * 5);
    const to = from + span - 1n < end ? from + span - 1n : end;
    const wallet: MonitoredWallet = {
      id: job.wallet_id,
      organization_id: job.organization_id,
      environment: job.environment,
      chain_id: Number(job.wallet_chain_id),
      name: job.name,
      address: job.address,
      monitor_from_block: "0",
      requested_backfill_from_block: null
    };
    try {
      const activities = from <= to ? await this.fetch([wallet], from, to, true) : [];
      await this.route(activities, [wallet], "settled", true);
      await withTenant(job.organization_id, (client) =>
        client.query("UPDATE wallet_backfills SET next_block = $1, status = $2, attempts = attempts + 1, updated_at = now(), completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END WHERE id = $3", [
          (to + 1n).toString(),
          to >= end ? "completed" : "running",
          job.id
        ])
      );
      report.backfill = { wallet: wallet.id, from: from.toString(), to: to.toString(), activities: activities.length };
    } catch (error) {
      await withTenant(job.organization_id, (client) =>
        client.query("UPDATE wallet_backfills SET attempts = attempts + 1, last_error = $1, updated_at = now() WHERE id = $2", [(error as Error).message.slice(0, 500), job.id])
      );
      throw error;
    }
  }

  // ── fetching and routing ───────────────────────────────────────────────────────────────────

  private async fetch(wallets: MonitoredWallet[], from: bigint, to: bigint, outgoing = false): Promise<Activity[]> {
    if (!wallets.length) return [];
    return fetchActivity(this.adapter, {
      fromBlock: from,
      toBlock: to,
      wallets: [...new Set(wallets.map((w) => w.address as Hex))],
      tokens: this.network.assets.map((a) => a.address as Hex),
      intentContract: this.network.paymentIntent?.address as Hex | undefined,
      outgoing
    });
  }

  private async route(activities: Activity[], wallets: MonitoredWallet[], stage: Stage, backfill = false): Promise<void> {
    await routeActivities(activities, wallets, stage, { backfill });
  }

  /** Tip observations at or below the settled height that were not seen again are no longer canonical. */
  private async sweepUnconfirmed(settledTo: bigint): Promise<number> {
    const stale = await withSystem((client) =>
      client.query<{ id: string; organization_id: string }>(
        `SELECT id, organization_id FROM source_observations
          WHERE chain_id = $1 AND confirmation_state = 'observed' AND canonical AND source_type <> 'simulated' AND block_number <= $2`,
        [this.network.chainId, settledTo.toString()]
      )
    );
    for (const row of stale.rows) {
      await withTenant(row.organization_id, (client) => dropObservation(client, row.id, "Not included in the settled chain", settledTo));
    }
    return stale.rowCount ?? 0;
  }

  /**
   * Confirmation-based chains only: if the block at our settled cursor changed hash, the chain
   * reorganized deeper than our confirmation depth. Reverse settled payments in the affected range
   * and rewind the cursor so the new canonical blocks are scanned.
   */
  private async checkForReorg(cursor: bigint): Promise<bigint | null> {
    const stored = await withSystem((client) =>
      client.query<{ block_hash: string | null }>("SELECT block_hash FROM chain_cursors WHERE chain_id = $1 AND stage = 'settled'", [this.network.chainId])
    );
    const expected = stored.rows[0]?.block_hash;
    if (!expected || cursor <= 0n) return null;
    const current = await this.adapter.getBlock(cursor, false);
    if (current.hash.toLowerCase() === expected.toLowerCase()) return null;

    const depth = BigInt(Math.max(this.network.settlement.mode === "confirmations" ? this.network.settlement.confirmations * 4 : 64, 16));
    const rewindTo = cursor > depth ? cursor - depth : 0n;
    log().warn("reorg_detected", { chain: this.network.key, cursor, expected, actual: current.hash, rewindTo });
    const affected = await withSystem((client) =>
      client.query<{ payment_id: string; organization_id: string; block_number: string; block_hash: string }>(
        `SELECT p.id AS payment_id, p.organization_id, o.block_number, o.block_hash FROM payments p JOIN source_observations o ON o.id = p.observation_id
          WHERE o.chain_id = $1 AND o.canonical AND o.block_number > $2 AND p.status <> 'reversed' AND o.source_type <> 'simulated'`,
        [this.network.chainId, rewindTo.toString()]
      )
    );
    for (const row of affected.rows) {
      const block = await this.adapter.getBlock(BigInt(row.block_number), false);
      if (block.hash.toLowerCase() !== row.block_hash) {
        await withTenant(row.organization_id, (client) => reversePayment(client, row.payment_id, `Chain reorganization at block ${row.block_number}`));
      }
    }
    const rewindBlock = await this.adapter.getBlock(rewindTo, false);
    await this.saveCursor("settled", rewindTo, rewindBlock.hash, null);
    await this.saveCursor("tip", rewindTo, null, null);
    return rewindTo;
  }

  // ── cursors and lease ─────────────────────────────────────────────────────────────────────

  private async ensureCursor(target: bigint): Promise<bigint> {
    return withSystem(async (client) => {
      const existing = await client.query<{ block_number: string }>("SELECT block_number FROM chain_cursors WHERE chain_id = $1 AND stage = 'settled'", [this.network.chainId]);
      const current = existing.rows[0] ? BigInt(existing.rows[0].block_number) : -1n;
      if (current >= 0n) return current;
      // First run: start at the current settled head. History is covered per wallet by backfill jobs.
      const start = target > 0n ? target - 1n : 0n;
      await client.query("UPDATE chain_cursors SET block_number = $2, updated_at = now() WHERE chain_id = $1 AND stage = 'settled'", [this.network.chainId, start.toString()]);
      return start;
    });
  }

  private async readCursor(stage: "tip" | "settled"): Promise<bigint | null> {
    const r = await withSystem((client) => client.query<{ block_number: string }>("SELECT block_number FROM chain_cursors WHERE chain_id = $1 AND stage = $2", [this.network.chainId, stage]));
    return r.rows[0] ? BigInt(r.rows[0].block_number) : null;
  }

  private async saveCursor(stage: "tip" | "settled", block: bigint, hash: string | null, head: bigint | null): Promise<void> {
    await withSystem((client) =>
      client.query(
        `INSERT INTO chain_cursors (chain_id, stage, block_number, block_hash, head_block_number, updated_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (chain_id, stage) DO UPDATE SET block_number = excluded.block_number, block_hash = excluded.block_hash,
           head_block_number = COALESCE(excluded.head_block_number, chain_cursors.head_block_number), updated_at = now()`,
        [this.network.chainId, stage, block.toString(), hash?.toLowerCase() ?? null, head?.toString() ?? null]
      )
    );
  }

  private async acquireLease(): Promise<boolean> {
    return withSystem(async (client) => {
      // A fresh install has no cursor row yet; -1 marks "not initialized" and is resolved in ensureCursor.
      await client.query(`INSERT INTO chain_cursors (chain_id, stage, block_number) VALUES ($1, 'settled', -1) ON CONFLICT DO NOTHING`, [this.network.chainId]);
      const r = await client.query(
        `UPDATE chain_cursors SET lease_owner = $2, lease_expires_at = now() + make_interval(secs => $3)
          WHERE chain_id = $1 AND stage = 'settled' AND (lease_owner IS NULL OR lease_owner = $2 OR lease_expires_at < now())
          RETURNING chain_id`,
        [this.network.chainId, this.opts.workerId, this.opts.leaseSeconds]
      );
      return Boolean(r.rows[0]);
    });
  }

  private async releaseLease(): Promise<void> {
    await withSystem((client) =>
      client.query("UPDATE chain_cursors SET lease_owner = NULL, lease_expires_at = NULL WHERE chain_id = $1 AND stage = 'settled' AND lease_owner = $2", [
        this.network.chainId,
        this.opts.workerId
      ])
    ).catch(() => undefined);
  }

  private async recordError(error: Error): Promise<void> {
    await withSystem((client) =>
      client.query("UPDATE chain_cursors SET last_error = $2, last_error_at = now() WHERE chain_id = $1 AND stage = 'settled'", [this.network.chainId, error.message.slice(0, 500)])
    ).catch(() => undefined);
  }

  private async clearError(): Promise<void> {
    await withSystem((client) => client.query("UPDATE chain_cursors SET last_error = NULL WHERE chain_id = $1 AND stage = 'settled' AND last_error IS NOT NULL", [this.network.chainId]));
  }
}

/**
 * Deliver each activity to every organization monitoring the receiving address (an address can be
 * monitored by more than one workspace; each gets its own evidence). Within a transaction, intent
 * events are processed before transfers so the transfer attaches as supporting evidence.
 */
export async function routeActivities(
activities: Activity[],
wallets: MonitoredWallet[],
stage: Stage,
opts: { backfill?: boolean; detectionSource?: "rpc" | "execution_events"; executedAt?: (activity: Activity) => Date | undefined } = {}
): Promise<number> {
const backfill = opts.backfill ?? false;
let observed = 0;
  // Canonical order, except that within one transaction intent events come before transfers.
  const ordered = [...activities].sort(
    (a, b) =>
      (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0) ||
      a.transactionIndex - b.transactionIndex ||
      (a.kind === "transfer" ? 1 : 0) - (b.kind === "transfer" ? 1 : 0) ||
      a.logIndex - b.logIndex
  );
  for (const activity of ordered) {
    if (activity.kind === "intent_refunded") {
      // Refunds only count once final; tip sightings are ignored and picked up by the settled scan.
      if (stage !== "settled") continue;
      for (const wallet of wallets.filter((w) => w.address === activity.merchant)) {
        await withTenant(wallet.organization_id, (client) =>
          recordIntentRefund(client, wallet, {
            intentHash: activity.intentId,
            emitter: activity.emitter,
            transactionHash: activity.transactionHash,
            blockNumber: activity.blockNumber,
            blockHash: activity.blockHash,
            logIndex: activity.logIndex,
            amount: activity.amount,
            payer: activity.payer,
            blockTimestamp: new Date(Number(activity.blockTimestamp) * 1000)
          })
        );
      }
      continue;
    }
    // Money sent from a monitored wallet: evidence for refunds, recorded from finalized data only.
    if (activity.kind === "transfer" && stage === "settled") {
      for (const wallet of wallets.filter((w) => w.address === activity.from && (backfill || (w.monitor_from_block !== null && activity.blockNumber >= BigInt(w.monitor_from_block))))) {
        await withTenant(wallet.organization_id, (client) =>
          recordOutgoingTransfer(client, wallet, {
            chainId: activity.chainId,
            blockNumber: activity.blockNumber,
            blockHash: activity.blockHash,
            transactionHash: activity.transactionHash,
            transactionIndex: activity.transactionIndex,
            logIndex: activity.logIndex,
            tokenAddress: activity.token,
            toAddress: activity.to,
            amount: activity.amount,
            blockTimestamp: new Date(Number(activity.blockTimestamp) * 1000)
          })
        );
      }
    }
    const recipient = activity.kind === "transfer" ? activity.to : activity.merchant;
    const targets = wallets.filter(
      (w) => w.address === recipient && (backfill || (w.monitor_from_block !== null && activity.blockNumber >= BigInt(w.monitor_from_block)))
    );
    for (const wallet of targets) {
      const input: ObservationInput =
        activity.kind === "transfer"
          ? {
              sourceType: "erc20_transfer",
              chainId: activity.chainId,
              blockNumber: activity.blockNumber,
              blockHash: activity.blockHash,
              transactionHash: activity.transactionHash,
              transactionIndex: activity.transactionIndex,
              logIndex: activity.logIndex,
              tokenAddress: activity.token,
              fromAddress: activity.from,
              toAddress: activity.to,
              amount: activity.amount,
              blockTimestamp: new Date(Number(activity.blockTimestamp) * 1000),
              emitter: activity.emitter,
              raw: activity.raw
            }
          : {
              sourceType: "payment_intent_event",
              chainId: activity.chainId,
              blockNumber: activity.blockNumber,
              blockHash: activity.blockHash,
              transactionHash: activity.transactionHash,
              transactionIndex: activity.transactionIndex,
              logIndex: activity.logIndex,
              tokenAddress: activity.token,
              fromAddress: activity.payer,
              toAddress: activity.merchant,
              amount: activity.amount,
              blockTimestamp: new Date(Number(activity.blockTimestamp) * 1000),
              emitter: activity.emitter,
              intentHash: activity.intentId,
              raw: activity.raw
            };
      input.detectionSource = opts.detectionSource ?? "rpc";
      input.executedAt = opts.executedAt?.(activity);
      const result = await withTenant(wallet.organization_id, (client) => ingestObservation(client, wallet, input, stage));
      if (result.observationId) observed++;
    }
  }
  return observed;
}
