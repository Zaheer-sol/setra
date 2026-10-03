import { afterAll, describe, expect, it } from "vitest";
import { closePools } from "../../../packages/database/src";
import { apiKey, call, randomAddress, server, setupWorkspace, signup, type Session } from "./helpers";

/**
 * A month of books from orders sent by the merchant's own system: the summary agrees with the reports
 * it is built from, unexplained money never becomes revenue, and the close checklist says what still
 * needs a decision.
 */

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const auth = (s: Session) => ({ cookie: s.cookie });
const thisMonth = () => new Date().toISOString().slice(0, 7);
const account = async (s: Session, code: string) => (await call("GET", "/v1/accounting/accounts", auth(s))).data.data.find((a: any) => a.code === code);

describe("the month", () => {
  it("summarises the month from the ledger and lists what blocks a trustworthy close", async () => {
    const s = await signup();
    const { wallet, acme, acmeAddress } = await setupWorkspace(s);
    const key = await apiKey(s);
    // Orders from the merchant's system: one paid exactly, one paid in part by the known customer.
    const o1 = (await call("POST", "/v1/orders", { key }, { external_id: "M-1", amount: "1000.00", customer_id: acme.id })).data.invoice;
    const o2 = (await call("POST", "/v1/orders", { key }, { external_id: "M-2", amount: "400.00", customer_id: acme.id })).data.invoice;
    expect((await call("POST", "/v1/test/payments", auth(s), { scenario: "exact", invoice_id: o1.id })).data.status).toBe("matched");
    expect((await call("POST", "/v1/test/payments", auth(s), { scenario: "partial", invoice_id: o2.id, from_address: acmeAddress })).data.status).toBe("partial");
    // Money nobody explained.
    const unknown = (await call("POST", "/v1/test/payments", auth(s), { scenario: "unknown", amount: "500.00", from_address: randomAddress(), wallet_id: wallet.id })).data;
    expect(unknown.status).toBe("needs_review");

    const m = (await call("GET", `/v1/accounting/periods/${thisMonth()}/summary`, auth(s))).data;
    const pl = (await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s))).data;
    const ar = (await call("GET", "/v1/accounting/reports/receivables-aging", auth(s))).data;
    // The summary is the reports, not a second calculation.
    expect(m.summary.revenue).toBe(pl.revenue.total);
    expect(m.summary.receivables).toBe(ar.total);
    // Revenue is the two orders (accrual), never the 500 nobody explained: 1,400 billed, 1,800 received.
    expect(m.summary.revenue).toBe("1400.00");
    expect(m.summary.stablecoin_received).toEqual([{ asset: "USDC", amount: "1800.00", count: 3 }]);
    expect(m.summary.unidentified_receipts).toEqual({ count: 1, amount: "500.00" });
    expect(m.summary.open_exceptions).toBeGreaterThanOrEqual(2); // the partial follow-up and the unknown payment
    expect(Number(m.summary.receivables)).toBe(100); // 400 billed, 300 paid
    // The month hasn't ended, so it can't be closed yet, and the checklist says why and what to fix.
    expect(m.ended).toBe(false);
    expect(m.can_close).toBe(false);
    const status = Object.fromEntries(m.checks.map((c: any) => [c.key, c.status]));
    expect(status).toMatchObject({ ended: "blocking", identified: "attention", exceptions: "attention", trial_balance: "ok", receivables: "ok", payables: "ok", drafts: "ok" });
  });

  it("classifies unexplained money as a loan or an owner's contribution, never as revenue", async () => {
    const s = await signup();
    const { wallet } = await setupWorkspace(s);
    const loan = await account(s, "2300");
    const owner = await account(s, "3000");
    expect(loan).toMatchObject({ name: "Loans Payable", type: "liability" });
    expect(await account(s, "2030")).toMatchObject({ name: "Customer Deposits", type: "liability" });
    const a = (await call("POST", "/v1/test/payments", auth(s), { scenario: "unknown", amount: "10000.00", from_address: randomAddress(), wallet_id: wallet.id })).data;
    const b = (await call("POST", "/v1/test/payments", auth(s), { scenario: "unknown", amount: "5000.00", from_address: randomAddress(), wallet_id: wallet.id })).data;
    expect((await call("POST", "/v1/accounting/classifications", auth(s), { payment_id: a.id, account_id: loan.id, reason: "Loan from the bank, agreement 2026-14" })).statusCode).toBe(201);
    expect((await call("POST", "/v1/accounting/classifications", auth(s), { payment_id: b.id, account_id: owner.id, reason: "Owner put money in" })).statusCode).toBe(201);
    const bs = (await call("GET", "/v1/accounting/reports/balance-sheet", auth(s))).data;
    expect(bs.balanced).toBe(true);
    const tb = (await call("GET", "/v1/accounting/reports/trial-balance", auth(s))).data;
    const credit = (code: string) => tb.accounts.find((x: any) => x.code === code)?.credit_balance;
    expect(credit("2300")).toBe("10000.00");
    expect(credit("3000")).toBe("5000.00");
    expect((await call("GET", "/v1/accounting/reports/profit-and-loss", auth(s))).data.revenue.total).toBe("0.00");
    const m = (await call("GET", `/v1/accounting/periods/${thisMonth()}/summary`, auth(s))).data;
    expect(m.summary.unidentified_receipts.count).toBe(0);
    expect(m.checks.find((c: any) => c.key === "identified").status).toBe("ok");
  });

  it("an ended month with nothing pending can be closed; a future month is refused", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const past = (await call("GET", "/v1/accounting/periods/2026-01/summary", auth(s))).data;
    expect(past).toMatchObject({ ended: true, status: "open", can_close: true });
    expect((await call("POST", "/v1/accounting/periods/close", auth(s), { month: "2026-01" })).statusCode).toBeLessThan(300);
    expect((await call("GET", "/v1/accounting/periods/2026-01/summary", auth(s))).data).toMatchObject({ status: "closed", can_close: false });
    expect((await call("GET", "/v1/accounting/periods/2099-01/summary", auth(s))).statusCode).toBe(422);
  });
});
