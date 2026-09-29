import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import pg from "pg";
import { networks, resetNetworks } from "../../config/src";
import { EvmAdapter } from "../../blockchain/src";
import { closePools, withSystem, withTenant } from "../../database/src";
import { syncNetworks } from "../../database/src/migrator";
import { startDevChain, type DevChain } from "../../devchain/src";
import { resetLocalChainState } from "../../../test/fixtures";
import { ChainIngestor, createCustomer, createInvoice, createOrganization, createUser, createWallet, type Actor } from "../src";

/**
 * Infrastructure failure injection. A proxy sits between the ingestor and a real EVM node and can
 * return HTTP 500s, rate limits, garbage, slow responses, or behave like a lagging load-balanced node
 * that returns empty logs. Principle under test: when uncertain, Setra fails conservatively: it never
 * advances past data it didn't see and never marks anything paid because a dependency failed.
 */

type Mode = "ok" | "http500" | "rate_limited" | "garbage" | "slow" | "empty_logs";
let mode: Mode = "ok";
let chain: DevChain;
let proxy: Server;
let proxyUrl: string;
let orgId: string;
let actor: Actor;
let merchant: Address;
let customerId: string;

const q = (sql: string, params: unknown[] = []) => withTenant(orgId, (c) => c.query(sql, params)).then((r) => r.rows);
const cursor = async () => (await withSystem((c) => c.query("SELECT block_number, last_error FROM chain_cursors WHERE chain_id = 31337 AND stage = 'settled'"))).rows[0];
const ingestor = () => new ChainIngestor(new EvmAdapter({ ...networks().byKey("local")!, rpcUrl: proxyUrl }), { workerId: "fault-test", backfillSafetyBlocks: 20, rescanBlocks: 10 });

beforeAll(async () => {
  chain = await startDevChain({ port: 8900 + Math.floor(Math.random() * 90) });
  proxy = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (mode === "http500") return res.writeHead(500).end("upstream exploded");
      if (mode === "rate_limited") return res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } }));
      if (mode === "garbage") return res.writeHead(200, { "content-type": "application/json" }).end("{not json");
      const parsed = JSON.parse(body);
      if (mode === "empty_logs" && parsed.method === "eth_getLogs") {
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: [] }));
      }
      if (mode === "slow") await new Promise((r) => setTimeout(r, 1500));
      const upstream = await fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.writeHead(upstream.status, { "content-type": "application/json" }).end(await upstream.text());
    });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

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

  const user = await createUser({ email: `faults+${Date.now()}@acme.test`, name: "Fault Tester", password: "correct horse battery" });
  const org = await createOrganization({ name: "Fault Injection Co", ownerUserId: user.id });
  orgId = org.id;
  actor = { type: "user", id: user.id };
  merchant = chain.accounts[4]!.address.toLowerCase() as Address;
  await withTenant(orgId, async (c) => {
    await createWallet(c, orgId, "test", { name: "Main", network: "local", address: merchant, assets: ["USDC"] }, actor);
    customerId = (await createCustomer(c, orgId, "test", { name: "Acme Ltd", metadata: {}, wallet_addresses: [{ address: chain.accounts[1]!.address.toLowerCase() as Address, network: "local" }] }, actor)).id;
  });
  await chain.mine(3);
  await ingestor().tick();
}, 120_000);

afterAll(async () => {
  proxy?.close();
  chain?.stop();
  await closePools();
});

async function newInvoice(amount: string) {
  return withTenant(orgId, (c) => createInvoice(c, orgId, "test", { customer_id: customerId, amount, title: "Hosting", currency: "USD", asset: "USDC", network: "local", metadata: {} }, actor));
}

describe("RPC failures fail conservatively", () => {
  for (const failure of ["http500", "rate_limited", "garbage"] as const) {
    it(`${failure}: the tick fails, the cursor does not move, nothing is marked paid, then it recovers`, async () => {
      const inv = await newInvoice(failure === "http500" ? "12.00" : failure === "rate_limited" ? "13.00" : "14.00");
      const before = await cursor();
      await chain.transferUsdc(1, merchant, BigInt(Math.round(Number(inv.amount_due))));
      await chain.mine(2);
      mode = failure;
      await expect(ingestor().tick()).rejects.toThrow();
      const during = await cursor();
      expect(during.block_number).toBe(before.block_number);
      expect(during.last_error).toBeTruthy();
      expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("open");

      mode = "ok";
      await ingestor().tick();
      await chain.mine(1);
      await ingestor().tick();
      expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");
      expect((await cursor()).last_error).toBeNull();
    }, 60_000);
  }

  it("slow responses are tolerated without skipping blocks", async () => {
    const inv = await newInvoice("15.00");
    await chain.transferUsdc(1, merchant, 15_000_000n);
    await chain.mine(2);
    mode = "slow";
    await ingestor().tick();
    mode = "ok";
    await ingestor().tick();
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");
  }, 60_000);

  it("a lagging node that returns empty logs doesn't lose the payment: the trailing rescan recovers it", async () => {
    const inv = await newInvoice("16.00");
    await chain.transferUsdc(1, merchant, 16_000_000n);
    await chain.mine(2);
    mode = "empty_logs";
    await ingestor().tick(); // cursor advances past the payment block, having "seen" nothing
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("open");
    mode = "ok";
    await chain.mine(1);
    await ingestor().tick(); // the trailing window re-reads the missed blocks
    expect((await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status).toBe("paid");
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE amount = 16000000"))[0].n).toBe(1);
  }, 60_000);

  it("a worker killed mid-stream resumes from the committed cursor with no gaps and no duplicates", async () => {
    const a = await newInvoice("17.00");
    const b = await newInvoice("18.00");
    await chain.transferUsdc(1, merchant, 17_000_000n);
    await chain.mine(1);
    await ingestor().tick();
    // A "crash": a fresh ingestor instance with a different worker id, with the lease possibly still held.
    await withSystem((c) => c.query("UPDATE chain_cursors SET lease_owner = 'dead-worker', lease_expires_at = now() - interval '1 second' WHERE chain_id = 31337 AND stage = 'settled'"));
    await chain.transferUsdc(1, merchant, 18_000_000n);
    await chain.mine(2);
    const restarted = new ChainIngestor(new EvmAdapter({ ...networks().byKey("local")!, rpcUrl: proxyUrl }), { workerId: "restarted", rescanBlocks: 10 });
    await restarted.tick();
    await restarted.tick();
    expect((await q("SELECT status FROM invoices WHERE id = ANY($1) ORDER BY number", [[a.id, b.id]])).map((r) => r.status)).toEqual(["paid", "paid"]);
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE amount IN (17000000, 18000000)"))[0].n).toBe(2);
  }, 60_000);

  it("a live lease held by another worker is respected (no double ingestion)", async () => {
    await withSystem((c) => c.query("UPDATE chain_cursors SET lease_owner = 'other-worker', lease_expires_at = now() + interval '30 seconds' WHERE chain_id = 31337 AND stage = 'settled'"));
    const report = await ingestor().tick();
    expect(report.skipped).toBe("lease_held_elsewhere");
    await withSystem((c) => c.query("UPDATE chain_cursors SET lease_owner = NULL, lease_expires_at = NULL WHERE chain_id = 31337 AND stage = 'settled'"));
  });
});
