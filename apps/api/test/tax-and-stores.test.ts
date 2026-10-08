import { createHmac, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePools } from "../../../packages/database/src";
import { apiKey, call, server, setupWorkspace, signup, type Session } from "./helpers";

/**
 * Sales tax inside invoice totals goes to Taxes Payable, never revenue, in both cash and accrual books.
 * Stores (Shopify, WooCommerce) pass their tax through, and orders they settle some other way close in
 * Setra unless a stablecoin payment already arrived.
 */

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const auth = (s: Session) => ({ cookie: s.cookie });
const balance = async (s: Session, code: string) => {
  const tb = (await call("GET", "/v1/accounting/reports/trial-balance", auth(s))).data;
  const row = tb.accounts.find((a: any) => a.code === code);
  return { credit: row?.credit_balance ?? "0.00", debit: row?.debit_balance ?? "0.00", balanced: tb.totals.balanced };
};
const pay = (s: Session, body: Record<string, unknown>) => call("POST", "/v1/test/payments", auth(s), body).then((r) => r.data);

describe("sales tax", () => {
  it("accrual: the invoice books tax to Taxes Payable and only the rest to revenue", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const inv = (await call("POST", "/v1/invoices", auth(s), { customer_id: acme.id, title: "Hoodies", amount: "107.25", tax: "7.25" })).data;
    expect(inv.tax_amount).toBe("7.25");
    expect(await balance(s, "4000")).toMatchObject({ credit: "100.00", balanced: true });
    expect((await balance(s, "2200")).credit).toBe("7.25");
    expect((await balance(s, "1100")).debit).toBe("107.25");
    await pay(s, { scenario: "exact", invoice_id: inv.id });
    expect((await balance(s, "1100")).debit).toBe("0.00");
    expect((await balance(s, "2200")).credit).toBe("7.25");
    const pl = (await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s))).data;
    expect(pl.revenue.total).toBe("100.00");
  });

  it("cash: each payment carries its share of the tax, and partial payments add up exactly", async () => {
    const s = await signup();
    expect((await call("PATCH", "/v1/accounting/settings", auth(s), { method: "cash" })).statusCode).toBe(200);
    const { acme, acmeAddress } = await setupWorkspace(s);
    const inv = (await call("POST", "/v1/invoices", auth(s), { customer_id: acme.id, title: "Consulting", amount: "100.00", tax: "7.25" })).data;
    for (const amount of ["33.33", "33.33", "33.34"]) await pay(s, { scenario: "partial", invoice_id: inv.id, amount, from_address: acmeAddress });
    expect((await call("GET", `/v1/invoices/${inv.id}`, auth(s))).data.status).toBe("paid");
    expect(await balance(s, "2200")).toMatchObject({ credit: "7.25", balanced: true });
    expect((await balance(s, "4000")).credit).toBe("92.75");
  });

  it("refuses tax larger than the total", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const r = await call("POST", "/v1/invoices", auth(s), { customer_id: acme.id, title: "x", amount: "10.00", tax: "11.00" });
    expect(r.statusCode).toBe(422);
  });
});

/** Post a raw body exactly as a store would, so the signature covers the same bytes. */
const inbound = async (url: string, raw: string, headers: Record<string, string>) => {
  const res = await (await server()).inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: raw });
  return { statusCode: res.statusCode, data: res.json() };
};
const shopify = (secret: string, url: string, topic: string, body: object, id = randomBytes(6).toString("hex")) => {
  const raw = JSON.stringify(body);
  return inbound(url, raw, { "x-shopify-topic": topic, "x-shopify-webhook-id": id, "x-shopify-hmac-sha256": createHmac("sha256", secret).update(raw).digest("base64") });
};
const woo = (secret: string, url: string, topic: string, body: object, id = randomBytes(6).toString("hex")) => {
  const raw = JSON.stringify(body);
  return inbound(url, raw, { "x-wc-webhook-topic": topic, "x-wc-webhook-delivery-id": id, "x-wc-webhook-signature": createHmac("sha256", secret).update(raw).digest("base64") });
};
const path = (url: string) => url.replace(/^https?:\/\/[^/]+\/api/, "");
const order = async (s: Session, externalId: string) => (await call("GET", `/v1/orders/${encodeURIComponent(externalId)}`, { key: await apiKey(s) })).data;

describe("stores", () => {
  it("Shopify: tax passes through, and an order Shopify marks paid closes unless a stablecoin payment arrived", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const secret = `shpss_${randomBytes(16).toString("hex")}`;
    const src = (await call("POST", "/v1/order-sources", auth(s), { kind: "shopify", name: "Store", secret })).data;
    const url = path(src.inbound_url);
    const base = { currency: "USD", financial_status: "pending", customer: { id: 9, first_name: "Kofi", email: "kofi@example.com" } };

    expect((await shopify(secret, url, "orders/create", { ...base, id: 501, name: "#1501", total_price: "53.50", total_tax: "3.50" })).data.outcome).toBe("created");
    expect((await order(s, "shopify:501")).invoice.tax_amount).toBe("3.50");

    // Paid by card in Shopify: nothing arrived in stablecoins, so Setra stops expecting it.
    const closed = (await shopify(secret, url, "orders/updated", { ...base, id: 501, name: "#1501", total_price: "53.50", financial_status: "paid" })).data;
    expect(closed.outcome).toBe("cancelled");

    // Paid in USDC first, then marked paid in Shopify: Setra keeps its record.
    await shopify(secret, url, "orders/create", { ...base, id: 502, name: "#1502", total_price: "20.00" });
    const inv = (await order(s, "shopify:502")).invoice;
    await pay(s, { scenario: "exact", invoice_id: inv.id });
    const kept = (await shopify(secret, url, "orders/updated", { ...base, id: 502, name: "#1502", total_price: "20.00", financial_status: "paid" })).data;
    expect(kept.outcome).toBe("unchanged");
    expect((await order(s, "shopify:502")).invoice.status).toBe("paid");
  });

  it("WooCommerce: answers the connection check, verifies signatures, and follows order status", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const src = (await call("POST", "/v1/order-sources", auth(s), { kind: "woocommerce", name: "WP store" })).data;
    expect(src.secret).toMatch(/^osec_/);
    const url = path(src.inbound_url);

    const ping = await inbound(url, "webhook_id=12", { "content-type": "application/x-www-form-urlencoded" });
    expect(ping.statusCode).toBe(200);

    const body = { id: 88, number: "88", status: "on-hold", currency: "USD", total: "64.20", total_tax: "4.20", customer_id: 3, billing: { first_name: "Ada", last_name: "Obi", email: "ada@example.com" }, line_items: [{ name: "Mug", quantity: 2 }] };
    expect((await woo("wrong-secret", url, "order.created", body)).statusCode).toBe(401);
    const created = await woo(src.secret, url, "order.created", body, "d-1");
    expect(created.data.outcome).toBe("created");
    expect((await woo(src.secret, url, "order.created", body, "d-1")).data.duplicate).toBe(true);
    const o = await order(s, "woo:88");
    expect(o.invoice).toMatchObject({ amount_due: "64.20", tax_amount: "4.20", number: "WC-88" });

    expect((await woo(src.secret, url, "order.updated", { ...body, status: "processing" })).data.outcome).toBe("cancelled");
  });
});

describe("books against the chain", () => {
  it("compares each wallet with its real balance, leaving out simulated test payments", async () => {
    const { setBalanceReader } = await import("../../../packages/engine/src");
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const inv = (await call("POST", "/v1/invoices", auth(s), { customer_id: acme.id, title: "Work", amount: "50.00" })).data;
    await pay(s, { scenario: "exact", invoice_id: inv.id });
    const check = async () => (await call("GET", "/v1/accounting/health", auth(s))).data.checks.find((c: any) => String(c.key).startsWith("onchain:"));
    try {
      // The only money in the wallet was simulated, so an empty wallet on chain agrees with the books.
      setBalanceReader(async () => ({ balance: 0n, blockNumber: 1234n }));
      expect(await check()).toMatchObject({ status: "ok" });
      // Money on chain the books don't know about, mixed with simulated payments: said, not flagged.
      setBalanceReader(async () => ({ balance: 5_000_000n, blockNumber: 1235n }));
      expect(await check()).toMatchObject({ status: "not_checked" });
      // The chain can't be reached: it says so instead of guessing.
      setBalanceReader(async () => null);
      expect(await check()).toMatchObject({ status: "not_checked", detail: expect.stringMatching(/Couldn't read/) });
    } finally {
      setBalanceReader(null);
    }
  });

  it("flags a real difference with both numbers", async () => {
    const { setBalanceReader, recordOutgoingTransfer } = await import("../../../packages/engine/src");
    const { networks } = await import("../../../packages/config/src");
    const { withTenant } = await import("../../../packages/database/src");
    const s = await signup();
    await setupWorkspace(s);
    // 2 USDC really left the wallet on chain (no simulated money involved).
    await withTenant(s.orgId, async (c) => {
      const w = (await c.query("SELECT id, organization_id, environment, chain_id FROM wallets WHERE organization_id = $1 LIMIT 1", [s.orgId])).rows[0];
      const usdc = networks().byChainId(Number(w.chain_id))!.assets.find((x) => x.symbol === "USDC")!;
      const hash = () => `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      await recordOutgoingTransfer(c, w, { chainId: Number(w.chain_id), blockNumber: 10n, blockHash: hash(), transactionHash: hash(), transactionIndex: 0, logIndex: 0, tokenAddress: usdc.address, toAddress: `0x${randomBytes(20).toString("hex")}`, amount: 2_000_000n, blockTimestamp: new Date() });
    });
    try {
      setBalanceReader(async () => ({ balance: 5_000_000n, blockNumber: 99n }));
      const checks = (await call("GET", "/v1/accounting/health", auth(s))).data.checks.filter((c: any) => String(c.key).startsWith("onchain:"));
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: "attention", expected: "5.00", actual: "-2.00", difference: "-7.00" });
      expect(checks[0].detail).toMatch(/block 99/);
      setBalanceReader(async () => ({ balance: 0n, blockNumber: 100n }));
      // (The books say -2 because nothing recorded the money arriving; a real wallet can't go below 0.)
      expect((await call("GET", "/v1/accounting/health", auth(s))).data.checks.find((c: any) => String(c.key).startsWith("onchain:")).status).toBe("attention");
    } finally {
      setBalanceReader(null);
    }
  });
});
