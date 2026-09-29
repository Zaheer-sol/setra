import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { appEnv, networks } from "@setra/config";
import { createAdapter } from "@setra/blockchain";
import { closePools } from "@setra/database";
import { ChainIngestor, collectNetworkFees, deliverDueWebhooks, log, runHousekeeping, runRecurringBills } from "@setra/engine";

/**
 * Setra worker: blockchain ingestion (one loop per enabled network), webhook delivery and
 * housekeeping. Long-running work never happens in the API's request lifecycle.
 *
 * Failure policy: any error pauses that loop with exponential backoff and retries. Cursors only
 * advance after a range is committed, so a crash or restart resumes exactly where it stopped.
 */

process.env.SETRA_SERVICE ??= "setra-worker";
const env = appEnv();
const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
let stopping = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop(name: string, intervalMs: number, fn: () => Promise<unknown>, wake?: (resume: () => void) => () => void) {
  let failures = 0;
  let wakeUp: (() => void) | null = null;
  const unsubscribe = wake?.(() => wakeUp?.());
  while (!stopping) {
    try {
      await fn();
      failures = 0;
    } catch (error) {
      failures += 1;
      log().error(`${name}_failed`, { error: (error as Error).message, failures });
    }
    const delay = failures ? Math.min(60_000, intervalMs * 2 ** Math.min(failures, 6)) : intervalMs;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeUp = null;
  }
  unsubscribe?.();
}

const loops: Promise<void>[] = [];
const enabled = networks().enabled();
if (!enabled.length) log().warn("no_networks_enabled", {});

for (const network of enabled) {
  const adapter = createAdapter(network);
  const ingestor = new ChainIngestor(adapter, { workerId, backfillSafetyBlocks: env.WORKER_BACKFILL_SAFETY_BLOCKS });
  log().info("chain_ingestion_started", {
    chain: network.key,
    chainId: network.chainId,
    settlement: network.settlement,
    settledLagBlocks: network.settledLagBlocks,
    intentContract: network.paymentIntent?.address ?? null
  });
  loops.push(
    loop(`ingestion_${network.key}`, env.WORKER_POLL_MS, async () => {
      const report = await ingestor.tick();
      if (report.settled?.activities || report.tip?.activities || report.backfill?.activities || report.settled?.dropped) log().info("ingestion_tick", { ...report });
    })
  );
  // Gas paid by monitored wallets for the transfers they sent (for the books).
  loops.push(loop(`network_fees_${network.key}`, 30_000, () => collectNetworkFees(adapter)));
}

loops.push(loop("webhook_delivery", 1000, () => deliverDueWebhooks()));
loops.push(loop("housekeeping", 60_000, () => runHousekeeping()));
loops.push(loop("recurring_bills", 10 * 60_000, () => runRecurringBills()));

log().info("worker_started", { workerId, networks: enabled.map((n) => n.key) });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    log().info("worker_stopping", { signal });
    stopping = true;
    await Promise.race([Promise.all(loops), sleep(15_000)]);
    await closePools();
    process.exit(0);
  });
}
