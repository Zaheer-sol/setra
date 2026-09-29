import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePools, withTenant } from "../../../packages/database/src";
import { recordOutgoingTransfer } from "../../../packages/engine/src";
import { apiKey, call, randomAddress, server, setupWorkspace, signup, type Session } from "./helpers";

/**
 * Corrections (move an applied payment, or take it back to review), refunds proven by outgoing
 * transfers, and sending payment requests. History is never rewritten.
 */

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const auth = (s: Session) => ({ cookie: s.cookie });
const hex32 = () => `0x${randomBytes(32).toString("hex")}`;

async function inv(s: Session, customerId: string, title: string, amount: string) {
  const r = await call("POST", "/v1/invoices", auth(s), { customer_id: customerId, title, amount });
  expect(r.statusCode).toBe(201);
  return r.data;
}
const pay = async (s: Session, body: Record<string, unknown>) => (await call("POST", "/v1/test/payments", auth(s), body)).data;
const events = async (s: Session, paymentId: string) => (await call("GET", `/v1/payments/${paymentId}`, auth(s))).data.financial_events.map((e: any) => e.type);

/** An outgoing transfer from the payment's wallet, as the ingestor records it from a finalized block. */
async function outgoing(s: Session, payment: any, amount: string, opts: { to?: string; blockOffset?: number; walletId?: string; token?: string } = {}) {
  const [whole, frac = ""] = amount.split(".");
  const units = BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return withTenant(s.orgId, async (c) => {
    const w = (await c.query("SELECT id, organization_id, environment FROM wallets WHERE id = $1", [opts.walletId ?? payment.wallet.id])).rows[0];
    return recordOutgoingTransfer(c, w, {
      chainId: payment.chain_id,
      blockNumber: BigInt(payment.block_number) + BigInt(opts.blockOffset ?? 5),
      blockHash: hex32(),
      transactionHash: hex32(),
      transactionIndex: 0,
      logIndex: 0,
      tokenAddress: opts.token ?? payment.asset.address,
      toAddress: opts.to ?? payment.sender,
      amount: units,
      blockTimestamp: new Date()
    });
  });
}

describe("corrections", () => {
  it("moves a mistakenly assigned payment to the right invoice; the wrong invoice reopens; history keeps every step", async () => {
    const s = await signup();
    const { acme, nova } = await setupWorkspace(s);
    const wrong = await inv(s, nova.id, "Brand refresh", "740.00");
    const right = await inv(s, acme.id, "Design review retainer", "740.00");
    await call("POST", "/v1/webhook-endpoints", auth(s), { url: "http://127.0.0.1:9/h", event_types: ["payment.unassigned", "payment.matched"] });
    const p = await pay(s, { scenario: "unknown", amount: "740.00" });
    const exc = p.exceptions[0];
    await call("POST", `/v1/exceptions/${exc.id}/resolve`, auth(s), { action: "assign", invoice_id: wrong.id, reason: "Looked like Nova" });
    expect((await call("GET", `/v1/invoices/${wrong.id}`, auth(s))).data.status).toBe("paid");

    const fixed = await call("POST", `/v1/payments/${p.id}/corrections`, auth(s), { action: "reassign", invoice_id: right.id, reason: "Acme confirmed it was theirs" });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.data).toMatchObject({ status: "matched", business_object: { id: right.id, title: "Design review retainer" }, context_source: "manual_resolution" });
    const wrongAfter = (await call("GET", `/v1/invoices/${wrong.id}`, auth(s))).data;
    expect(wrongAfter).toMatchObject({ status: "open", amount_paid: "0.00" });
    expect(wrongAfter.allocations.map((a: any) => [a.kind, a.amount])).toEqual([["manual", "740.00"], ["reversal", "-740.00"]]);
    expect((await call("GET", `/v1/invoices/${right.id}`, auth(s))).data.status).toBe("paid");

    expect(await events(s, p.id)).toEqual(["PAYMENT_OBSERVED", "UNKNOWN_PAYMENT", "PAYMENT_MATCHED", "PAYMENT_UNASSIGNED", "PAYMENT_MATCHED"]);
    expect(fixed.data.corrections).toEqual([
      expect.objectContaining({ action: "reassign", reason: "Acme confirmed it was theirs", from_invoice: expect.objectContaining({ id: wrong.id }), to_invoice: expect.objectContaining({ id: right.id }) })
    ]);
    expect(fixed.data.context_history.map((h: any) => [h.kind, h.outcome])).toEqual([
      ["provisional_decision", "needs_review"],
      ["decision", "needs_review"],
      ["resolution", "assign"],
      ["correction", "reassign"]
    ]);
    const hooks = (await call("GET", "/v1/webhook-deliveries?limit=20", auth(s))).data.data.map((d: any) => d.event_type);
    expect(hooks).toContain("payment.unassigned");
  });

  it("takes an automatically matched payment back to review, and it can be assigned again", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const a = await inv(s, acme.id, "September services", "100.00");
    const b = await inv(s, acme.id, "October services", "250.00");
    const p = await pay(s, { scenario: "exact", invoice_id: a.id });
    expect(p.context_source).toBe("automatic_match");

    const back = (await call("POST", `/v1/payments/${p.id}/corrections`, auth(s), { action: "unassign", reason: "Customer says this was a deposit" })).data;
    expect(back).toMatchObject({ status: "needs_review", business_object: null, purpose_status: "unknown", context_source: null });
    expect((await call("GET", `/v1/invoices/${a.id}`, auth(s))).data.status).toBe("open");
    const open = back.exceptions.find((e: any) => e.status === "open");
    expect(open).toMatchObject({ type: "unknown_payment", summary: `Payment taken off ${a.number}` });

    const again = await call("POST", `/v1/exceptions/${open.id}/resolve`, auth(s), { action: "assign", invoice_id: b.id, reason: "Apply the deposit to October" });
    expect(again.statusCode).toBe(200);
    const after = (await call("GET", `/v1/payments/${p.id}`, auth(s))).data;
    expect(after).toMatchObject({ status: "partial", business_object: { id: b.id } });
  });

  it("moving a partial payment closes its follow-up and opens the right one on the new invoice", async () => {
    const s = await signup();
    const { acme, studio } = await setupWorkspace(s);
    const a = await inv(s, acme.id, "Hosting", "2000.00");
    const b = await inv(s, studio.id, "Design", "1500.00");
    const p = await pay(s, { scenario: "partial", invoice_id: a.id, amount: "1500.00" });
    const partial = p.exceptions.find((e: any) => e.type === "partial_payment");
    expect(partial.status).toBe("open");
    const moved = (await call("POST", `/v1/payments/${p.id}/corrections`, auth(s), { action: "reassign", invoice_id: b.id, reason: "Studio Ten's payment" })).data;
    expect(moved.status).toBe("matched");
    expect(moved.exceptions.find((e: any) => e.id === partial.id).status).toBe("resolved");
    expect((await call("GET", `/v1/invoices/${a.id}`, auth(s))).data.status).toBe("open");
  });

  it("refuses corrections that would be wrong or unauthorized", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const a = await inv(s, acme.id, "A", "10.00");
    const cancelled = await inv(s, acme.id, "Cancelled", "10.00");
    await call("POST", `/v1/invoices/${cancelled.id}/cancel`, auth(s), {});
    const p = await pay(s, { scenario: "exact", invoice_id: a.id });
    const post = (body: unknown, who: any = auth(s)) => call("POST", `/v1/payments/${p.id}/corrections`, who, body);
    expect((await post({ action: "reassign", invoice_id: a.id, reason: "same" })).data.error.code).toBe("same_invoice");
    expect((await post({ action: "reassign", invoice_id: cancelled.id, reason: "cancelled" })).data.error.code).toBe("invoice_cancelled");
    expect((await post({ action: "reassign", reason: "no target" })).statusCode).toBe(422);
    expect((await post({ action: "unassign", reason: "x" })).statusCode).toBe(422); // reason too short
    const confirming = await pay(s, { scenario: "exact", invoice_id: (await inv(s, acme.id, "B", "11.00")).id, finalize: false });
    expect((await call("POST", `/v1/payments/${confirming.id}/corrections`, auth(s), { action: "unassign", reason: "not yet" })).data.error.code).toBe("payment_not_applied");
    const ro = await apiKey(s, { scope: "read_only" });
    expect([401, 403]).toContain((await post({ action: "unassign", reason: "read only" }, { key: ro })).statusCode);
    const other = await signup();
    expect((await post({ action: "unassign", reason: "other org" }, auth(other))).statusCode).toBe(404);
    expect((await call("GET", `/v1/payments/${p.id}`, auth(s))).data.status).toBe("matched");
  });
});

describe("refunds", () => {
  it("resolves a duplicate by linking the transfer that sent it back", async () => {
    const s = await signup();
    const { acme, acmeAddress } = await setupWorkspace(s);
    const i = await inv(s, acme.id, "September Infrastructure Services", "2.00");
    await pay(s, { scenario: "exact", invoice_id: i.id, from_address: acmeAddress });
    const dup = await pay(s, { scenario: "exact", invoice_id: i.id, from_address: acmeAddress });
    const exc = dup.exceptions[0];
    expect(exc.type).toBe("duplicate_payment");

    const unrelated = await outgoing(s, dup, "5.00", { to: randomAddress() });
    const outId = await outgoing(s, dup, "2.00");
    const detail = (await call("GET", `/v1/exceptions/${exc.id}`, auth(s))).data;
    expect(detail.allowed_actions).toContain("refund");
    expect(detail.refund_candidates[0]).toMatchObject({ id: outId, amount: "2.00", to: acmeAddress });
    expect(detail.refund_candidates.map((c: any) => c.id)).toContain(unrelated);

    const res = await call("POST", `/v1/exceptions/${exc.id}/resolve`, auth(s), { action: "refund", outgoing_transfer_id: outId, reason: "Customer paid twice; sent back" });
    expect(res.statusCode).toBe(200);
    const after = (await call("GET", `/v1/payments/${dup.id}`, auth(s))).data;
    expect(after.status).toBe("refunded");
    expect(after.refunds).toEqual([expect.objectContaining({ amount: "2.00", to: acmeAddress, reason: "Customer paid twice; sent back" })]);
    expect(after.refunds_summary).toEqual({ refunded: "2.00", refundable: "0.00" });
    expect(await events(s, dup.id)).toContain("REFUND_OBSERVED");
    expect(after.context_history.map((h: any) => h.kind)).toContain("refund");

    const rec = (await call("GET", "/v1/reconciliation", auth(s))).data;
    expect(rec.summary.refunded).toBe("2.00");
    const csv = (await call("GET", "/v1/exports/reconciliation.csv", auth(s))).body as string;
    expect(csv).toContain("Refunded in 0x");

    // The same transfer can't back a second refund.
    const again = await call("POST", `/v1/payments/${dup.id}/refunds`, auth(s), { outgoing_transfer_id: outId, reason: "again" });
    expect(again.statusCode).toBe(409);
  });

  it("refunds the excess of an overpayment and closes the follow-up; the payment stays applied", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const i = await inv(s, acme.id, "Dedicated nodes", "2000.00");
    const p = await pay(s, { scenario: "overpaid", invoice_id: i.id, amount: "2500.00" });
    expect(p.refunds_summary.refundable).toBe("500.00");
    const tooMuch = await outgoing(s, p, "600.00");
    expect((await call("POST", `/v1/payments/${p.id}/refunds`, auth(s), { outgoing_transfer_id: tooMuch, reason: "too much" })).data.error.code).toBe("refund_too_large");
    const exact = await outgoing(s, p, "500.00");
    const r = await call("POST", `/v1/payments/${p.id}/refunds`, auth(s), { outgoing_transfer_id: exact, reason: "Returned the excess" });
    expect(r.statusCode).toBe(201);
    expect(r.data).toMatchObject({ status: "overpaid", refunds_summary: { refunded: "500.00", refundable: "0.00" } });
    expect(r.data.exceptions.find((e: any) => e.type === "overpayment").status).toBe("resolved");
    expect(r.data.correctable).toBe(false); // refunded money can't be moved
  });

  it("partial refunds leave the rest for review; resolving by refund needs the full amount", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const p = await pay(s, { scenario: "unknown", amount: "740.00" });
    const part = await outgoing(s, p, "240.00");
    const first = (await call("POST", `/v1/payments/${p.id}/refunds`, auth(s), { outgoing_transfer_id: part, reason: "Partial return" })).data;
    expect(first).toMatchObject({ status: "needs_review", refunds_summary: { refunded: "240.00", refundable: "500.00" } });
    const exc = first.exceptions.find((e: any) => e.status === "open");
    const small = await outgoing(s, p, "100.00");
    expect((await call("POST", `/v1/exceptions/${exc.id}/resolve`, auth(s), { action: "refund", outgoing_transfer_id: small, reason: "not all" })).data.error.code).toBe("refund_incomplete");
    const rest = await outgoing(s, p, "500.00");
    expect((await call("POST", `/v1/exceptions/${exc.id}/resolve`, auth(s), { action: "refund", outgoing_transfer_id: rest, reason: "Returned the rest" })).statusCode).toBe(200);
    expect((await call("GET", `/v1/payments/${p.id}`, auth(s))).data.status).toBe("refunded");
  });

  it("refuses refunds that don't prove anything", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const other = (await call("POST", "/v1/wallets", auth(s), { name: "Other", network: "monad", address: randomAddress(), assets: ["USDC"] })).data;
    const p = await pay(s, { scenario: "unknown", amount: "50.00" });
    const post = async (outId: string | null) => (await call("POST", `/v1/payments/${p.id}/refunds`, auth(s), { outgoing_transfer_id: outId, reason: "test" })).data.error?.code;
    expect(await post(await outgoing(s, p, "50.00", { walletId: other.id }))).toBe("wrong_wallet");
    expect(await post(await outgoing(s, p, "50.00", { blockOffset: -1 }))).toBe("refund_before_payment");
    const applied = await pay(s, { scenario: "exact", invoice_id: (await inv(s, acme.id, "Applied", "12.00")).id });
    const out = await outgoing(s, applied, "12.00");
    expect((await call("POST", `/v1/payments/${applied.id}/refunds`, auth(s), { outgoing_transfer_id: out, reason: "applied" })).data.error.code).toBe("payment_not_refundable");
  });
});

describe("sending payment requests", () => {
  it("emails the customer, records who and when, and refuses what can't be paid", async () => {
    const s = await signup();
    const { acme, nova } = await setupWorkspace(s);
    const i = await inv(s, acme.id, "September Infrastructure Services", "2000.00");
    const sent = await call("POST", `/v1/invoices/${i.id}/send`, auth(s), { message: "Thanks for your business." });
    expect(sent.statusCode).toBe(200);
    expect(sent.data).toMatchObject({ sent: true, to: "ap@acme.test" });
    const after = (await call("GET", `/v1/invoices/${i.id}`, auth(s))).data;
    expect(after.last_sent_to).toBe("ap@acme.test");
    expect(after.last_sent_at).not.toBeNull();
    expect(after.timeline.map((t: any) => t.action)).toContain("invoice_sent");

    const override = await call("POST", `/v1/invoices/${i.id}/send`, auth(s), { to: "finance@acme.test" });
    expect(override.data.to).toBe("finance@acme.test");

    const noEmail = await inv(s, nova.id, "Consulting", "10.00");
    expect((await call("POST", `/v1/invoices/${noEmail.id}/send`, auth(s), {})).data.error.code).toBe("recipient_required");
    await pay(s, { scenario: "exact", invoice_id: i.id });
    expect((await call("POST", `/v1/invoices/${i.id}/send`, auth(s), {})).data.error.code).toBe("invoice_not_payable");
    expect((await call("POST", `/v1/invoices/${noEmail.id}/send`, auth(s), { to: "not-an-email" })).statusCode).toBe(422);
  });
});
