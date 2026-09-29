import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import pg from "pg";
import { networks, resetNetworks } from "../../config/src";
import { EvmAdapter } from "../../blockchain/src";
import { closePools, withSystem, withTenant } from "../../database/src";
import { syncNetworks } from "../../database/src/migrator";
import { startDevChain, type DevChain } from "../../devchain/src";
import {
  ChainIngestor,
  createCustomer,
  createInvoice,
  createOrganization,
  createUser,
  createWallet,
  executionStreams,
  executionWatchlist,
  ingestExecutionBatch,
  recordRefund,
  refundCandidates,
  type Actor,
  type ExecLogSignal,
  type ExecSignal
} from "../src";
import { resetLocalChainState } from "../../../test/fixtures";

/**
 * The execution-events path against a real EVM node (Anvil). Each signal is built from a real
 * transaction receipt in exactly the format the sidecar emits (services/execution-events), so the
 * Setra side is exercised end to end: provisional detection, business match, canonical settlement
 * through RPC, replay safety, speculative blocks that never finalize, gaps covered by RPC, bursts.
 * The sidecar's own reading of the event ring is validated separately against official snapshot data.
 */

let chain: DevChain;
let orgId: string;
let actor: Actor;
let merchant: Address;
let acmeCustomer: string;
const CHAIN = 31337;

const q = (sql: string, params: unknown[] = []) => withTenant(orgId, (c) => c.query(sql, params)).then((r) => r.rows);
const ingestor = () => new ChainIngestor(new EvmAdapter(networks().byKey("local")!), { workerId: "exec-test", backfillSafetyBlocks: 20, rescanBlocks: 10 });

/** What the sidecar emits for a real Transfer log (same fields, same types). */
async function signalFor(hash: Hex, overrides: Partial<ExecLogSignal> = {}): Promise<ExecLogSignal> {
  const receipt = await chain.publicClient.getTransactionReceipt({ hash });
  const block = await chain.publicClient.getBlock({ blockHash: receipt.blockHash });
  const l = receipt.logs.find((x) => x.address.toLowerCase() === chain.usdc)!;
  return {
    kind: "log",
    seqno: Number(receipt.blockNumber) * 1000 + l.logIndex!,
    chain_id: CHAIN,
    block_number: Number(receipt.blockNumber),
    block_id: `0x${Number(receipt.blockNumber).toString(16).padStart(64, "0")}`,
    block_hash: receipt.blockHash,
    block_timestamp: Number(block.timestamp),
    transaction_hash: hash,
    transaction_index: receipt.transactionIndex,
    log_index: l.logIndex!,
    address: l.address,
    topics: l.topics as string[],
    data: l.data,
    executed_at_ns: String(BigInt(Date.now() - 5) * 1_000_000n),
    emitted_at_ns: String(BigInt(Date.now()) * 1_000_000n),
    ...overrides
  };
}

const batch = (signals: ExecSignal[], stats: Record<string, number> = {}) => ingestExecutionBatch({ chain_id: CHAIN, sidecar_id: "test-sidecar", stats, signals });

async function invoice(title: string, amount: string) {
  return withTenant(orgId, (c) => createInvoice(c, orgId, "test", { customer_id: acmeCustomer, title, amount, currency: "USD", asset: "USDC", network: "local", metadata: {} }, actor));
}

beforeAll(async () => {
  chain = await startDevChain({ port: 9100 + Math.floor(Math.random() * 400) });
  process.env.LOCAL_CHAIN_ENABLED = "true";
  process.env.LOCAL_CHAIN_RPC_URL = chain.rpcUrl;
  process.env.LOCAL_USDC_ADDRESS = chain.usdc;
  process.env.LOCAL_PAYMENT_INTENT_ADDRESS = chain.intentContract;
  process.env.LOCAL_CHAIN_CONFIRMATIONS = "1";
  resetNetworks();
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  await syncNetworks(owner);
  await owner.end();
  await resetLocalChainState();
  await withSystem((c) => c.query("DELETE FROM execution_streams WHERE chain_id = $1", [CHAIN]));

  const user = await createUser({ email: `exec+${Date.now()}@acme.test`, name: "Exec Tester", password: "correct horse battery" });
  const org = await createOrganization({ name: "Execution Events Co", ownerUserId: user.id });
  orgId = org.id;
  actor = { type: "user", id: user.id };
  merchant = chain.accounts[4]!.address.toLowerCase() as Address;
  await withTenant(orgId, async (c) => {
    await createWallet(c, orgId, "test", { name: "Main", network: "local", address: merchant, assets: ["USDC"] }, actor);
    acmeCustomer = (await createCustomer(c, orgId, "test", { name: "Acme Ltd", metadata: {}, wallet_addresses: [{ address: chain.accounts[1]!.address.toLowerCase() as Address, network: "local" }] }, actor)).id;
  });
  await chain.mine(3);
  await ingestor().tick(); // activates the wallet
}, 120_000);

afterAll(async () => {
  chain?.stop();
  await closePools();
});

describe("execution events → Setra", () => {
  it("serves the watchlist the sidecar filters on", async () => {
    const w = await executionWatchlist(CHAIN);
    expect(w.tokens).toContain(chain.usdc);
    expect(w.recipients).toContain(merchant);
    expect(w.intent_contracts).toEqual([chain.intentContract]);
    expect(w.intent_topics).toHaveLength(2);
  });

  it("detects a payment at execution, identifies customer and purpose provisionally, and settles only via canonical RPC", async () => {
    const inv = await invoice("September Infrastructure Services", "20.00");
    const tx = await chain.transferUsdc(1, merchant, 20_000_000n);
    const signal = await signalFor(tx);

    const handedOver = Date.now();
    const report = await batch([signal], { events_consumed: 1200, events_relevant: 1, payment_signals: 1 });
    expect(report.observations).toBe(1);
    // Observation and provisional business match are written in one transaction; measure to commit.
    const committedMs = Date.now() - handedOver;
    console.log(`execution-events ingest (local Postgres): signal → committed observation with customer and purpose identified in ${committedMs} ms`);
    expect(committedMs).toBeLessThan(1000);
    const [obs] = await q("SELECT * FROM source_observations WHERE transaction_hash = $1", [tx]);
    expect(obs).toMatchObject({ detection_source: "execution_events", confirmation_state: "observed" });
    expect(obs.executed_at).not.toBeNull();
    const [payment] = await q("SELECT * FROM payments WHERE transaction_hash = $1", [tx]);
    expect(payment).toMatchObject({ status: "confirming", provisional_invoice_id: inv.id, invoice_id: null });
    // Detected is not paid: nothing economic has happened yet.
    expect((await q("SELECT status, amount_paid FROM invoices WHERE id = $1", [inv.id]))[0]).toMatchObject({ status: "open", amount_paid: "0" });
    expect(await q("SELECT count(*)::int AS n FROM allocations WHERE payment_id = $1", [payment.id])).toEqual([{ n: 0 }]);

    // Canonical confirmation through the RPC path.
    await chain.mine(2);
    await ingestor().tick();
    await ingestor().tick();
    const [settled] = await q("SELECT * FROM payments WHERE id = $1", [payment.id]);
    expect(settled).toMatchObject({ status: "matched", invoice_id: inv.id, context_source: "automatic_match" });
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");
    const [final] = await q("SELECT * FROM source_observations WHERE id = $1", [obs.id]);
    expect(final).toMatchObject({ confirmation_state: "finalized", detection_source: "execution_events" });
    const sightings = await q("SELECT source, stage FROM observation_sightings WHERE observation_id = $1 ORDER BY seen_at", [obs.id]);
    expect(sightings[0]).toEqual({ source: "execution_events", stage: "tip" });
    expect(sightings).toContainEqual({ source: "rpc", stage: "settled" });
    const events = (await q("SELECT type FROM financial_events WHERE payment_id = $1 ORDER BY id", [payment.id])).map((r) => r.type);
    expect(events).toEqual(["PAYMENT_OBSERVED", "PAYMENT_MATCHED"]);
  }, 60_000);

  it("the same signal delivered again (sidecar retry or restart) has no effect", async () => {
    const inv = await invoice("Replay check", "21.00");
    const tx = await chain.transferUsdc(1, merchant, 21_000_000n);
    const signal = await signalFor(tx);
    expect((await batch([signal])).observations).toBe(1);
    for (let i = 0; i < 3; i++) expect((await batch([signal])).observations).toBe(1); // existing observation, reported, never duplicated
    expect(await q("SELECT count(*)::int AS n FROM payments WHERE transaction_hash = $1", [tx])).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM source_observations WHERE transaction_hash = $1", [tx])).toEqual([{ n: 1 }]);
    await chain.mine(2);
    await ingestor().tick();
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");
  }, 60_000);

  it("a log from a speculatively executed block that never finalizes is dropped, with no economic effect", async () => {
    const inv = await invoice("Speculative block", "22.00");
    const tx = await chain.transferUsdc(1, merchant, 22_000_000n);
    const real = await signalFor(tx);
    // Same transaction executed in a proposal that lost: different block hash, never canonical.
    const ghost = { ...real, block_hash: `0x${"ab".repeat(32)}`, block_id: `0x${"cd".repeat(32)}` };
    await batch([ghost]);
    const ghostObs = (await q("SELECT * FROM source_observations WHERE block_hash = $1", [ghost.block_hash]))[0];
    expect(ghostObs.detection_source).toBe("execution_events");
    await chain.mine(2);
    await ingestor().tick();
    await ingestor().tick();
    const after = (await q("SELECT * FROM source_observations WHERE id = $1", [ghostObs.id]))[0];
    expect(after.canonical).toBe(false);
    const ghostPayment = (await q("SELECT * FROM payments WHERE observation_id = $1", [ghostObs.id]))[0];
    expect(ghostPayment.status).toBe("reversed");
    expect(await q("SELECT COALESCE(sum(amount),0)::text AS s FROM allocations WHERE payment_id = $1", [ghostPayment.id])).toEqual([{ s: "0" }]);
    // The canonical transaction (seen by RPC) is what paid the invoice, exactly once.
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");
    expect(await q("SELECT count(*)::int AS n FROM payments WHERE transaction_hash = $1 AND status = 'matched'", [tx])).toEqual([{ n: 1 }]);
  }, 60_000);

  it("a gap marks the stream incomplete; a payment inside the gap is still caught by RPC; the stream recovers", async () => {
    const before = await chain.publicClient.getBlockNumber({ cacheTime: 0 });
    await batch([{ kind: "gap", reason: "sequence_gap", chain_id: CHAIN, last_complete_block: Number(before), last_seqno: 100 }], { last_block_number: Number(before) + 3, gaps: 1 });
    let stream = (await executionStreams()).find((s) => s.chain_id === CHAIN)!;
    expect(stream.status).toBe("recovering");
    expect(stream.incomplete_range).toMatchObject({ from_block: String(Number(before) + 1), covered_by_rpc: false });

    // A payment the sidecar never reported (it happened during the gap).
    const inv = await invoice("Paid during the gap", "23.00");
    const tx = await chain.transferUsdc(1, merchant, 23_000_000n);
    await chain.mine(5);
    await ingestor().tick();
    await ingestor().tick();
    const [p] = await q("SELECT p.status, o.detection_source FROM payments p JOIN source_observations o ON o.id = p.observation_id WHERE p.transaction_hash = $1", [tx]);
    expect(p).toEqual({ status: "matched", detection_source: "rpc" });
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");

    await batch([], { last_block_number: Number(await chain.publicClient.getBlockNumber({ cacheTime: 0 })) }); // heartbeat
    stream = (await executionStreams()).find((s) => s.chain_id === CHAIN)!;
    expect(stream.status).toBe("live");
    expect(stream.incomplete_range?.covered_by_rpc).toBe(true);
    expect(stream.gaps).toBe("1");
  }, 60_000);

  it("a burst of payments in one delivery is processed once each", async () => {
    const txs: Hex[] = [];
    for (let i = 0; i < 25; i++) txs.push(await chain.transferUsdc(1, merchant, BigInt(30_000_000 + i)));
    const signals = await Promise.all(txs.map((t) => signalFor(t)));
    const report = await batch(signals);
    expect(report.observations).toBe(25);
    expect((await batch(signals)).observations).toBe(25); // replayed burst: still 25 observations total
    expect(await q("SELECT count(*)::int AS n FROM payments WHERE transaction_hash = ANY($1)", [txs])).toEqual([{ n: 25 }]);
    await chain.mine(2);
    await ingestor().tick();
    await ingestor().tick();
    expect(await q("SELECT count(*)::int AS n FROM payments WHERE transaction_hash = ANY($1) AND status <> 'confirming'", [txs])).toEqual([{ n: 25 }]);
  }, 120_000);

  it("ignores logs for wallets nobody monitors and refuses the wrong chain", async () => {
    const stranger = "0x00000000000000000000000000000000000c0ffe" as Address;
    const tx = await chain.transferUsdc(1, stranger, 1_000_000n);
    expect((await batch([await signalFor(tx)])).observations).toBe(0);
    await expect(ingestExecutionBatch({ chain_id: 1, sidecar_id: "x", signals: [] })).rejects.toThrow(/not monitored/);
    const s = await signalFor(tx);
    await expect(batch([{ ...s, chain_id: 143 }])).rejects.toThrow(/chain 143/);
  }, 60_000);
});

describe("refunds on a real chain", () => {
  it("records the merchant's refund transfer from finalized blocks and links it to the duplicate it returns", async () => {
    const inv = await invoice("Refund check", "41.00");
    const customer = chain.accounts[1]!.address.toLowerCase() as Address;
    await chain.transferUsdc(1, merchant, 41_000_000n); // pays the invoice
    const dupTx = await chain.transferUsdc(1, merchant, 41_000_000n); // pays it again
    await chain.mine(2);
    await ingestor().tick();
    await ingestor().tick();
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");
    const [dup] = await q("SELECT * FROM payments WHERE transaction_hash = $1", [dupTx]);
    expect(dup.status).toBe("needs_review");

    // The merchant sends the duplicate back from the receiving wallet: a real outgoing transfer.
    const refundTx = await chain.transferUsdc(4, customer, 41_000_000n);
    await chain.mine(2);
    await ingestor().tick();
    await ingestor().tick();
    const [out] = await q("SELECT * FROM outgoing_transfers WHERE transaction_hash = $1", [refundTx]);
    expect(out).toMatchObject({ to_address: customer, amount: "41000000", canonical: true });

    const candidates = await withTenant(orgId, (c) => refundCandidates(c, dup.id));
    expect(candidates[0].id).toBe(out.id);
    const result = await withTenant(orgId, (c) => recordRefund(c, orgId, dup.id, { outgoing_transfer_id: out.id, reason: "Duplicate returned" }, actor));
    expect(result.paymentStatus).toBe("refunded");
    const types = (await q("SELECT type FROM financial_events WHERE payment_id = $1 ORDER BY id", [dup.id])).map((r) => r.type);
    expect(types).toContain("REFUND_OBSERVED");
    // Ingesting the same blocks again records nothing twice.
    await withSystem((c) => c.query("UPDATE chain_cursors SET block_number = block_number - 6 WHERE chain_id = $1 AND stage = 'settled'", [CHAIN]));
    await ingestor().tick();
    expect(await q("SELECT count(*)::int AS n FROM outgoing_transfers WHERE transaction_hash = $1", [refundTx])).toEqual([{ n: 1 }]);
  }, 90_000);
});
