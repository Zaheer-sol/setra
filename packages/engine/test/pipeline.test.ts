import { afterAll, describe, expect, it } from "vitest";
import { closePools, pool, withTenant, type Client } from "../../database/src";
import { dropObservation, ingestObservation, resolveException, reversePayment, settleObservation } from "../src";
import { invoice, randomAddress, transfer, usd, workspace, type Workspace } from "../../../test/fixtures";

afterAll(closePools);

const q = (ws: Workspace, sql: string, params: unknown[] = []) => withTenant(ws.orgId, (c: Client) => c.query(sql, params)).then((r) => r.rows);
const inv = async (ws: Workspace, id: string) => (await q(ws, "SELECT * FROM invoices WHERE id = $1", [id]))[0]!;
const paymentFor = async (ws: Workspace, observationId: string) => (await q(ws, "SELECT * FROM payments WHERE observation_id = $1", [observationId]))[0]!;
const events = async (ws: Workspace, paymentId: string) => (await q(ws, "SELECT type FROM financial_events WHERE payment_id = $1 ORDER BY id", [paymentId])).map((r) => r.type);
const ingest = (ws: Workspace, obs: ReturnType<typeof transfer>, stage: "tip" | "settled") => withTenant(ws.orgId, (c) => ingestObservation(c, ws.wallet, obs, stage));

describe("exact payment: observe → confirm → match", () => {
  it("detects at the tip without economic effect, then settles and pays the invoice", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00", { number: "INV-2041" });
    const obs = transfer(ws, usd("2000"), randomAddress());

    const tip = await ingest(ws, obs, "tip");
    let p = await paymentFor(ws, tip.observationId!);
    expect(p.status).toBe("confirming");
    expect(p.provisional_invoice_id).toBe(i.id);
    expect((await inv(ws, i.id)).status).toBe("open");
    expect(await events(ws, p.id)).toEqual(["PAYMENT_OBSERVED"]);

    await ingest(ws, obs, "settled");
    p = await paymentFor(ws, tip.observationId!);
    expect(p.status).toBe("matched");
    expect(p.invoice_id).toBe(i.id);
    const after = await inv(ws, i.id);
    expect(after.status).toBe("paid");
    expect(after.amount_paid).toBe(usd("2000").toString());
    expect(await events(ws, p.id)).toEqual(["PAYMENT_OBSERVED", "PAYMENT_MATCHED"]);

    const [decision] = await q(ws, "SELECT * FROM match_decisions WHERE payment_id = $1 AND stage = 'final'", [p.id]);
    expect(decision.rule_version).toBe("match-v1.1");
    expect(decision.checks.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(["receiving_wallet", "asset", "amount", "window", "uniqueness"]));
    const [event] = await q(ws, "SELECT data FROM financial_events WHERE payment_id = $1 AND type = 'PAYMENT_MATCHED'", [p.id]);
    expect(event.data.evidence.block_hash).toBe(obs.blockHash);
    expect(event.data.evidence.rule_version).toBe("match-v1.1");
    expect(event.data.invoice.number).toBe("INV-2041");
    expect(event.data.payment.amount).toBe("2000.00");
  });
});

describe("idempotency: duplicate source facts never duplicate economic effects", () => {
  it("processes the same log twice at every stage with one payment, one allocation, one event per type", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "500.00");
    const obs = transfer(ws, usd("500"), randomAddress());
    await ingest(ws, obs, "tip");
    await ingest(ws, obs, "tip");
    await ingest(ws, obs, "settled");
    await ingest(ws, obs, "settled");
    const [{ count: payments }] = await q(ws, "SELECT count(*)::int AS count FROM payments");
    const [{ count: allocations }] = await q(ws, "SELECT count(*)::int AS count FROM allocations");
    expect(payments).toBe(1);
    expect(allocations).toBe(1);
    expect((await inv(ws, i.id)).amount_paid).toBe(usd("500").toString());
    const [{ count: webhooksReady }] = await q(ws, "SELECT count(*)::int AS count FROM financial_events WHERE type = 'PAYMENT_MATCHED'");
    expect(webhooksReady).toBe(1);
  });

  it("settling an already-settled payment directly is a no-op", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "10.00");
    const r = await ingest(ws, transfer(ws, usd("10"), randomAddress()), "settled");
    await withTenant(ws.orgId, (c) => settleObservation(c, r.observationId!, "again"));
    const [{ count }] = await q(ws, "SELECT count(*)::int AS count FROM allocations");
    expect(count).toBe(1);
  });
});

describe("partial, multi-payment and overpayment", () => {
  it("tracks a partial payment, then settles on the second payment and closes the exception with history", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Nova Systems", "2000.00");
    const sender = ws.customers["Nova Systems"]!.address!;
    const first = await ingest(ws, transfer(ws, usd("1500"), sender), "settled");
    const p1 = await paymentFor(ws, first.observationId!);
    expect(p1.status).toBe("partial");
    expect((await inv(ws, i.id)).status).toBe("partially_paid");
    const [exception] = await q(ws, "SELECT * FROM exceptions WHERE payment_id = $1", [p1.id]);
    expect(exception.type).toBe("partial_payment");
    expect(exception.detail).toContain("$500.00 is still due");
    expect(await events(ws, p1.id)).toEqual(["PAYMENT_OBSERVED", "PARTIALLY_PAID"]);

    const second = await ingest(ws, transfer(ws, usd("500"), randomAddress()), "settled"); // exact remaining from an unknown sender
    const p2 = await paymentFor(ws, second.observationId!);
    expect(p2.status).toBe("matched");
    expect((await inv(ws, i.id)).status).toBe("paid");
    const [closed] = await q(ws, "SELECT e.status, r.actor_type, r.reason FROM exceptions e JOIN resolutions r ON r.id = e.resolution_id WHERE e.id = $1", [exception.id]);
    expect(closed).toMatchObject({ status: "resolved", actor_type: "system" });
  });

  it("marks overpayment with an exception describing the excess", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    const r = await ingest(ws, transfer(ws, usd("2500"), ws.customers["Acme Ltd"]!.address!), "settled");
    const p = await paymentFor(ws, r.observationId!);
    expect(p.status).toBe("overpaid");
    expect((await inv(ws, i.id)).status).toBe("overpaid");
    const [e] = await q(ws, "SELECT * FROM exceptions WHERE payment_id = $1", [p.id]);
    expect(e.type).toBe("overpayment");
    expect(e.detail).toContain("$500.00 more than requested");
  });
});

describe("unknown payment and operator resolution", () => {
  it("never guesses, then lets an operator assign it while preserving the original decision", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Studio Ten", "740.00");
    await invoice(ws, "Acme Ltd", "740.00"); // same amount → ambiguous for an unknown sender
    const sender = randomAddress();
    const r = await ingest(ws, transfer(ws, usd("740"), sender), "settled");
    const p = await paymentFor(ws, r.observationId!);
    expect(p.status).toBe("needs_review");
    const [e] = await q(ws, "SELECT * FROM exceptions WHERE payment_id = $1", [p.id]);
    expect(e.type).toBe("ambiguous_match");
    expect(e.candidates).toHaveLength(2);

    await withTenant(ws.orgId, (c) => resolveException(c, ws.orgId, e.id, { action: "assign", invoice_id: i.id, reason: "Customer confirmed by email", remember_sender: true }, ws.actor));

    expect((await paymentFor(ws, r.observationId!)).status).toBe("matched");
    expect((await inv(ws, i.id)).status).toBe("paid");
    expect(await events(ws, p.id)).toEqual(["PAYMENT_OBSERVED", "UNKNOWN_PAYMENT", "PAYMENT_MATCHED"]);
    const [res] = await q(ws, "SELECT * FROM resolutions WHERE exception_id = $1", [e.id]);
    expect(res).toMatchObject({ action: "assign", reason: "Customer confirmed by email", actor_type: "user", rule_version: "manual-v1.0" });
    expect(res.previous_state.payment_status).toBe("needs_review");
    expect(res.new_state.payment_status).toBe("matched");
    const [learned] = await q(ws, "SELECT * FROM customer_addresses WHERE address = $1", [sender]);
    expect(learned.source).toBe("resolution");
    // The original automatic decision is still on record.
    const decisions = await q(ws, "SELECT outcome FROM match_decisions WHERE payment_id = $1 AND stage = 'final'", [p.id]);
    expect(decisions.map((d) => d.outcome)).toEqual(["needs_review"]);
    // Resolutions can't be edited after the fact.
    await expect(q(ws, "UPDATE resolutions SET reason = 'changed' WHERE id = $1", [res.id])).rejects.toThrow(/append-only/);
  });

  it("rejects resolutions that don't fit the exception type and double resolution", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "100.00");
    const r = await ingest(ws, transfer(ws, usd("100"), randomAddress(), { tokenAddress: randomAddress() }), "settled");
    const p = await paymentFor(ws, r.observationId!);
    const [e] = await q(ws, "SELECT * FROM exceptions WHERE payment_id = $1", [p.id]);
    expect(e.type).toBe("wrong_token");
    await expect(withTenant(ws.orgId, (c) => resolveException(c, ws.orgId, e.id, { action: "assign", invoice_id: i.id, reason: "please", remember_sender: false }, ws.actor))).rejects.toThrow(/can be resolved with/);
    await withTenant(ws.orgId, (c) => resolveException(c, ws.orgId, e.id, { action: "dismiss", reason: "Returned to sender", remember_sender: false }, ws.actor));
    expect((await paymentFor(ws, r.observationId!)).status).toBe("dismissed");
    expect((await inv(ws, i.id)).status).toBe("open");
    await expect(withTenant(ws.orgId, (c) => resolveException(c, ws.orgId, e.id, { action: "dismiss", reason: "again", remember_sender: false }, ws.actor))).rejects.toThrow(/already been resolved/);
  });

  it("writes off the remainder of a partial payment", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "1000.00");
    const r = await ingest(ws, transfer(ws, usd("990"), ws.customers["Acme Ltd"]!.address!), "settled");
    const p = await paymentFor(ws, r.observationId!);
    const [e] = await q(ws, "SELECT * FROM exceptions WHERE payment_id = $1", [p.id]);
    await withTenant(ws.orgId, (c) => resolveException(c, ws.orgId, e.id, { action: "write_off", reason: "Bank fee absorbed", remember_sender: false }, ws.actor));
    const after = await inv(ws, i.id);
    expect(after.status).toBe("paid");
    expect(after.amount_written_off).toBe(usd("10").toString());
  });
});

describe("finality and reorgs", () => {
  it("drops a tip observation that never settles, without any economic effect", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    const r = await ingest(ws, transfer(ws, usd("2000"), randomAddress()), "tip");
    await withTenant(ws.orgId, (c) => dropObservation(c, r.observationId!, "Not included in the settled chain"));
    const p = await paymentFor(ws, r.observationId!);
    expect(p.status).toBe("reversed");
    expect(await events(ws, p.id)).toEqual(["PAYMENT_OBSERVED", "PAYMENT_REVERSED"]);
    expect((await inv(ws, i.id)).status).toBe("open");
    const [{ count }] = await q(ws, "SELECT count(*)::int AS count FROM allocations");
    expect(count).toBe(0);
  });

  it("compensates a settled payment when its block is reorganized away, then matches the re-included payment", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    const original = transfer(ws, usd("2000"), randomAddress());
    const r = await ingest(ws, original, "settled");
    const p = await paymentFor(ws, r.observationId!);
    expect((await inv(ws, i.id)).status).toBe("paid");

    await withTenant(ws.orgId, (c) => reversePayment(c, p.id, "Chain reorganization at block 1"));
    expect((await inv(ws, i.id)).status).toBe("open");
    expect((await inv(ws, i.id)).amount_paid).toBe("0");
    const allocations = await q(ws, "SELECT amount, kind FROM allocations WHERE payment_id = $1 ORDER BY created_at", [p.id]);
    expect(allocations.map((a) => a.kind)).toEqual(["automatic", "reversal"]);
    expect(await events(ws, p.id)).toEqual(["PAYMENT_OBSERVED", "PAYMENT_MATCHED", "PAYMENT_REVERSED"]);
    const [rev] = await q(ws, "SELECT data, reverses_event_id FROM financial_events WHERE payment_id = $1 AND type = 'PAYMENT_REVERSED'", [p.id]);
    expect(rev.reverses_event_id).toBeTruthy();
    expect(rev.data.reversal.economic_effect_reversed).toBe(true);
    const [obs] = await q(ws, "SELECT canonical, confirmation_state FROM source_observations WHERE id = $1", [r.observationId]);
    expect(obs).toEqual({ canonical: false, confirmation_state: "dropped" });
    const [ex] = await q(ws, "SELECT type FROM exceptions WHERE payment_id = $1 AND type = 'reversal'", [p.id]);
    expect(ex).toBeTruthy();

    // Same transaction re-included in a new block: a new observation and a new decision.
    const reincluded = await ingest(ws, { ...original, blockHash: `0x${"ab".repeat(32)}`, blockNumber: original.blockNumber + 1n }, "settled");
    expect(reincluded.observationId).not.toBe(r.observationId);
    expect((await inv(ws, i.id)).status).toBe("paid");
  });
});

describe("database guarantees", () => {
  it("rejects edits to evidence and financial history", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "1.00");
    const r = await ingest(ws, transfer(ws, usd("1"), randomAddress()), "settled");
    await expect(q(ws, "UPDATE source_observations SET amount = 999 WHERE id = $1", [r.observationId])).rejects.toThrow(/immutable/);
    await expect(q(ws, "DELETE FROM source_observations WHERE id = $1", [r.observationId])).rejects.toThrow(/cannot be deleted/);
    await expect(q(ws, "UPDATE financial_events SET amount = 1")).rejects.toThrow(/append-only/);
    await expect(q(ws, "DELETE FROM allocations")).rejects.toThrow(/append-only/);
    await expect(q(ws, "UPDATE audit_logs SET action = 'x'")).rejects.toThrow(/append-only/);
  });

  it("isolates tenants with row-level security even when a query forgets its filter", async () => {
    const a = await workspace();
    const b = await workspace();
    await invoice(a, "Acme Ltd", "10.00");
    await invoice(b, "Acme Ltd", "20.00");
    const seenByA = await q(a, "SELECT organization_id FROM invoices");
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((r) => r.organization_id === a.orgId)).toBe(true);
    await expect(q(a, "INSERT INTO customers (id, organization_id, environment, name) VALUES ('cus_x', $1, 'test', 'Intruder')", [b.orgId])).rejects.toThrow(/row-level security/);
    const direct = await pool().query("SELECT count(*)::int AS count FROM invoices"); // no tenant context at all
    expect(direct.rows[0].count).toBe(0);
  });

  it("the application role is not a superuser (RLS is actually enforced)", async () => {
    const r = await pool().query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
