import { afterAll, describe, expect, it } from "vitest";
import { closePools, withTenant } from "../../../packages/database/src";
import { apiKey, call, server, setupWorkspace, signup, type Session } from "./helpers";

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const auth = (s: Session) => ({ cookie: s.cookie });
const setRole = (s: Session, role: string) => withTenant(s.orgId, (c) => c.query("UPDATE organization_members SET role = $2 WHERE organization_id = $1", [s.orgId, role]));
const account = async (s: Session, code: string) => (await call("GET", "/v1/accounting/accounts", auth(s))).data.data.find((a: any) => a.code === code);

describe("accounting API", () => {
  it("supports books-first onboarding without wallets, customers or invoices", async () => {
    const s = await signup("Books-only business");
    expect((await call("PATCH", "/v1/organization", auth(s), { onboarding_completed: true })).statusCode).toBe(200);
    expect((await call("GET", "/v1/me", auth(s))).data.organization.onboarding_completed).toBe(true);
    for (const path of ["wallets", "customers", "invoices"]) {
      expect((await call("GET", `/v1/${path}`, auth(s))).data.data).toHaveLength(0);
    }
    const report = await call("GET", "/v1/accounting/reports/trial-balance", auth(s));
    expect(report.statusCode).toBe(200);
    expect(report.data.totals).toMatchObject({ debit: "0.00", credit: "0.00", balanced: true });
  });
  it("builds the books from payments: invoice → payment → reports that agree", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const inv = (await call("POST", "/v1/invoices", auth(s), { customer_id: acme.id, title: "Platform fee", amount: "1200.00" })).data;
    await call("POST", "/v1/test/payments", auth(s), { invoice_id: inv.id, scenario: "exact" });
    await call("POST", "/v1/test/payments", auth(s), { scenario: "unknown", amount: "50.00" });

    const pl = await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s));
    expect(pl.statusCode).toBe(200);
    expect(pl.data.revenue.total).toBe("1200.00");
    const bs = (await call("GET", "/v1/accounting/reports/balance-sheet", auth(s))).data;
    expect(bs.balanced).toBe(true);
    expect(bs.assets.total).toBe("1250.00");
    expect(bs.liabilities.accounts.find((a: any) => a.name === "Payments to Identify").amount).toBe("50.00");
    const tb = (await call("GET", "/v1/accounting/reports/trial-balance", auth(s))).data;
    expect(tb.totals.balanced).toBe(true);
    const cf = (await call("GET", "/v1/accounting/reports/cash-flow", auth(s))).data;
    expect(cf.reconciles).toBe(true);
    expect(cf.net_change).toBe("1250.00");
    const health = (await call("GET", "/v1/accounting/health", auth(s))).data;
    expect(health.checks.find((c: any) => c.key === "missing_entries").status).toBe("ok");
    expect(health.checks.find((c: any) => c.key === "receivables").status).toBe("ok");
    expect(health.checks.find((c: any) => c.key === "payments_to_identify").status).toBe("attention");

    // Drill down: revenue account → ledger line → journal entry → payment.
    const sales = await account(s, "4000");
    expect(sales.balance).toBe("1200.00");
    const gl = (await call("GET", `/v1/accounting/ledger?account_id=${sales.id}`, auth(s))).data;
    expect(gl.lines).toHaveLength(1);
    const entries = (await call("GET", "/v1/accounting/journal-entries?source_type=payment", auth(s))).data.data;
    const apply = entries.find((e: any) => e.description.startsWith("Applied"));
    const detail = (await call("GET", `/v1/accounting/journal-entries/${apply?.id ?? entries[0].id}`, auth(s))).data;
    expect(detail.totals.balanced).toBe(true);
    expect(detail.source.link).toMatch(/^\/app\/payments\//);
    expect(detail.lines.some((l: any) => l.payment?.transaction_hash)).toBe(true);

    const csv = await call("GET", "/v1/accounting/reports/profit-and-loss?format=csv", auth(s));
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body).toContain("Net income");
  });

  it("every export is named for and headed with the business it belongs to; import files keep their exact layout", async () => {
    const s = await signup("Café Nova & Sons");
    const report = await call("GET", "/v1/accounting/reports/profit-and-loss?from=2026-08-01&to=2026-08-31&format=csv", auth(s));
    expect(report.headers["content-disposition"]).toBe('attachment; filename="cafe-nova-sons-profit-and-loss-2026-08-01-to-2026-08-31-test.csv"');
    const lines = report.body.replace(/^﻿/, "").split("\r\n");
    expect(report.body.startsWith("﻿")).toBe(true);
    expect(lines.slice(0, 3)).toEqual(["Café Nova & Sons", "Profit and loss", "Period,2026-08-01 to 2026-08-31"]);
    expect(lines).toContain("Mode,Test mode: Monad testnet and simulated payments");
    expect(lines.find((l: string) => l.startsWith("Generated,"))).toContain(s.email);
    expect(lines).toContain("section,code,account,amount");

    const quickbooks = await call("GET", "/v1/accounting/exports/journal?format=quickbooks&from=2026-08-01&to=2026-08-31", auth(s));
    expect(quickbooks.headers["content-disposition"]).toBe('attachment; filename="cafe-nova-sons-journal-quickbooks-2026-08-01-to-2026-08-31-test.csv"');
    expect(quickbooks.body.split("\r\n")[0]).toBe("Journal No,Journal Date,Account,Debits,Credits,Description,Name");

    const payments = await call("GET", "/v1/exports/payments.csv", auth(s));
    expect(payments.headers["content-disposition"]).toMatch(/^attachment; filename="cafe-nova-sons-payments-\d{4}-\d{2}-\d{2}-test\.csv"$/);
    expect(payments.body.split("\r\n")[0]).toMatch(/^payment_id,date,status/);
  });

  it("manual journal entries: drafts, posting, immutability and reversal", async () => {
    const s = await signup();
    const bank = await account(s, "1030");
    const equity = await account(s, "3000");
    const bad = await call("POST", "/v1/accounting/journal-entries", auth(s), { date: new Date().toISOString().slice(0, 10), description: "Uneven", post: true, lines: [{ account_id: bank.id, debit: "10.00" }, { account_id: equity.id, credit: "9.00" }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.data.error.message).toContain("10.00");

    const draft = await call("POST", "/v1/accounting/journal-entries", auth(s), { date: new Date().toISOString().slice(0, 10), description: "Owner contribution", lines: [{ account_id: bank.id, debit: "2500.00" }, { account_id: equity.id, credit: "2500.00" }] });
    expect(draft.statusCode).toBe(201);
    expect(draft.data.status).toBe("draft");
    expect((await account(s, "1030")).balance).toBe("0.00");
    const posted = await call("POST", `/v1/accounting/journal-entries/${draft.data.id}/post`, auth(s));
    expect(posted.data.status).toBe("posted");
    expect((await account(s, "1030")).balance).toBe("2500.00");
    const edit = await call("PATCH", `/v1/accounting/journal-entries/${draft.data.id}`, auth(s), { description: "Changed" });
    expect(edit.statusCode).toBe(409);
    const rev = await call("POST", `/v1/accounting/journal-entries/${draft.data.id}/reverse`, auth(s), { reason: "Recorded twice" });
    expect(rev.statusCode).toBe(200);
    expect(rev.data.reverses.id).toBe(draft.data.id);
    expect((await account(s, "1030")).balance).toBe("0.00");
  });

  it("permissions: developers don't see the books; operators draft but can't post; keys can't approve", async () => {
    const s = await signup();
    const bank = await account(s, "1030");
    const equity = await account(s, "3000");
    const entry = { date: new Date().toISOString().slice(0, 10), description: "Test", lines: [{ account_id: bank.id, debit: "1.00" }, { account_id: equity.id, credit: "1.00" }] };

    const key = await apiKey(s);
    expect((await call("GET", "/v1/accounting/reports/trial-balance", { key })).statusCode).toBe(200);
    expect((await call("POST", "/v1/accounting/journal-entries", { key }, { ...entry, post: true })).statusCode).toBe(403);
    const keyDraft = await call("POST", "/v1/accounting/journal-entries", { key }, entry);
    expect(keyDraft.statusCode).toBe(201);
    expect((await call("POST", `/v1/accounting/journal-entries/${keyDraft.data.id}/post`, { key })).statusCode).toBe(403);

    await setRole(s, "operator");
    expect((await call("POST", "/v1/accounting/journal-entries", auth(s), entry)).statusCode).toBe(201);
    expect((await call("POST", "/v1/accounting/journal-entries", auth(s), { ...entry, post: true })).statusCode).toBe(403);
    expect((await call("POST", "/v1/accounting/periods/close", auth(s), { month: "2026-01" })).statusCode).toBe(403);

    await setRole(s, "developer");
    expect((await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s))).statusCode).toBe(403);
    expect((await call("GET", "/v1/vendors", auth(s))).statusCode).toBe(403);

    await setRole(s, "viewer");
    expect((await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s))).statusCode).toBe(200);
    expect((await call("POST", "/v1/vendors", auth(s), { name: "X" })).statusCode).toBe(403);
  });

  it("payables: vendor → bill → approve → pay, with aging and events", async () => {
    const s = await signup();
    const vendor = (await call("POST", "/v1/vendors", auth(s), { name: "Northwind Hosting", email: "billing@northwind.test" })).data;
    const hosting = await account(s, "6020");
    const bill = await call("POST", "/v1/bills", auth(s), { vendor_id: vendor.id, number: "NW-88", title: "September hosting", amount: "420.00", account_id: hosting.id, bill_date: new Date().toISOString().slice(0, 10) });
    expect(bill.statusCode).toBe(201);
    expect(bill.data.status).toBe("draft");
    expect((await call("POST", `/v1/bills/${bill.data.id}/pay`, auth(s), { paid_from_account_id: (await account(s, "1030")).id })).statusCode).toBe(409);
    const approved = await call("POST", `/v1/bills/${bill.data.id}/approve`, auth(s));
    expect(approved.data.status).toBe("approved");
    expect(approved.data.journal_entries).toHaveLength(1);
    let aging = (await call("GET", "/v1/accounting/reports/payables-aging", auth(s))).data;
    expect(aging.ledger_check.matches).toBe(true);
    expect(aging.bills).toHaveLength(1);
    const paid = await call("POST", `/v1/bills/${bill.data.id}/pay`, auth(s), { paid_from_account_id: (await account(s, "1030")).id });
    expect(paid.data.status).toBe("paid");
    expect(paid.data.payments).toHaveLength(1);
    aging = (await call("GET", "/v1/accounting/reports/payables-aging", auth(s))).data;
    expect(aging.bills).toHaveLength(0);
    const v = (await call("GET", `/v1/vendors/${vendor.id}`, auth(s))).data;
    expect(v.owed).toBe("0.00");
    const events = (await call("GET", "/v1/financial-events?type=payable.settled", auth(s))).data.data;
    expect(events).toHaveLength(1);
    expect(events[0].vendor.name).toBe("Northwind Hosting");
    expect((await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s))).data.operating_expenses.total).toBe("420.00");
  });

  it("periods: close, block manual posting, reopen with a reason", async () => {
    const s = await signup();
    const now = new Date();
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10));
    const month = last.toISOString().slice(0, 7);
    expect((await call("POST", "/v1/accounting/periods/close", auth(s), { month: now.toISOString().slice(0, 7) })).statusCode).toBe(409);
    expect((await call("POST", "/v1/accounting/periods/close", auth(s), { month })).statusCode).toBe(200);
    const bank = await account(s, "1030");
    const equity = await account(s, "3000");
    const r = await call("POST", "/v1/accounting/journal-entries", auth(s), { date: last.toISOString().slice(0, 10), description: "Late", post: true, lines: [{ account_id: bank.id, debit: "1.00" }, { account_id: equity.id, credit: "1.00" }] });
    expect(r.statusCode).toBe(409);
    expect(r.data.error.code).toBe("period_closed");
    const periods = (await call("GET", "/v1/accounting/periods", auth(s))).data.data;
    expect(periods.find((p: any) => p.month === month).status).toBe("closed");
    expect((await call("POST", "/v1/accounting/periods/reopen", auth(s), { month, reason: "Late invoice from supplier" })).data.status).toBe("open");
  });

  it("Seti answers from the books, analyzes changes, and records a bill only after confirmation", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const inv = (await call("POST", "/v1/invoices", auth(s), { customer_id: acme.id, title: "Platform fee", amount: "900.00" })).data;
    await call("POST", "/v1/test/payments", auth(s), { invoice_id: inv.id, scenario: "exact" });
    const seti = async (text: string) => (await call("POST", "/v1/assistant/messages", auth(s), { text, timezone: "Africa/Lagos" })).data.message.blocks as any[];

    const profit = (await seti("How much profit did we make this month?")).find((b) => b.type === "summary");
    expect(profit.highlight).toEqual({ label: "Net income", value: "$900.00" });
    expect(profit.rows).toContainEqual(["Revenue", "$900.00"]);
    const cash = (await seti("How much cash do we have?")).find((b) => b.type === "summary");
    expect(cash.highlight.value).toBe("$900.00");
    const why = await seti("Why is profit different from last month?");
    expect(why[0].text).toMatch(/Net income is \$900\.00 higher/);
    expect((await seti("Are the books in order?"))[0]).toMatchObject({ type: "notice", tone: "success" });

    // Creating: a confirmation card first; nothing exists until confirmed.
    const blocks = await seti("Record a bill from Northwind Hosting #NW-7 for $120 hosting, due in 14 days");
    const confirm = blocks.find((b) => b.type === "confirm");
    expect(confirm.rows).toContainEqual(["Vendor", "Northwind Hosting (new vendor)"]);
    expect(confirm.rows).toContainEqual(["Account", "6020 Software"]);
    expect((await call("GET", "/v1/bills?status=all", auth(s))).data.data).toHaveLength(0);
    const done = (await call("POST", `/v1/assistant/actions/${confirm.actionId}`, auth(s), { decision: "confirm" })).data.message.blocks;
    expect(done[0].title).toBe("Bill NW-7 approved. It's now a payable.");
    const again = (await call("POST", `/v1/assistant/actions/${confirm.actionId}`, auth(s), { decision: "confirm" })).data.message.blocks;
    expect(again[0].title).toBe(done[0].title);
    expect((await call("GET", "/v1/bills?status=all", auth(s))).data.data).toHaveLength(1);
    const owed = (await seti("What do we owe vendors?")).find((b) => b.type === "summary");
    expect(owed.highlight).toEqual({ label: "Total owed", value: "$120.00" });

    // Roles: a developer can't see the books through Seti either.
    await setRole(s, "developer");
    expect((await seti("How much profit did we make this month?"))[0]).toMatchObject({ type: "notice", title: "Your role can't see the books." });
  });

  it("counterparty intelligence: off by default, needs a key, explains exchange senders, and caches", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const unknown = (await call("POST", "/v1/test/payments", auth(s), { scenario: "unknown", amount: "740.00" })).data;
    const lookup = async () => (await call("GET", `/v1/payments/${unknown.id}/counterparty`, auth(s))).data;
    expect((await lookup()).status).toBe("disabled");
    await call("PATCH", "/v1/organization", auth(s), { counterparty_intel_enabled: true });
    const saved = process.env.NANSEN_API_KEY;
    delete process.env.NANSEN_API_KEY;
    expect((await lookup()).status).toBe("not_configured");
    process.env.NANSEN_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.nansen.ai")) {
        calls += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.chain).toBe("monad");
        expect((init?.headers as Record<string, string>).apikey).toBe("test-key");
        return new Response(JSON.stringify({ pagination: { page: 1, per_page: 50, is_last_page: true }, data: [{ label: "Binance: Hot Wallet", category: "cex", kind: ["entity"] }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(url as never, init);
    }) as typeof fetch;
    try {
      const first = await lookup();
      expect(first).toMatchObject({ status: "ok", kind: "exchange", mainnetLabelsForTestnet: true, cached: false });
      expect(first.summary).toMatch(/exchange/);
      expect(first.suggestion).toMatch(/Don't save this address/);
      expect((await lookup()).cached).toBe(true);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.NANSEN_API_KEY;
      else process.env.NANSEN_API_KEY = saved;
    }
  });
});
