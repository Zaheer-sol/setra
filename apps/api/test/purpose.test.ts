import { afterAll, describe, expect, it } from "vitest";
import { closePools } from "../../../packages/database/src";
import { call, server, setupWorkspace, signup, type Session } from "./helpers";

/**
 * Payment purpose: "what is this payment for?" must be defined by the merchant, shown to the payer,
 * carried onto every payment applied to the invoice, and exposed identically by the API, webhooks
 * and exports. Payments with no established business context stay honestly unknown.
 */

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const TITLE = "September Infrastructure Services";
const PURPOSE = "Cloud architecture, deployment and monitoring";
const ITEMS = [
  { description: "Cloud architecture", unit_amount: "1200.00" },
  { description: "Deployment", unit_amount: "500.00" },
  { description: "Monitoring", unit_amount: "300.00" }
];

async function flagship(s: Session, customerId: string, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/v1/invoices", { cookie: s.cookie }, { customer_id: customerId, title: TITLE, purpose: PURPOSE, line_items: ITEMS, ...extra });
  expect(res.statusCode).toBe(201);
  return res.data;
}

async function endpoint(s: Session) {
  return (await call("POST", "/v1/webhook-endpoints", { cookie: s.cookie }, { url: "http://127.0.0.1:9/hook", event_types: ["payment.matched", "payment.partially_paid", "payment.overpaid", "payment.unknown"] })).data;
}

/** Minimal RFC 4180 parser for assertions (quoted cells may contain commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\r") continue;
    else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else cell += ch;
  }
  return rows;
}

/** Deliveries with their payload snapshots (the list omits payloads; the detail includes them). */
async function deliveries(s: Session): Promise<any[]> {
  const list = (await call("GET", "/v1/webhook-deliveries?limit=100", { cookie: s.cookie })).data.data as any[];
  return Promise.all(list.map(async (d) => (await call("GET", `/v1/webhook-deliveries/${d.id}`, { cookie: s.cookie })).data));
}

describe("defining purpose", () => {
  it("stores title, purpose and exact line items; the amount is their total", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const inv = await flagship(s, acme.id);
    expect(inv).toMatchObject({ title: TITLE, purpose: PURPOSE, amount_due: "2000.00" });
    expect(inv.line_items).toEqual([
      { description: "Cloud architecture", quantity: 1, unit_amount: "1200.00", amount: "1200.00" },
      { description: "Deployment", quantity: 1, unit_amount: "500.00", amount: "500.00" },
      { description: "Monitoring", quantity: 1, unit_amount: "300.00", amount: "300.00" }
    ]);
    const again = await call("GET", `/v1/invoices/${inv.id}`, { cookie: s.cookie });
    expect(again.data).toMatchObject({ title: TITLE, purpose: PURPOSE });
    expect(again.data.line_items).toHaveLength(3);
  });

  it("multiplies quantity exactly (no floating point) and rejects items that don't add up", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const auth = { cookie: s.cookie };
    const ok = await call("POST", "/v1/invoices", auth, { customer_id: acme.id, title: "Support", line_items: [{ description: "Hours", quantity: 3, unit_amount: "0.10" }] });
    expect(ok.statusCode).toBe(201);
    expect(ok.data.amount_due).toBe("0.30");
    expect(ok.data.line_items[0]).toMatchObject({ quantity: 3, unit_amount: "0.10", amount: "0.30" });

    const mismatch = await call("POST", "/v1/invoices", auth, { customer_id: acme.id, title: "Support", amount: "2000.00", line_items: [{ description: "Hours", unit_amount: "1999.99" }] });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.data.error.code).toBe("line_items_mismatch");
    expect(mismatch.data.error.message).toContain("1999.99");
  });

  it("requires the merchant to say what the payment is for", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const res = await call("POST", "/v1/invoices", { cookie: s.cookie }, { customer_id: acme.id, amount: "10.00" });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.data)).toContain("title");
  });

  it("shows the payer what they are paying for before they pay", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const inv = await flagship(s, acme.id);
    const token = inv.payment_url.split("/pay/")[1];
    const view = await call("GET", `/v1/public/payment-requests/${token}`, null);
    expect(view.data.state).toBe("awaiting_payment");
    expect(view.data.invoice).toMatchObject({ title: TITLE, purpose: PURPOSE, amount_due: "2000.00" });
    expect(view.data.invoice.line_items.map((l: any) => [l.description, l.amount])).toEqual([
      ["Cloud architecture", "1200.00"],
      ["Deployment", "500.00"],
      ["Monitoring", "300.00"]
    ]);
  });
});

describe("purpose follows the money", () => {
  it("a matched payment inherits purpose in the API, the webhook and the export", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    await endpoint(s);
    const inv = await flagship(s, acme.id);
    const paid = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: inv.id })).data;

    expect(paid.status).toBe("matched");
    expect(paid.business_object).toEqual({ type: "invoice", id: inv.id, number: inv.number, title: TITLE, purpose: PURPOSE });
    expect(paid.purpose_status).toBe("known");
    expect(paid.context_source).toBe("automatic_match");
    expect(paid.invoice_detail.line_items).toHaveLength(3);

    const listed = (await call("GET", "/v1/payments", { cookie: s.cookie })).data.data[0];
    expect(listed.business_object.title).toBe(TITLE);

    const matched = (await deliveries(s)).find((d) => d.event_type === "payment.matched");
    expect(matched.payload.data.invoice).toMatchObject({ number: inv.number, title: TITLE, purpose: PURPOSE });
    expect(matched.payload.data.purpose_status).toBe("known");
    expect(matched.payload.data.context_source).toBe("automatic_match");
    expect(matched.payload.data.customer.name).toBe("Acme Ltd");

    const [cols, values] = parseCsv((await call("GET", "/v1/exports/payments.csv", { cookie: s.cookie })).body);
    expect(values![cols!.indexOf("invoice_title")]).toBe(TITLE);
    expect(values![cols!.indexOf("purpose")]).toBe(PURPOSE);
    expect(values![cols!.indexOf("purpose_status")]).toBe("known");
    expect(values![cols!.indexOf("context_source")]).toBe("automatic_match");

    const rec = (await call("GET", "/v1/exports/reconciliation.csv", { cookie: s.cookie })).body;
    expect(rec).toContain(TITLE);
  });

  it("partial and overpayments keep the purpose of the invoice they were applied to", async () => {
    const s = await signup();
    const { acme, studio } = await setupWorkspace(s);
    const partialInv = await flagship(s, acme.id);
    const partial = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "partial", invoice_id: partialInv.id, amount: "500.00" })).data;
    expect(partial.status).toBe("partial");
    expect(partial.business_object.title).toBe(TITLE);
    expect(partial.purpose_status).toBe("known");

    const overInv = await flagship(s, studio.id, { title: "August Infrastructure Services" });
    const over = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "overpaid", invoice_id: overInv.id, amount: "2500.00" })).data;
    expect(over.status).toBe("overpaid");
    expect(over.business_object.title).toBe("August Infrastructure Services");
  });

  it("a confirming payment shows its provisional purpose, and never as final", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const inv = await flagship(s, acme.id);
    const confirming = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: inv.id, finalize: false })).data;
    expect(confirming.status).toBe("confirming");
    expect(confirming.purpose_status).toBe("provisional");
    expect(confirming.business_object.title).toBe(TITLE);
    expect(confirming.invoice).toBeNull();
    expect(confirming.context_source).toBeNull();
    expect((await call("GET", `/v1/invoices/${inv.id}`, { cookie: s.cookie })).data.status).toBe("open");

    const confirmed = (await call("POST", `/v1/test/payments/${confirming.id}/confirm`, { cookie: s.cookie })).data;
    expect(confirmed.status).toBe("matched");
    expect(confirmed.purpose_status).toBe("known");
  });

  it("customer history answers what this customer has paid for", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const sept = await flagship(s, acme.id);
    const aug = await flagship(s, acme.id, { title: "August Infrastructure Services", line_items: undefined, amount: "1800.00" });
    await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: sept.id });
    await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: aug.id });
    const history = (await call("GET", `/v1/payments?customer_id=${acme.id}`, { cookie: s.cookie })).data.data;
    expect(history.map((p: any) => [p.business_object.title, p.amount, p.status])).toEqual([
      ["August Infrastructure Services", "1800.00", "matched"],
      [TITLE, "2000.00", "matched"]
    ]);
  });

  it("search finds payments by what they were for", async () => {
    const s = await signup();
    const { acme, nova } = await setupWorkspace(s);
    const inv = await flagship(s, acme.id);
    const other = await call("POST", "/v1/invoices", { cookie: s.cookie }, { customer_id: nova.id, title: "Brand refresh", amount: "740.00" });
    const p = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: inv.id })).data;
    await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: other.data.id });
    const search = async (q: string) => (await call("GET", `/v1/payments?search=${encodeURIComponent(q)}`, { cookie: s.cookie })).data.data.map((x: any) => x.id);
    expect(await search("infrastructure")).toEqual([p.id]);
    expect(await search("deployment and monitoring")).toEqual([p.id]);
    expect(await search(p.id)).toEqual([p.id]);
    expect(await search(inv.number)).toEqual([p.id]);
    expect(await search("Acme")).toEqual([p.id]);
    expect((await call("GET", `/v1/invoices?search=infrastructure`, { cookie: s.cookie })).data.data.map((i: any) => i.id)).toEqual([inv.id]);
  });
});

describe("unknown stays unknown", () => {
  it("an unmatched payment has no purpose anywhere, until an operator establishes it; history is kept", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    await endpoint(s);
    const inv = await flagship(s, acme.id, { line_items: undefined, amount: "2000.00" });
    const unknown = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "unknown", amount: "740.00" })).data;

    expect(unknown.status).toBe("needs_review");
    expect(unknown.business_object).toBeNull();
    expect(unknown.purpose_status).toBe("unknown");
    expect(unknown.context_source).toBeNull();
    const hook = (await deliveries(s)).find((d) => d.event_type === "payment.unknown");
    expect(hook.payload.data.invoice).toBeNull();
    expect(hook.payload.data.purpose_status).toBe("unknown");
    const rec = parseCsv((await call("GET", "/v1/exports/reconciliation.csv", { cookie: s.cookie })).body);
    const unapplied = rec.find((r) => r[0] === "unapplied_payment")!;
    expect(unapplied[rec[0]!.indexOf("purpose")]).toBe("Unknown");
    expect(unapplied[rec[0]!.indexOf("invoice_title")]).toBe("");

    const exc = unknown.exceptions[0];
    const resolved = await call("POST", `/v1/exceptions/${exc.id}/resolve`, { cookie: s.cookie }, { action: "assign", invoice_id: inv.id, reason: "Acme confirmed by email" });
    expect(resolved.statusCode).toBe(200);

    const after = (await call("GET", `/v1/payments/${unknown.id}`, { cookie: s.cookie })).data;
    expect(after.business_object).toMatchObject({ id: inv.id, title: TITLE });
    expect(after.purpose_status).toBe("known");
    expect(after.context_source).toBe("manual_resolution");
    // Initially unknown → manually resolved → context established. Both steps remain.
    expect(after.context_history.map((h: any) => [h.kind, h.outcome])).toEqual([
      ["provisional_decision", "needs_review"],
      ["decision", "needs_review"],
      ["resolution", "assign"]
    ]);
    expect(after.context_history[0].invoice).toBeNull();
    expect(after.context_history[1].invoice).toBeNull();
    expect(after.context_history[2]).toMatchObject({ invoice: { id: inv.id, title: TITLE }, summary: "Acme confirmed by email" });
    expect(after.decisions[0].outcome).toBe("needs_review");
  });

  it("a duplicate names what it duplicates but creates no second paid state", async () => {
    const s = await signup();
    const { acme, acmeAddress } = await setupWorkspace(s);
    const inv = await flagship(s, acme.id, { line_items: undefined, amount: "2.00" });
    const first = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: inv.id, from_address: acmeAddress })).data;
    const second = (await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "exact", invoice_id: inv.id, from_address: acmeAddress })).data;

    expect(first.status).toBe("matched");
    expect(second.status).toBe("needs_review");
    expect(second.business_object).toBeNull();
    expect(second.purpose_status).toBe("unknown");
    const exc = (await call("GET", `/v1/exceptions/${second.exceptions[0].id}`, { cookie: s.cookie })).data;
    expect(exc.type).toBe("duplicate_payment");
    expect(exc.candidates[0]).toMatchObject({ invoice_id: inv.id, title: TITLE });
    expect(exc.duplicate_of).toEqual([
      expect.objectContaining({ payment_id: first.id, amount: "2.00", invoice: { id: inv.id, number: inv.number, title: TITLE, customer_name: "Acme Ltd" } })
    ]);
    const invoice = (await call("GET", `/v1/invoices/${inv.id}`, { cookie: s.cookie })).data;
    expect(invoice).toMatchObject({ status: "paid", amount_paid: "2.00" });
    expect(invoice.allocations).toHaveLength(1);
  });

  it("purpose is tenant-isolated", async () => {
    const a = await signup();
    const b = await signup();
    const { acme } = await setupWorkspace(a);
    await setupWorkspace(b);
    const inv = await flagship(a, acme.id);
    await call("POST", "/v1/test/payments", { cookie: a.cookie }, { scenario: "exact", invoice_id: inv.id });
    const found = (await call("GET", "/v1/payments?search=infrastructure", { cookie: b.cookie })).data.data;
    expect(found).toHaveLength(0);
    expect((await call("GET", `/v1/invoices/${inv.id}`, { cookie: b.cookie })).statusCode).toBe(404);
  });
});
