import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePools, withTenant } from "../../../packages/database/src";
import { recordOutgoingTransfer } from "../../../packages/engine/src";
import { call, randomAddress, server, setupWorkspace, signup, type Session } from "./helpers";

/**
 * Counterparty intelligence (Nansen) across Setra: who is behind an unknown sender, which known
 * customers it has dealt with, who received money going out, whether an address is safe to save, and
 * Seti's answer to "who sent this?". Always advice for a person, never a match.
 */

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const auth = (s: Session) => ({ cookie: s.cookie });
const hex32 = () => `0x${randomBytes(32).toString("hex")}`;

type Reply = { labels?: Array<{ label: string; category: string; kind: string[] }>; counterparties?: Array<{ address: string; interactions: number }>; status?: number };

/** Run with a fake Nansen that answers labels and counterparties per address, counting calls by endpoint. */
async function withNansen<T>(answers: Record<string, Reply>, fn: (calls: { labels: number; counterparties: number }) => Promise<T>): Promise<T> {
  const savedKey = process.env.NANSEN_API_KEY;
  process.env.NANSEN_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const calls = { labels: 0, counterparties: 0 };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("api.nansen.ai")) return realFetch(url as never, init);
    const body = JSON.parse(String(init?.body));
    expect(body.chain).toBe("monad");
    const answer = answers[String(body.address).toLowerCase()];
    if (u.endsWith("/profiler/address/labels")) {
      calls.labels += 1;
      if (answer?.status) return new Response("{}", { status: answer.status });
      if (!answer?.labels) return new Response("{}", { status: 404 });
      return Response.json({ pagination: { page: 1, per_page: 50, is_last_page: true }, data: answer.labels });
    }
    if (u.endsWith("/profiler/address/counterparties")) {
      calls.counterparties += 1;
      expect(body.date?.from && body.date?.to).toBeTruthy();
      return Response.json({
        pagination: { page: 1, per_page: 100, is_last_page: true },
        data: (answer?.counterparties ?? []).map((c) => ({ counterparty_address: c.address, counterparty_address_label: [], interaction_count: c.interactions, total_volume_usd: 1000 }))
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.NANSEN_API_KEY;
    else process.env.NANSEN_API_KEY = savedKey;
  }
}

const enable = (s: Session) => call("PATCH", "/v1/organization", auth(s), { counterparty_intel_enabled: true });
const unknownFrom = async (s: Session, from: string, amount = "740.00") => (await call("POST", "/v1/test/payments", auth(s), { scenario: "unknown", amount, from_address: from })).data;

describe("who is behind an unknown sender", () => {
  it("names the known customer the wallet has dealt with, and never another workspace's customer", async () => {
    const s = await signup();
    const { acme, acmeAddress } = await setupWorkspace(s);
    await enable(s);
    // Another workspace saved the same kind of relationship: its customer must never appear here.
    const other = await signup("Other Co");
    const otherWallet = randomAddress();
    await call("POST", "/v1/customers", auth(other), { name: "Their Customer", wallet_addresses: [{ address: otherWallet, network: "monad" }] });

    const sender = randomAddress();
    const unknown = await unknownFrom(s, sender);
    await withNansen(
      { [sender]: { labels: [], counterparties: [{ address: acmeAddress, interactions: 3 }, { address: otherWallet, interactions: 9 }, { address: randomAddress(), interactions: 20 }] } },
      async (calls) => {
        const first = (await call("GET", `/v1/payments/${unknown.id}/counterparty`, auth(s))).data;
        expect(first).toMatchObject({ status: "none", kind: "unknown" });
        expect(first.related_customers).toEqual([{ customer_id: acme.id, customer_name: "Acme Ltd", wallet: acmeAddress.toLowerCase(), interactions: 3, volume_usd: 1000 }]);
        expect(first.related_lookback_days).toBe(365);
        // Cached: a second look doesn't spend another lookup.
        await call("GET", `/v1/payments/${unknown.id}/counterparty`, auth(s));
        expect(calls).toEqual({ labels: 1, counterparties: 1 });
      }
    );
    // Nothing was assigned or classified from the suggestion.
    expect((await call("GET", `/v1/payments/${unknown.id}`, auth(s))).data).toMatchObject({ status: "needs_review", customer: null });
  });

  it("asks Nansen nothing while lookups are off for the workspace", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const sender = randomAddress();
    const unknown = await unknownFrom(s, sender);
    await withNansen({ [sender]: { labels: [], counterparties: [] } }, async (calls) => {
      expect((await call("GET", `/v1/payments/${unknown.id}/counterparty`, auth(s))).data).toMatchObject({ status: "disabled", related_customers: [] });
      expect((await call("GET", `/v1/counterparty/address?address=${sender}&network=monad`, auth(s))).data).toMatchObject({ status: "disabled", shared: false });
      expect(calls).toEqual({ labels: 0, counterparties: 0 });
    });
  });
});

describe("spending Nansen credits carefully", () => {
  it("background checks read only past lookups, and an empty account is explained, not retried on every visit", async () => {
    const s = await signup();
    await setupWorkspace(s);
    await enable(s);
    const sender = randomAddress();
    const broke = randomAddress();
    const unknown = await unknownFrom(s, sender);
    const other = await unknownFrom(s, broke, "12.00");
    await withNansen({ [sender]: { labels: [{ label: "Binance: Deposit", category: "cex", kind: ["exchange"] }] }, [broke]: { status: 403 } }, async (calls) => {
      // A page load before anyone asked: nothing is spent.
      expect((await call("GET", `/v1/payments/${unknown.id}/counterparty?cached_only=true`, auth(s))).data).toMatchObject({ status: "not_looked_up" });
      expect(calls.labels).toBe(0);
      // Someone clicks "Look up sender"; afterwards the background check sees the answer for free.
      await call("GET", `/v1/payments/${unknown.id}/counterparty`, auth(s));
      expect((await call("GET", `/v1/payments/${unknown.id}/counterparty?cached_only=true`, auth(s))).data).toMatchObject({ status: "ok", kind: "exchange" });
      expect(calls.labels).toBe(1);

      const failed = (await call("GET", `/v1/payments/${other.id}/counterparty`, auth(s))).data;
      expect(failed.status).toBe("error");
      expect(failed.message).toMatch(/out of credits/);
      await call("GET", `/v1/payments/${other.id}/counterparty`, auth(s));
      expect(calls.labels).toBe(2);
    });
  });
});

describe("checking an address before saving it", () => {
  it("warns about shared addresses, stays quiet for private wallets, and refuses garbage", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const exchange = randomAddress();
    const person = randomAddress();
    const check = async (address: string) => (await call("GET", `/v1/counterparty/address?address=${address}&network=monad`, auth(s))).data;
    expect((await check(exchange)).status).toBe("disabled");
    await enable(s);
    await withNansen({ [exchange]: { labels: [{ label: "Binance: Hot Wallet", category: "cex", kind: ["entity"] }] } }, async () => {
      const ex = await check(exchange);
      expect(ex).toMatchObject({ kind: "exchange", shared: true });
      expect(ex.warning).toMatch(/^Labelled Binance: Hot Wallet\. Many people pay from or into it/);
      const priv = await check(person);
      expect(priv).toMatchObject({ kind: "unknown", shared: false, warning: null });
    });
    expect((await call("GET", "/v1/counterparty/address?address=0x123&network=monad", auth(s))).statusCode).toBe(422);
  });
});

describe("money going out", () => {
  it("explains who received a transfer, with advice for classifying it", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    await enable(s);
    const inv = (await call("POST", "/v1/invoices", auth(s), { customer_id: acme.id, title: "Work", amount: "100.00" })).data;
    const paid = (await call("POST", "/v1/test/payments", auth(s), { scenario: "exact", invoice_id: inv.id })).data;
    const exchange = randomAddress();
    const id = await withTenant(s.orgId, async (c) => {
      const w = (await c.query("SELECT id, organization_id, environment FROM wallets WHERE id = $1", [paid.wallet.id])).rows[0];
      return recordOutgoingTransfer(c, w, {
        chainId: paid.chain_id,
        blockNumber: BigInt(paid.block_number) + 5n,
        blockHash: hex32(),
        transactionHash: hex32(),
        transactionIndex: 0,
        logIndex: 0,
        tokenAddress: paid.asset.address,
        toAddress: exchange,
        amount: 40_000_000n,
        blockTimestamp: new Date()
      });
    });
    await withNansen({ [exchange]: { labels: [{ label: "Coinbase: Deposit", category: "cex", kind: ["entity"] }] } }, async () => {
      const out = (await call("GET", `/v1/outgoing-transfers/${id}/counterparty`, auth(s))).data;
      expect(out).toMatchObject({ status: "ok", kind: "exchange", to_address: exchange.toLowerCase() });
      expect(out.summary).toMatch(/Sent to an exchange wallet/);
      expect(out.suggestion).toMatch(/transfer between your own accounts/);
    });
    // Another workspace can't look at it.
    const other = await signup("Other Co");
    expect((await call("GET", `/v1/outgoing-transfers/${id}/counterparty`, auth(other))).statusCode).toBe(404);
  });
});

describe("asking Seti who sent a payment", () => {
  const ask = async (s: Session, text: string) => (await call("POST", "/v1/assistant/messages", auth(s), { text, timezone: "Africa/Lagos" })).data;
  const texts = (r: any) => r.message.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");

  it("answers in plain words with the likely customer, and keeps the decision with the person", async () => {
    const s = await signup();
    const { acmeAddress } = await setupWorkspace(s);
    await enable(s);
    const sender = randomAddress();
    const unknown = await unknownFrom(s, sender);
    await withNansen({ [sender]: { labels: [{ label: "Binance: Hot Wallet", category: "cex", kind: ["entity"] }], counterparties: [{ address: acmeAddress, interactions: 3 }] } }, async () => {
      const r = await ask(s, "who sent the $740?");
      const said = texts(r);
      expect(said).toMatch(/^The 740\.00 USDC came from 0x/);
      expect(said).toMatch(/exchange wallet/);
      expect(said).toMatch(/Acme Ltd's saved wallet 3 times, so I'd start with Acme Ltd's open invoices/);
      expect(said).toMatch(/not a match, so the decision is yours/);
      expect(r.message.blocks.find((b: any) => b.type === "payment").payment.id).toBe(unknown.id);
    });
    expect((await call("GET", `/v1/payments/${unknown.id}`, auth(s))).data.status).toBe("needs_review");
  });

  it("says when lookups are off, and when there's nothing to explain", async () => {
    const s = await signup();
    await setupWorkspace(s);
    expect(texts(await ask(s, "who sent the 740?"))).toMatch(/no unidentified payment right now|don't see an unidentified payment of \$740\.00/);
    await unknownFrom(s, randomAddress());
    const off = await ask(s, "who sent the $740?");
    expect(off.message.blocks[0]).toMatchObject({ type: "notice", title: expect.stringMatching(/counterparty lookups are off/) });
    expect(texts(await ask(s, "who sent the $12?"))).toMatch(/don't see an unidentified payment of \$12\.00/);
  });
});
