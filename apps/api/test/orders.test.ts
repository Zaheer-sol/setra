import { createHmac, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePools } from "../../../packages/database/src";
import { sign } from "../../../packages/events/src";
import { apiKey, call, randomAddress, server, setupWorkspace, signup, type Session } from "./helpers";

/**
 * Orders from the merchant's own systems: a backend calls the orders API, or a store / checkout /
 * payment processor posts to an order source. The merchant never creates an invoice by hand, and the
 * normal payment is matched, booked and reported back with the merchant's own order ID.
 */

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const auth = (s: Session) => ({ cookie: s.cookie });

describe("the orders API", () => {
  it("takes an order with its customer inline, matches the payment and books it, with no invoice created by hand", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const key = await apiKey(s);
    const order = { external_id: "1002", number: "1002", amount: "250.00", customer: { external_ref: "alice_123", name: "Alice", email: "alice@example.com" }, metadata: { cart: "c_77" } };
    const first = await call("POST", "/v1/orders", { key }, order, { "idempotency-key": `o-${randomBytes(4).toString("hex")}` });
    expect(first.statusCode).toBe(201);
    expect(first.data).toMatchObject({ object: "order", external_id: "1002", outcome: "created", invoice: { number: "1002", external_id: "1002", amount_due: "250.00", status: "open" } });
    const invoice = first.data.invoice;

    // The same order again (a retry, or the store sending it twice) changes nothing.
    const again = await call("POST", "/v1/orders", { key }, order);
    expect(again.statusCode).toBe(200);
    expect(again.data).toMatchObject({ outcome: "unchanged", invoice: { id: invoice.id } });
    // The customer was created once and is found by the merchant's own reference.
    const customers = (await call("GET", "/v1/customers?external_ref=alice_123", { key })).data.data;
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ name: "Alice", email: "alice@example.com" });
    expect((await call("GET", "/v1/orders/1002", { key })).data.invoice.id).toBe(invoice.id);
    expect((await call("GET", "/v1/invoices?external_id=1002", { key })).data.data.map((i: any) => i.id)).toEqual([invoice.id]);

    // The customer pays the merchant's wallet; nobody opens Setra.
    const paid = (await call("POST", "/v1/test/payments", auth(s), { scenario: "exact", invoice_id: invoice.id })).data;
    expect(paid.status).toBe("matched");
    const matched = (await call("GET", "/v1/financial-events?limit=20", { key })).data.data.find((e: any) => e.type === "PAYMENT_MATCHED");
    expect(matched.invoice).toMatchObject({ id: invoice.id, number: "1002", external_id: "1002", metadata: { cart: "c_77" }, status: "paid" });
    expect(matched.customer).toMatchObject({ name: "Alice", external_ref: "alice_123" });
    // Books: the receivable on issue, then the receipt and its application.
    const pl = (await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s))).data;
    expect(pl.revenue.total).toBe("250.00");
    const ar = (await call("GET", "/v1/accounting/reports/receivables-aging", auth(s))).data;
    expect(ar.invoices.find((i: any) => i.id === invoice.id || i.number === "1002")).toBeUndefined();
    expect(ar.ledger_check.matches).toBe(true);
    const tb = (await call("GET", "/v1/accounting/reports/trial-balance", auth(s))).data.totals;
    expect(tb.balanced).toBe(true);
  });

  it("replaces an order whose amount changed before payment, cancels on request, and refuses to change a paid one", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const key = await apiKey(s);
    const base = { external_id: "A-9", amount: "100.00", customer: { email: "bob@example.com" } };
    const v1 = (await call("POST", "/v1/orders", { key }, base)).data.invoice;
    const v2 = await call("POST", "/v1/orders", { key }, { ...base, amount: "120.00" });
    expect(v2.data.outcome).toBe("updated");
    expect(v2.data.invoice.amount_due).toBe("120.00");
    expect((await call("GET", `/v1/invoices/${v1.id}`, { key })).data.status).toBe("cancelled");
    expect((await call("GET", "/v1/customers?search=bob@example.com", { key })).data.data).toHaveLength(1);

    const cancelled = await call("POST", "/v1/orders/A-9/cancel", { key });
    expect(cancelled.data).toMatchObject({ outcome: "cancelled", invoice: { status: "cancelled" } });
    // The ID is free again for a new order.
    const v3 = (await call("POST", "/v1/orders", { key }, { ...base, amount: "90.00" })).data;
    expect(v3.outcome).toBe("created");
    await call("POST", "/v1/test/payments", auth(s), { scenario: "exact", invoice_id: v3.invoice.id });
    const change = await call("POST", "/v1/orders", { key }, { ...base, amount: "95.00" });
    expect(change.statusCode).toBe(409);
    expect(change.data.error.code).toBe("order_has_payments");
  });

  it("needs to know who the customer is, and keeps orders inside their workspace", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const key = await apiKey(s);
    const bad = await call("POST", "/v1/orders", { key }, { external_id: "X1", amount: "10.00" });
    expect(bad.statusCode).toBe(422);
    await call("POST", "/v1/orders", { key }, { external_id: "X1", amount: "10.00", customer: { email: "c@example.com" } });
    const other = await signup("Other Co");
    await setupWorkspace(other);
    expect((await call("GET", "/v1/orders/X1", { key: await apiKey(other) })).statusCode).toBe(404);
  });
});

describe("order sources", () => {
  const inject = async (sourceId: string, raw: string, headers: Record<string, string>) =>
    (await server()).inject({ method: "POST", url: `/v1/inbound/orders/${sourceId}`, headers: { "content-type": "application/json", ...headers }, payload: raw });
  const signed = (secret: string, raw: string, delivery: string) => {
    const ts = Math.floor(Date.now() / 1000);
    return { "x-setra-timestamp": String(ts), "x-setra-signature": `v1=${sign(secret, ts, raw)}`, "x-setra-delivery-id": delivery };
  };

  it("a connected backend posts signed orders; retries are harmless and a bad signature is refused", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const created = await call("POST", "/v1/order-sources", auth(s), { kind: "generic", name: "Checkout backend" });
    expect(created.statusCode).toBe(201);
    const { id, secret, inbound_url } = created.data;
    expect(secret).toMatch(/^osec_/);
    expect(inbound_url).toMatch(new RegExp(`/api/v1/inbound/orders/${id}$`));
    expect(JSON.stringify((await call("GET", "/v1/order-sources", auth(s))).data)).not.toContain(secret);

    const raw = JSON.stringify({ external_id: "web-501", amount: "75.00", customer: { external_ref: "u_9", name: "Dana" } });
    const res = await inject(id, raw, signed(secret, raw, "d-1"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "created", duplicate: false });
    const retry = await inject(id, raw, signed(secret, raw, "d-1"));
    expect(retry.json()).toMatchObject({ outcome: "created", duplicate: true });
    expect((await call("GET", "/v1/invoices?external_id=web-501", auth(s))).data.data).toHaveLength(1);

    const forged = await inject(id, raw, signed("osec_wrong", raw, "d-2"));
    expect(forged.statusCode).toBe(401);
    const tampered = await inject(id, raw.replace("75.00", "1.00"), signed(secret, raw, "d-3"));
    expect(tampered.statusCode).toBe(401);
    // A malformed order is recorded and answered, so the sender sees why.
    const broken = JSON.stringify({ external_id: "web-502" });
    expect((await inject(id, broken, signed(secret, broken, "d-4"))).json()).toMatchObject({ outcome: "failed" });
    const events = (await call("GET", `/v1/order-sources/${id}/events`, auth(s))).data.data;
    expect(events.map((e: any) => e.outcome).sort()).toEqual(["created", "failed"]);
    // Turned off: refused, and nothing is created.
    await call("POST", `/v1/order-sources/${id}/status`, auth(s), { status: "disabled" });
    const raw2 = JSON.stringify({ external_id: "web-503", amount: "5.00", customer: { email: "x@example.com" } });
    expect((await inject(id, raw2, signed(secret, raw2, "d-5"))).statusCode).toBe(410);
  });

  it("Shopify: waiting orders become expected payments; orders Shopify collected, other currencies and forgeries don't", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const shopSecret = `shpss_${randomBytes(16).toString("hex")}`;
    const { id } = (await call("POST", "/v1/order-sources", auth(s), { kind: "shopify", name: "My store", secret: shopSecret })).data;
    const shopify = (topic: string, order: object, webhookId: string) => {
      const raw = JSON.stringify(order);
      return inject(id, raw, { "x-shopify-topic": topic, "x-shopify-webhook-id": webhookId, "x-shopify-hmac-sha256": createHmac("sha256", shopSecret).update(raw).digest("base64") });
    };
    const order = {
      id: 820982911946154500,
      name: "#1001",
      currency: "USD",
      financial_status: "pending",
      total_price: "199.00",
      email: "eve@example.com",
      customer: { id: 115310627314723950, first_name: "Eve", last_name: "Stone", email: "eve@example.com" },
      line_items: [{ title: "Hoodie", quantity: 2 }, { title: "Cap", quantity: 1 }]
    };
    expect((await shopify("orders/create", order, "w-1")).json()).toMatchObject({ outcome: "created" });
    const inv = (await call("GET", "/v1/invoices?external_id=shopify:820982911946154500", auth(s))).data.data[0];
    expect(inv).toMatchObject({ number: "SHOP-1001", amount_due: "199.00", title: "Shopify order #1001", purpose: "2 × Hoodie, 1 × Cap", customer: { name: "Eve Stone" } });
    // The same order updated with the same total is unchanged; Shopify cancelling it cancels it.
    expect((await shopify("orders/updated", order, "w-2")).json()).toMatchObject({ outcome: "unchanged" });
    expect((await shopify("orders/cancelled", { ...order, cancelled_at: "2026-10-03T10:00:00Z" }, "w-3")).json()).toMatchObject({ outcome: "cancelled" });

    expect((await shopify("orders/create", { ...order, id: 2, name: "#1002", financial_status: "paid" }, "w-4")).json()).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/paid/) });
    expect((await shopify("orders/create", { ...order, id: 3, name: "#1003", currency: "EUR" }, "w-5")).json()).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/EUR/) });
    const raw = JSON.stringify({ ...order, id: 4 });
    expect((await inject(id, raw, { "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "w-6", "x-shopify-hmac-sha256": createHmac("sha256", "wrong").update(raw).digest("base64") })).statusCode).toBe(401);
  });

  it("an order from a source is paid by a transfer Setra never initiated and reported back with the store's ID", async () => {
    const s = await signup();
    const { wallet } = await setupWorkspace(s);
    const shopSecret = `shpss_${randomBytes(16).toString("hex")}`;
    const { id } = (await call("POST", "/v1/order-sources", auth(s), { kind: "shopify", name: "Store", secret: shopSecret })).data;
    const customerWallet = randomAddress();
    const raw = JSON.stringify({ id: 77, name: "#2001", currency: "USD", financial_status: "pending", total_price: "61.37", customer: { id: 9, first_name: "Kofi", email: "kofi@example.com" } });
    await inject(id, raw, { "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "x-1", "x-shopify-hmac-sha256": createHmac("sha256", shopSecret).update(raw).digest("base64") });
    // A plain transfer of exactly that amount, from a wallet Setra has never seen.
    const p = (await call("POST", "/v1/test/payments", auth(s), { scenario: "unknown", amount: "61.37", from_address: customerWallet, wallet_id: wallet.id })).data;
    expect(p).toMatchObject({ status: "matched", business_object: { number: "SHOP-2001" } });
    const ev = (await call("GET", "/v1/financial-events?limit=20", auth(s))).data.data.find((e: any) => e.type === "PAYMENT_MATCHED");
    expect(ev.invoice).toMatchObject({ external_id: "shopify:77", metadata: { shopify_order_id: "77", shopify_order_name: "#2001" } });
  });
});
