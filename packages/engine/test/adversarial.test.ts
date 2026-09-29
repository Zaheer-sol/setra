import { afterAll, describe, expect, it } from "vitest";
import { closePools, withTenant, type Client } from "../../database/src";
import { cancelInvoice, ingestObservation, settlePayment } from "../src";
import { invoice, randomAddress, transfer, usd, workspace, type Workspace } from "../../../test/fixtures";

/**
 * Adversarial financial-correctness suite. Each test tries to make Setra report the WRONG financial
 * state: a false paid, false partial, false overpaid, false unknown, or a duplicate economic effect.
 */

afterAll(closePools);

const q = (ws: Workspace, sql: string, params: unknown[] = []) => withTenant(ws.orgId, (c: Client) => c.query(sql, params)).then((r) => r.rows);
const inv = async (ws: Workspace, id: string) => (await q(ws, "SELECT status, amount_paid FROM invoices WHERE id = $1", [id]))[0]!;
const settled = (ws: Workspace, obs: ReturnType<typeof transfer>) => withTenant(ws.orgId, (c) => ingestObservation(c, ws.wallet, obs, "settled"));
const paymentOf = async (ws: Workspace, observationId: string) => (await q(ws, "SELECT * FROM payments WHERE observation_id = $1", [observationId]))[0]!;
const exceptionsOf = async (ws: Workspace, paymentId: string) => (await q(ws, "SELECT type FROM exceptions WHERE payment_id = $1 ORDER BY id", [paymentId])).map((r) => r.type);
const allocationsTotal = async (ws: Workspace, invoiceId: string) => (await q(ws, "SELECT COALESCE(SUM(amount),0)::text AS t FROM allocations WHERE invoice_id = $1", [invoiceId]))[0]!.t;

describe("same amount, multiple invoices", () => {
  it("refuses to guess between two $2,000 invoices for different customers (unknown sender)", async () => {
    const ws = await workspace();
    const a = await invoice(ws, "Acme Ltd", "2000.00");
    const b = await invoice(ws, "Nova Systems", "2000.00");
    const r = await settled(ws, transfer(ws, usd("2000"), randomAddress()));
    const p = await paymentOf(ws, r.observationId!);
    expect(p.status).toBe("needs_review");
    expect(await exceptionsOf(ws, p.id)).toEqual(["ambiguous_match"]);
    expect((await inv(ws, a.id)).status).toBe("open");
    expect((await inv(ws, b.id)).status).toBe("open");
  });

  it("decides deterministically when the known sender identifies the customer", async () => {
    const ws = await workspace();
    const acme = await invoice(ws, "Acme Ltd", "2000.00");
    const nova = await invoice(ws, "Nova Systems", "2000.00");
    const r = await settled(ws, transfer(ws, usd("2000"), ws.customers["Nova Systems"]!.address!));
    expect((await paymentOf(ws, r.observationId!)).invoice_id).toBe(nova.id);
    expect((await inv(ws, acme.id)).status).toBe("open");
  });

  it("does not allocate a known sender's payment when two of their invoices have the same balance", async () => {
    const ws = await workspace();
    const first = await invoice(ws, "Acme Ltd", "2000.00");
    const second = await invoice(ws, "Acme Ltd", "2000.00");
    const r = await settled(ws, transfer(ws, usd("2000"), ws.customers["Acme Ltd"]!.address!));
    const p = await paymentOf(ws, r.observationId!);
    expect(p.status).toBe("needs_review");
    expect(p.invoice_id).toBeNull();
    expect(await exceptionsOf(ws, p.id)).toEqual(["ambiguous_match"]);
    expect(await allocationsTotal(ws, first.id)).toBe("0");
    expect(await allocationsTotal(ws, second.id)).toBe("0");
    const [decision] = await q(ws, "SELECT rule_version, candidates FROM match_decisions WHERE payment_id = $1 AND stage = 'final'", [p.id]);
    expect(decision.rule_version).toBe("match-v1.1");
    expect(decision.candidates.map((c: { invoiceId: string }) => c.invoiceId).sort()).toEqual([first.id, second.id].sort());
  });
});

describe("amount logic is never overridden by a known sender", () => {
  it("$1,999 from the known customer on a $2,000 invoice is partial with $1 remaining, not paid", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    const r = await settled(ws, transfer(ws, usd("1999"), ws.customers["Acme Ltd"]!.address!));
    const p = await paymentOf(ws, r.observationId!);
    expect(p.status).toBe("partial");
    expect(await inv(ws, i.id)).toEqual({ status: "partially_paid", amount_paid: usd("1999").toString() });
    expect(await exceptionsOf(ws, p.id)).toEqual(["partial_payment"]);
  });

  it("an unknown sender's partial amount is never applied to the only open invoice", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    const r = await settled(ws, transfer(ws, usd("1999"), randomAddress()));
    expect((await paymentOf(ws, r.observationId!)).status).toBe("needs_review");
    expect((await inv(ws, i.id)).amount_paid).toBe("0");
  });

  it("an unknown sender's exact amount matches only when exactly one open invoice has that remaining balance", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    await invoice(ws, "Nova Systems", "1500.00");
    const r = await settled(ws, transfer(ws, usd("2000"), randomAddress()));
    const [decision] = await q(ws, "SELECT checks FROM match_decisions WHERE payment_id = $1 AND stage = 'final'", [(await paymentOf(ws, r.observationId!)).id]);
    expect((await inv(ws, i.id)).status).toBe("paid");
    // The decision records that the sender was NOT on file and that uniqueness decided it.
    const checks = decision.checks as Array<{ code: string; passed: boolean | null; detail: string }>;
    expect(checks.find((c) => c.code === "sender")?.passed).toBeNull();
    expect(checks.find((c) => c.code === "uniqueness")?.detail).toBe("Only open invoice with this exact amount");
  });
});

describe("rails: token, network, expiry, cancellation", () => {
  it("a known customer's USDT0 payment never settles a USDC invoice", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "20.00");
    const r = await settled(ws, transfer(ws, usd("20"), ws.customers["Acme Ltd"]!.address!, { tokenAddress: randomAddress() }));
    const p = await paymentOf(ws, r.observationId!);
    expect(p.status).toBe("needs_review");
    expect(await exceptionsOf(ws, p.id)).toEqual(["wrong_token"]);
    expect((await inv(ws, i.id)).status).toBe("open");
    const [obs] = await q(ws, "SELECT token_address, asset_id FROM source_observations WHERE id = $1", [r.observationId]);
    expect(obs.asset_id).toBeNull(); // evidence keeps the actual token contract
    expect(obs.token_address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("an expired invoice is never auto-paid, even by its own customer", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "20.00");
    await q(ws, "UPDATE invoices SET issued_at = now() - interval '10 days', expires_at = now() - interval '1 day', status = 'expired' WHERE id = $1", [i.id]);
    const r = await settled(ws, transfer(ws, usd("20"), ws.customers["Acme Ltd"]!.address!));
    const p = await paymentOf(ws, r.observationId!);
    expect(await exceptionsOf(ws, p.id)).toEqual(["late_payment"]);
    expect((await inv(ws, i.id)).status).toBe("expired");
  });

  it("a cancelled invoice is never paid; the payment stays visible and is explained", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Nova Systems", "33.00");
    await withTenant(ws.orgId, (c) => cancelInvoice(c, ws.orgId, i.id, "Issued by mistake", ws.actor));
    const r = await settled(ws, transfer(ws, usd("33"), randomAddress()));
    const p = await paymentOf(ws, r.observationId!);
    expect(p.status).toBe("needs_review");
    expect(await exceptionsOf(ws, p.id)).toEqual(["late_payment"]);
    const [e] = await q(ws, "SELECT detail FROM exceptions WHERE payment_id = $1", [p.id]);
    expect(e.detail).toContain("cancelled");
    expect((await inv(ws, i.id)).status).toBe("cancelled");
  });
});

describe("multi-payment, overpayment and duplicates", () => {
  it("$1,000 + $1,000 on $2,000: partially paid, then paid, with no double counting", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    const sender = ws.customers["Acme Ltd"]!.address!;
    await settled(ws, transfer(ws, usd("1000"), sender));
    expect(await inv(ws, i.id)).toEqual({ status: "partially_paid", amount_paid: usd("1000").toString() });
    await settled(ws, transfer(ws, usd("1000"), sender));
    expect(await inv(ws, i.id)).toEqual({ status: "paid", amount_paid: usd("2000").toString() });
    expect(await allocationsTotal(ws, i.id)).toBe(usd("2000").toString());
  });

  it("$2,500 on $2,000: overpaid by exactly $500", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    const r = await settled(ws, transfer(ws, usd("2500"), ws.customers["Acme Ltd"]!.address!));
    expect(await inv(ws, i.id)).toEqual({ status: "overpaid", amount_paid: usd("2500").toString() });
    const [e] = await q(ws, "SELECT detail FROM exceptions WHERE payment_id = $1", [(await paymentOf(ws, r.observationId!)).id]);
    expect(e.detail).toContain("$500.00 more than requested");
  });

  it("regression of the real testnet sequence: payment A matches, payment B from the same sender is a possible duplicate", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2.00");
    const sender = ws.customers["Acme Ltd"]!.address!;
    const a = await settled(ws, transfer(ws, usd("2"), sender));
    const b = await settled(ws, transfer(ws, usd("2"), sender));
    expect((await paymentOf(ws, a.observationId!)).status).toBe("matched");
    const pb = await paymentOf(ws, b.observationId!);
    expect(pb.status).toBe("needs_review");
    expect(await exceptionsOf(ws, pb.id)).toEqual(["duplicate_payment"]);
    expect(await inv(ws, i.id)).toEqual({ status: "paid", amount_paid: usd("2").toString() });
  });

  it("the same transaction delivered twice is one payment, not a duplicate", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2.00");
    const obs = transfer(ws, usd("2"), ws.customers["Acme Ltd"]!.address!);
    await settled(ws, obs);
    await settled(ws, obs);
    await withTenant(ws.orgId, (c) => ingestObservation(c, ws.wallet, obs, "tip")); // late tip replay after settlement
    expect((await q(ws, "SELECT count(*)::int AS n FROM payments"))[0].n).toBe(1);
    expect((await q(ws, "SELECT count(*)::int AS n FROM exceptions"))[0].n).toBe(0);
    expect(await allocationsTotal(ws, i.id)).toBe(usd("2").toString());
  });

  it("a legitimate second payment from the same customer goes to their other open invoice", async () => {
    const ws = await workspace();
    const first = await invoice(ws, "Acme Ltd", "2.00");
    const second = await invoice(ws, "Acme Ltd", "3.00");
    const sender = ws.customers["Acme Ltd"]!.address!;
    await settled(ws, transfer(ws, usd("2"), sender));
    const r2 = await settled(ws, transfer(ws, usd("3"), sender));
    expect((await paymentOf(ws, r2.observationId!)).status).toBe("matched");
    expect((await inv(ws, first.id)).status).toBe("paid");
    expect((await inv(ws, second.id)).status).toBe("paid");
  });

  it("the same amount again from a different, unknown sender after the invoice is paid is unknown, with the paid invoice suggested", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2.00");
    await settled(ws, transfer(ws, usd("2"), ws.customers["Acme Ltd"]!.address!));
    const r = await settled(ws, transfer(ws, usd("2"), randomAddress()));
    const p = await paymentOf(ws, r.observationId!);
    expect(await exceptionsOf(ws, p.id)).toEqual(["unknown_payment"]);
    const [e] = await q(ws, "SELECT candidates FROM exceptions WHERE payment_id = $1", [p.id]);
    expect(e.candidates[0].reasons).toContain("Same amount as an invoice already paid");
    expect((await inv(ws, i.id)).amount_paid).toBe(usd("2").toString());
  });
});

describe("concurrency", () => {
  it("the same observation processed by two workers at once creates one economic effect", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "50.00");
    const obs = transfer(ws, usd("50"), ws.customers["Acme Ltd"]!.address!);
    const results = await Promise.allSettled([settled(ws, obs), settled(ws, obs), settled(ws, obs), settled(ws, obs)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await q(ws, "SELECT count(*)::int AS n FROM payments"))[0].n).toBe(1);
    expect((await q(ws, "SELECT count(*)::int AS n FROM allocations"))[0].n).toBe(1);
    expect((await q(ws, "SELECT count(*)::int AS n FROM financial_events WHERE type = 'PAYMENT_MATCHED'"))[0].n).toBe(1);
    expect((await inv(ws, i.id)).amount_paid).toBe(usd("50").toString());
  });

  it("settling one confirming payment from several requests at once applies it once", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "70.00");
    const r = await withTenant(ws.orgId, (c) => ingestObservation(c, ws.wallet, transfer(ws, usd("70"), randomAddress()), "tip"));
    await Promise.all(Array.from({ length: 5 }, () => withTenant(ws.orgId, (c) => settlePayment(c, r.paymentId!))));
    expect((await q(ws, "SELECT count(*)::int AS n FROM allocations"))[0].n).toBe(1);
    expect((await inv(ws, i.id)).amount_paid).toBe(usd("70").toString());
  });

  it("two different exact payments racing for one invoice: one pays it, the other is flagged, never both applied", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "90.00");
    const sender = ws.customers["Acme Ltd"]!.address!;
    const [a, b] = await Promise.all([settled(ws, transfer(ws, usd("90"), sender)), settled(ws, transfer(ws, usd("90"), sender))]);
    const statuses = [(await paymentOf(ws, a.observationId!)).status, (await paymentOf(ws, b.observationId!)).status].sort();
    expect(statuses).toEqual(["matched", "needs_review"]);
    expect(await inv(ws, i.id)).toEqual({ status: "paid", amount_paid: usd("90").toString() });
  });

  it("the database itself rejects a second payment for the same observation", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "5.00");
    const r = await settled(ws, transfer(ws, usd("5"), randomAddress()));
    const p = await paymentOf(ws, r.observationId!);
    await expect(
      q(ws, "INSERT INTO payments (id, organization_id, environment, observation_id, source, wallet_id, chain_id, token_address, amount, from_address, to_address, transaction_hash, block_number, block_timestamp) SELECT 'pay_dupe', organization_id, environment, observation_id, source, wallet_id, chain_id, token_address, amount, from_address, to_address, transaction_hash, block_number, block_timestamp FROM payments WHERE id = $1", [p.id])
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("audit chain: every financial event is explainable", () => {
  it("each settlement event traces to a decision, an invoice or exception, an observation and block evidence", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "11.00");
    await settled(ws, transfer(ws, usd("11"), ws.customers["Acme Ltd"]!.address!));
    await settled(ws, transfer(ws, usd("7.77"), randomAddress()));
    const rows = await q(
      ws,
      `SELECT f.type, f.rule_version, f.match_decision_id, f.invoice_id, o.block_hash, o.transaction_hash, o.log_index, m.checks
         FROM financial_events f JOIN source_observations o ON o.id = f.observation_id LEFT JOIN match_decisions m ON m.id = f.match_decision_id
        WHERE f.type <> 'PAYMENT_OBSERVED'`
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.rule_version).toBe("match-v1.1");
      expect(r.match_decision_id).toBeTruthy();
      expect(r.block_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.transaction_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Array.isArray(r.checks) && r.checks.length > 0).toBe(true);
    }
    const unknown = rows.find((r) => r.type === "UNKNOWN_PAYMENT")!;
    const [ex] = await q(ws, "SELECT count(*)::int AS n FROM exceptions e JOIN financial_events f ON f.payment_id = e.payment_id WHERE f.type = 'UNKNOWN_PAYMENT'");
    expect(unknown.invoice_id).toBeNull();
    expect(ex.n).toBe(1);
  });
});
