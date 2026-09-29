import { ensureBooks, applyCustomerCredit, autoMatchStatement, closeYear, completeReconciliation, createCreditNote, createEntryForStatementLine, importStatement, reconciliationStatus, recordNetworkFee, repairBooks, setOpeningBalances, setRate, statementLines, undoClassification, undoCustomerCredit } from "../src";
import { afterAll, describe, expect, it } from "vitest";
import { closePools, withTenant, type Client } from "../../database/src";
import {
  approveExpense,
  balanceSheet,
  cancelInvoice,
  cashFlow,
  classifyTransaction,
  closePeriod,
  correctPayment,
  createBill,
  createExpense,
  createManualEntry,
  createVendor,
  createWallet,
  generalLedger,
  ingestObservation,
  payablesAging,
  payBill,
  postManualEntry,
  profitAndLoss,
  receivablesAging,
  recordOutgoingTransfer,
  recordRefund,
  reopenPeriod,
  resolveException,
  reverseEntry,
  reversePayment,
  setAccountingMethod,
  systemAccount,
  trialBalance,
  voidBill
} from "../src";
import { invoice, MONAD_TESTNET_USDC, randomAddress, randomHash, transfer, usd, workspace, type Workspace } from "../../../test/fixtures";

afterAll(closePools);

const START = "2000-01-01";
const END = "2100-12-31";

const q = (ws: Workspace, sql: string, params: unknown[] = []) => withTenant(ws.orgId, (c: Client) => c.query(sql, params)).then((r) => r.rows);
const t = <T>(ws: Workspace, fn: (c: Client) => Promise<T>) => withTenant(ws.orgId, fn);
const ingest = (ws: Workspace, obs: ReturnType<typeof transfer>, stage: "tip" | "settled" = "settled") => t(ws, (c) => ingestObservation(c, ws.wallet, obs, stage));
const paymentFor = async (ws: Workspace, observationId: string) => (await q(ws, "SELECT * FROM payments WHERE observation_id = $1", [observationId]))[0]!;

/** Balance of a system account in natural sign (positive = its normal side), in dollars. */
async function bal(ws: Workspace, key: Parameters<typeof systemAccount>[3]): Promise<string> {
  const a = await t(ws, (c) => systemAccount(c, ws.orgId, "test", key));
  return balOf(ws, a.id);
}
async function balOf(ws: Workspace, accountId: string): Promise<string> {
  const [r] = await q(ws, "SELECT a.normal_balance, COALESCE(sum(l.debit - l.credit), 0)::text AS s FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' WHERE a.id = $1 AND (l.id IS NULL OR e.id IS NOT NULL) GROUP BY a.normal_balance", [accountId]);
  const raw = BigInt(r.s) * (r.normal_balance === "debit" ? 1n : -1n);
  return (Number(raw) / 1e6).toFixed(2);
}
async function walletBal(ws: Workspace): Promise<string> {
  const [a] = await q(ws, "SELECT id FROM ledger_accounts WHERE wallet_id = $1", [ws.wallet.id]);
  return a ? balOf(ws, a.id) : "0.00";
}
const entriesFor = (ws: Workspace, like: string) => q(ws, "SELECT * FROM journal_entries WHERE source_key LIKE $1 ORDER BY number", [like]);

/** The invariants every set of books must satisfy, whatever happened. */
async function assertBooksHold(ws: Workspace) {
  const tb = await t(ws, (c) => trialBalance(c, ws.orgId, "test", END));
  expect(tb.totals.balanced).toBe(true);
  const bs = await t(ws, (c) => balanceSheet(c, ws.orgId, "test", END));
  expect(bs.balanced).toBe(true);
  const [unbalanced] = await q(
    ws,
    "SELECT count(*)::int AS n FROM (SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.status = 'posted' GROUP BY e.id HAVING sum(l.debit) <> sum(l.credit)) x"
  );
  expect(unbalanced.n).toBe(0);
  const issues = await q(ws, "SELECT message FROM accounting_issues WHERE resolved_at IS NULL");
  expect(issues).toEqual([]);
}

function outgoing(ws: Workspace, amount: bigint, to = randomAddress(), at = new Date()) {
  return {
    chainId: ws.wallet.chain_id,
    blockNumber: 9_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
    blockHash: randomHash(),
    transactionHash: randomHash(),
    transactionIndex: 0,
    logIndex: 0,
    tokenAddress: MONAD_TESTNET_USDC,
    toAddress: to,
    amount,
    blockTimestamp: at
  };
}
const sendOut = (ws: Workspace, amount: bigint, to?: string, at?: Date) => t(ws, async (c) => (await recordOutgoingTransfer(c, { id: ws.wallet.id, organization_id: ws.orgId, environment: "test" }, outgoing(ws, amount, to, at)))!);

describe("chart of accounts", () => {
  it("seeds a standard chart once per workspace and mode, and protects system accounts", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "10.00");
    const accounts = await q(ws, "SELECT code, system_key FROM ledger_accounts WHERE environment = 'test' ORDER BY code");
    expect(accounts.map((a) => a.code)).toEqual(expect.arrayContaining(["1100", "2010", "2050", "4000", "6000"]));
    expect(accounts.filter((a) => a.system_key === "accounts_receivable")).toHaveLength(1);
    const ar = await t(ws, (c) => systemAccount(c, ws.orgId, "test", "accounts_receivable"));
    await expect(q(ws, "UPDATE ledger_accounts SET type = 'expense' WHERE id = $1", [ar.id])).rejects.toThrow();
    await expect(q(ws, "UPDATE ledger_accounts SET archived_at = now() WHERE id = $1", [ar.id])).rejects.toThrow();
    await expect(q(ws, "DELETE FROM ledger_accounts WHERE id = $1", [ar.id])).rejects.toThrow();
  });
});

describe("journal integrity", () => {
  it("rejects unbalanced entries, freezes posted entries, and corrects only by reversal", async () => {
    const ws = await workspace();
    const [bank, equity] = await t(ws, async (c) => [await systemAccount(c, ws.orgId, "test", "bank"), await systemAccount(c, ws.orgId, "test", "owner_equity")]);
    await expect(
      t(ws, (c) => createManualEntry(c, { organizationId: ws.orgId, environment: "test", date: new Date(), description: "Lopsided", actor: ws.actor, post: true, lines: [{ accountId: bank.id, debit: usd("100") }, { accountId: equity.id, credit: usd("90") }] }))
    ).rejects.toMatchObject({ code: "unbalanced_entry" });

    const entry = await t(ws, (c) =>
      createManualEntry(c, { organizationId: ws.orgId, environment: "test", date: new Date(), description: "Owner funded the bank account", actor: ws.actor, post: true, lines: [{ accountId: bank.id, debit: usd("5000") }, { accountId: equity.id, credit: usd("5000") }] })
    );
    expect(entry.status).toBe("posted");
    expect(entry.number).toMatch(/^JE-\d{5}$/);
    // The database itself refuses to change or delete a posted entry, whatever the application does.
    await expect(q(ws, "UPDATE journal_lines SET debit = 1 WHERE entry_id = $1 AND debit > 0", [entry.id])).rejects.toThrow();
    await expect(q(ws, "UPDATE journal_entries SET description = 'edited' WHERE id = $1", [entry.id])).rejects.toThrow();
    await expect(q(ws, "DELETE FROM journal_entries WHERE id = $1", [entry.id])).rejects.toThrow();

    const { entry: reversal } = await t(ws, (c) => reverseEntry(c, ws.orgId, "test", entry.id, { reason: "Recorded in the wrong mode", actor: ws.actor }));
    expect(reversal.reverses_entry_id).toBe(entry.id);
    await expect(t(ws, (c) => reverseEntry(c, ws.orgId, "test", entry.id, { reason: "again", actor: ws.actor }))).rejects.toMatchObject({ code: "already_reversed" });
    expect(await bal(ws, "bank")).toBe("0.00");
    const events = await q(ws, "SELECT type FROM financial_events WHERE journal_entry_id IS NOT NULL ORDER BY id");
    expect(events.map((e) => e.type)).toEqual(["JOURNAL_ENTRY_POSTED", "JOURNAL_ENTRY_REVERSED"]);
    await assertBooksHold(ws);
  });

  it("the database refuses to post an unbalanced entry even if the application skipped its checks", async () => {
    const ws = await workspace();
    const bank = await t(ws, (c) => systemAccount(c, ws.orgId, "test", "bank"));
    const entry = await t(ws, (c) => createManualEntry(c, { organizationId: ws.orgId, environment: "test", date: new Date(), description: "Draft", actor: ws.actor, lines: [{ accountId: bank.id, debit: usd("1") }, { accountId: bank.id, credit: usd("1") }] }));
    await q(ws, "UPDATE journal_lines SET credit = 2000000 WHERE entry_id = $1 AND credit > 0", [entry.id]);
    await expect(q(ws, "UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [entry.id])).rejects.toThrow(/balance/i);
  });
});

describe("accounting periods", () => {
  it("blocks manual posting into a closed month and moves automatic postings to the next open date", async () => {
    const ws = await workspace();
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const month = lastMonth.toISOString().slice(0, 7);
    await t(ws, (c) => closePeriod(c, ws.orgId, "test", month, ws.actor));
    const [bank, equity] = await t(ws, async (c) => [await systemAccount(c, ws.orgId, "test", "bank"), await systemAccount(c, ws.orgId, "test", "owner_equity")]);
    const draft = await t(ws, (c) => createManualEntry(c, { organizationId: ws.orgId, environment: "test", date: lastMonth, description: "Late adjustment", actor: ws.actor, lines: [{ accountId: bank.id, debit: usd("10") }, { accountId: equity.id, credit: usd("10") }] }));
    await expect(t(ws, (c) => postManualEntry(c, ws.orgId, "test", draft.id, ws.actor))).rejects.toMatchObject({ code: "period_closed" });

    // A payment observed with last month's timestamp still lands in the books, dated into the open period.
    const r = await ingest(ws, transfer(ws, usd("75"), randomAddress(), { blockTimestamp: lastMonth }));
    const p = await paymentFor(ws, r.observationId!);
    const [receipt] = await entriesFor(ws, `pay-receipt:${p.id}`);
    expect(receipt.status).toBe("posted");
    expect(receipt.entry_date.slice(0, 7)).not.toBe(month);
    expect(receipt.original_date).toBe(lastMonth.toISOString().slice(0, 10));

    await t(ws, (c) => reopenPeriod(c, ws.orgId, "test", month, "Auditor adjustment", ws.actor));
    const posted = await t(ws, (c) => postManualEntry(c, ws.orgId, "test", draft.id, ws.actor));
    expect(posted.status).toBe("posted");
    const audit = await q(ws, "SELECT action FROM audit_logs WHERE object_type = 'accounting_period' ORDER BY created_at");
    expect(audit.map((a) => a.action)).toEqual(["period_closed", "period_reopened"]);
    await assertBooksHold(ws);
  });
});

describe("payments to journal entries (accrual)", () => {
  it("exact payment: receivable on issue, receipt then application on payment", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "2000.00");
    expect(await bal(ws, "accounts_receivable")).toBe("2000.00");
    expect(await bal(ws, "sales")).toBe("2000.00");
    const obs = transfer(ws, usd("2000"), randomAddress());
    const r = await ingest(ws, obs, "tip");
    // Detection at the tip has no accounting effect.
    expect(await walletBal(ws)).toBe("0.00");
    await ingest(ws, obs, "settled");
    const p = await paymentFor(ws, r.observationId!);
    expect(p.status).toBe("matched");
    expect(await walletBal(ws)).toBe("2000.00");
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    expect(await bal(ws, "payments_to_identify")).toBe("0.00");
    const pl = await t(ws, (c) => profitAndLoss(c, ws.orgId, "test", START, END));
    expect(pl.revenue.total).toBe("2000.00");
    const lines = await q(ws, "SELECT l.* FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_key = $1", [`pay-apply:${(await q(ws, "SELECT id FROM allocations WHERE payment_id = $1", [p.id]))[0]!.id}`]);
    expect(lines.every((l) => l.invoice_id === i.id && l.payment_id === p.id)).toBe(true);
    await assertBooksHold(ws);
  });

  it("duplicate source facts never duplicate entries", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "500.00");
    const obs = transfer(ws, usd("500"), randomAddress());
    await ingest(ws, obs, "tip");
    await ingest(ws, obs, "settled");
    await ingest(ws, obs, "settled");
    const [{ n }] = await q(ws, "SELECT count(*)::int AS n FROM journal_entries WHERE source_key LIKE 'pay-%'");
    expect(n).toBe(2); // one receipt, one application
    expect(await walletBal(ws)).toBe("500.00");
    await assertBooksHold(ws);
  });

  it("unknown payment is held in Payments to Identify, never revenue, until classified", async () => {
    const ws = await workspace();
    const r = await ingest(ws, transfer(ws, usd("300"), randomAddress()));
    const p = await paymentFor(ws, r.observationId!);
    expect(p.status).toBe("needs_review");
    expect(await bal(ws, "payments_to_identify")).toBe("300.00");
    expect((await t(ws, (c) => profitAndLoss(c, ws.orgId, "test", START, END))).revenue.total).toBe("0.00");
    const equity = await t(ws, (c) => systemAccount(c, ws.orgId, "test", "owner_equity"));
    await t(ws, (c) => classifyTransaction(c, ws.orgId, "test", { payment_id: p.id, account_id: equity.id, reason: "Founder topped up the wallet" }, ws.actor));
    expect(await bal(ws, "payments_to_identify")).toBe("0.00");
    expect(await bal(ws, "owner_equity")).toBe("300.00");
    await expect(t(ws, (c) => classifyTransaction(c, ws.orgId, "test", { payment_id: p.id, account_id: equity.id, reason: "again" }, ws.actor))).rejects.toThrow();
    await assertBooksHold(ws);
  });

  it("partial payments reduce the receivable; a write-off moves the rest to bad debt", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "1000.00");
    const r = await ingest(ws, transfer(ws, usd("990"), ws.customers["Acme Ltd"]!.address!));
    const p = await paymentFor(ws, r.observationId!);
    expect(await bal(ws, "accounts_receivable")).toBe("10.00");
    const [e] = await q(ws, "SELECT * FROM exceptions WHERE payment_id = $1", [p.id]);
    await t(ws, (c) => resolveException(c, ws.orgId, e.id, { action: "write_off", reason: "Bank fee absorbed", remember_sender: false }, ws.actor));
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    expect(await bal(ws, "bad_debt")).toBe("10.00");
    const aging = await t(ws, (c) => receivablesAging(c, ws.orgId, "test", END));
    expect(aging.ledger_check.matches).toBe(true);
    await assertBooksHold(ws);
  });

  it("overpayment: the excess is a customer credit; refunding it clears the credit and the wallet", async () => {
    const ws = await workspace();
    await invoice(ws, "Nova Systems", "1000.00");
    const r = await ingest(ws, transfer(ws, usd("1200"), ws.customers["Nova Systems"]!.address!));
    const p = await paymentFor(ws, r.observationId!);
    expect(p.status).toBe("overpaid");
    expect(await bal(ws, "customer_credits")).toBe("200.00");
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    expect((await t(ws, (c) => profitAndLoss(c, ws.orgId, "test", START, END))).revenue.total).toBe("1000.00");

    const out = await sendOut(ws, usd("200"), p.from_address);
    expect(await bal(ws, "transfers_to_classify")).toBe("200.00");
    await t(ws, (c) => recordRefund(c, ws.orgId, p.id, { outgoing_transfer_id: out, reason: "Returned the overpayment" }, ws.actor));
    expect(await bal(ws, "customer_credits")).toBe("0.00");
    expect(await bal(ws, "transfers_to_classify")).toBe("0.00");
    expect(await walletBal(ws)).toBe("1000.00");
    const cf = await t(ws, (c) => cashFlow(c, ws.orgId, "test", START, END));
    expect(cf.reconciles).toBe(true);
    await assertBooksHold(ws);
  });

  it("taking a payment off an invoice reverses the application, and the receivable comes back", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "400.00");
    const r = await ingest(ws, transfer(ws, usd("400"), ws.customers["Acme Ltd"]!.address!));
    const p = await paymentFor(ws, r.observationId!);
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    await t(ws, (c) => correctPayment(c, ws.orgId, p.id, { action: "unassign", reason: "Wrong customer" }, ws.actor));
    expect(await bal(ws, "accounts_receivable")).toBe("400.00");
    expect(await bal(ws, "payments_to_identify")).toBe("400.00");
    expect(await walletBal(ws)).toBe("400.00");
    await assertBooksHold(ws);
  });

  it("a reversed (reorged) payment has every entry reversed; the originals stay on record", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "250.00");
    const r = await ingest(ws, transfer(ws, usd("250"), ws.customers["Acme Ltd"]!.address!));
    const p = await paymentFor(ws, r.observationId!);
    await t(ws, (c) => reversePayment(c, p.id, "Chain reorganized"));
    expect(await walletBal(ws)).toBe("0.00");
    expect(await bal(ws, "accounts_receivable")).toBe("250.00");
    const all = await q(ws, "SELECT source_key, reverses_entry_id, status FROM journal_entries WHERE source_key LIKE 'pay-%' ORDER BY number");
    expect(all.filter((e) => e.reverses_entry_id).length).toBe(2);
    expect(all.every((e) => e.status === "posted")).toBe(true);
    await assertBooksHold(ws);
  });

  it("cancelling an issued invoice reverses its receivable", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Studio Ten", "90.00");
    await t(ws, (c) => cancelInvoice(c, ws.orgId, i.id, "Duplicate", ws.actor));
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    expect(await bal(ws, "sales")).toBe("0.00");
    await assertBooksHold(ws);
  });

  it("money moved between two of your own wallets is an internal transfer, not income or spending", async () => {
    const ws = await workspace();
    const second = await t(ws, (c) => createWallet(c, ws.orgId, "test", { name: "Treasury", network: "monad", address: randomAddress(), assets: ["USDC"] }, ws.actor));
    await ingest(ws, transfer(ws, usd("100"), second.address));
    expect(await bal(ws, "payments_to_identify")).toBe("0.00");
    expect(await bal(ws, "transfers_to_classify")).toBe("-100.00");
    // The matching outgoing transfer from the treasury wallet clears it.
    await t(ws, (c) => recordOutgoingTransfer(c, { id: second.id, organization_id: ws.orgId, environment: "test" }, { ...outgoing(ws, usd("100"), ws.wallet.address) }));
    expect(await bal(ws, "transfers_to_classify")).toBe("0.00");
    const cf = await t(ws, (c) => cashFlow(c, ws.orgId, "test", START, END));
    expect(cf.net_change).toBe("0.00");
    await assertBooksHold(ws);
  });
});

describe("cash basis", () => {
  it("recognizes revenue when paid, not when invoiced", async () => {
    const ws = await workspace();
    await t(ws, (c) => setAccountingMethod(c, ws.orgId, "test", "cash", ws.actor));
    await invoice(ws, "Acme Ltd", "600.00");
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    await ingest(ws, transfer(ws, usd("600"), ws.customers["Acme Ltd"]!.address!));
    expect(await bal(ws, "sales")).toBe("600.00");
    await expect(t(ws, (c) => setAccountingMethod(c, ws.orgId, "test", "accrual", ws.actor))).rejects.toMatchObject({ code: "books_in_use" });
    await assertBooksHold(ws);
  });
});

describe("payables and expenses", () => {
  it("bill: approved becomes a payable; paying it off-chain settles it; aging agrees with the ledger", async () => {
    const ws = await workspace();
    const vendor = await t(ws, (c) => createVendor(c, ws.orgId, "test", { name: "Figma" }, ws.actor));
    const draft = await t(ws, (c) => createBill(c, ws.orgId, "test", { vendor_id: vendor.id, number: "F-1001", title: "Design seats", amount: "300.00", bill_date: new Date().toISOString().slice(0, 10) }, ws.actor));
    expect(await bal(ws, "accounts_payable")).toBe("0.00");
    const { approveBill } = await import("../src");
    await t(ws, (c) => approveBill(c, ws.orgId, "test", draft.id, ws.actor));
    expect(await bal(ws, "accounts_payable")).toBe("300.00");
    expect(await bal(ws, "general_expense")).toBe("300.00");
    let aging = await t(ws, (c) => payablesAging(c, ws.orgId, "test", END));
    expect(aging.ledger_check.matches).toBe(true);

    const bank = await t(ws, (c) => systemAccount(c, ws.orgId, "test", "bank"));
    await expect(t(ws, (c) => payBill(c, ws.orgId, "test", draft.id, { paid_from_account_id: bank.id, amount: "400.00" }, ws.actor))).rejects.toMatchObject({ code: "overpays_bill" });
    await t(ws, (c) => payBill(c, ws.orgId, "test", draft.id, { paid_from_account_id: bank.id, amount: "100.00" }, ws.actor));
    const bill = await t(ws, (c) => payBill(c, ws.orgId, "test", draft.id, { paid_from_account_id: bank.id }, ws.actor));
    expect(bill.status).toBe("paid");
    expect(await bal(ws, "accounts_payable")).toBe("0.00");
    expect(await bal(ws, "bank")).toBe("-300.00");
    await expect(t(ws, (c) => voidBill(c, ws.orgId, "test", draft.id, "oops", ws.actor))).rejects.toMatchObject({ code: "bill_not_voidable" });
    aging = await t(ws, (c) => payablesAging(c, ws.orgId, "test", END));
    expect(aging.ledger_check.matches).toBe(true);
    const events = await q(ws, "SELECT type FROM financial_events WHERE vendor_id = $1 ORDER BY id", [vendor.id]);
    expect(events.map((e) => e.type)).toEqual(["PAYABLE_CREATED", "PAYABLE_SETTLED", "PAYABLE_SETTLED"]);
    await assertBooksHold(ws);
  });

  it("bill paid onchain: the outgoing transfer is the proof, and it can't be used twice", async () => {
    const ws = await workspace();
    await ingest(ws, transfer(ws, usd("1000"), randomAddress()));
    const vendor = await t(ws, (c) => createVendor(c, ws.orgId, "test", { name: "Contractor Ana" }, ws.actor));
    const bill = await t(ws, (c) => createBill(c, ws.orgId, "test", { vendor_id: vendor.id, number: "A-7", title: "September work", amount: "800.00", bill_date: new Date().toISOString().slice(0, 10), approve: true }, ws.actor));
    const out = await sendOut(ws, usd("800"));
    await t(ws, (c) => payBill(c, ws.orgId, "test", bill.id, { outgoing_transfer_id: out }, ws.actor));
    expect(await bal(ws, "transfers_to_classify")).toBe("0.00");
    expect(await walletBal(ws)).toBe("200.00");
    const bill2 = await t(ws, (c) => createBill(c, ws.orgId, "test", { vendor_id: vendor.id, number: "A-8", title: "October work", amount: "800.00", bill_date: new Date().toISOString().slice(0, 10), approve: true }, ws.actor));
    await expect(t(ws, (c) => payBill(c, ws.orgId, "test", bill2.id, { outgoing_transfer_id: out }, ws.actor))).rejects.toMatchObject({ code: "transfer_already_used" });
    await assertBooksHold(ws);
  });

  it("expense paid from the wallet: pending has no effect; approving it classifies the transfer", async () => {
    const ws = await workspace();
    await ingest(ws, transfer(ws, usd("500"), randomAddress()));
    const out = await sendOut(ws, usd("49"));
    const [software] = await q(ws, "SELECT id FROM ledger_accounts WHERE code = '6020' AND environment = 'test'");
    const x = await t(ws, (c) => createExpense(c, ws.orgId, "test", { title: "Vercel Pro", account_id: software.id, outgoing_transfer_id: out }, ws.actor));
    expect(x.status).toBe("pending");
    expect(await balOf(ws, software.id)).toBe("0.00");
    await t(ws, (c) => approveExpense(c, ws.orgId, "test", x.id, ws.actor));
    expect(await balOf(ws, software.id)).toBe("49.00");
    expect(await bal(ws, "transfers_to_classify")).toBe("0.00");
    const pl = await t(ws, (c) => profitAndLoss(c, ws.orgId, "test", START, END));
    expect(pl.operating_expenses.total).toBe("49.00");
    const gl = await t(ws, (c) => generalLedger(c, ws.orgId, "test", { accountId: software.id }));
    expect(gl.lines).toHaveLength(1);
    await assertBooksHold(ws);
  });
});

describe("isolation", () => {
  it("one workspace never sees another's books", async () => {
    const a = await workspace();
    const b = await workspace();
    await invoice(a, "Acme Ltd", "10.00");
    const seen = await q(b, "SELECT count(*)::int AS n FROM journal_entries");
    expect(seen[0]!.n).toBe(0);
    const aAr = await t(a, (c) => systemAccount(c, a.orgId, "test", "accounts_receivable"));
    await expect(t(b, (c) => generalLedger(c, b.orgId, "test", { accountId: aAr.id }))).rejects.toThrow();
  });
});

// ── Accounting gaps ─────────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
const acct = async (ws: Workspace, code: string) => (await q(ws, "SELECT * FROM ledger_accounts WHERE code = $1 AND environment = 'test'", [code]))[0]!;

describe("opening balances", () => {
  it("balances against Opening Balance Equity, replaces cleanly, and refuses receivables", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "1.00");
    const bank = await acct(ws, "1030");
    await t(ws, (c) => setOpeningBalances(c, ws.orgId, "test", { date: daysAgo(30), lines: [{ account_id: bank.id, amount: "5000.00" }] }, ws.actor));
    expect(await bal(ws, "bank")).toBe("5000.00");
    expect(await bal(ws, "opening_balance_equity")).toBe("5000.00");
    await t(ws, (c) => setOpeningBalances(c, ws.orgId, "test", { date: daysAgo(30), lines: [{ account_id: bank.id, amount: "6000.00" }] }, ws.actor));
    expect(await bal(ws, "bank")).toBe("6000.00");
    const ar = await acct(ws, "1100");
    await expect(t(ws, (c) => setOpeningBalances(c, ws.orgId, "test", { date: daysAgo(30), lines: [{ account_id: ar.id, amount: "10.00" }] }, ws.actor))).rejects.toMatchObject({ code: "invalid_account" });
    await assertBooksHold(ws);
  });
});

describe("bank reconciliation", () => {
  it("imports a statement once, auto-matches, creates missing entries, and reconciles to the statement balance", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "1.00");
    const bank = await acct(ws, "1030");
    await t(ws, (c) => setOpeningBalances(c, ws.orgId, "test", { date: daysAgo(10), lines: [{ account_id: bank.id, amount: "1000.00" }] }, ws.actor));
    const vendor = await t(ws, (c) => createVendor(c, ws.orgId, "test", { name: "Northwind" }, ws.actor));
    const bill = await t(ws, (c) => createBill(c, ws.orgId, "test", { vendor_id: vendor.id, number: "N-1", title: "Hosting", amount: "300.00", bill_date: daysAgo(5), approve: true }, ws.actor));
    await t(ws, (c) => payBill(c, ws.orgId, "test", bill.id, { paid_from_account_id: bank.id, paid_on: daysAgo(4) }, ws.actor));
    const csv = `Date,Details,Amount,Ref\n${daysAgo(10)},Opening transfer,"1,000.00",A1\n${daysAgo(3)},NORTHWIND HOSTING,-300.00,A2\n${daysAgo(2)},Monthly account fee,(15.00),A3\n`;
    const mapping = { date: "Date", description: "Details", amount: "Amount", reference: "Ref" };
    const first = await t(ws, (c) => importStatement(c, ws.orgId, "test", { account_id: bank.id, csv, mapping, date_format: "YYYY-MM-DD" }, ws.actor));
    expect(first).toMatchObject({ imported: 3, skipped: 0, errors: [] });
    expect((await t(ws, (c) => importStatement(c, ws.orgId, "test", { account_id: bank.id, csv, mapping, date_format: "YYYY-MM-DD" }, ws.actor))).skipped).toBe(3);
    expect((await t(ws, (c) => autoMatchStatement(c, ws.orgId, "test", bank.id, ws.actor))).matched).toBe(2);
    const fee = (await t(ws, (c) => statementLines(c, ws.orgId, "test", bank.id, { status: "unmatched" })))[0]!;
    expect(fee.amount).toBe("-15.00");
    const fees = await acct(ws, "6050");
    await t(ws, (c) => createEntryForStatementLine(c, ws.orgId, "test", fee.id, { account_id: fees.id }, ws.actor));
    const status = await t(ws, (c) => reconciliationStatus(c, ws.orgId, "test", bank.id, daysAgo(0), "685.00"));
    expect(status).toMatchObject({ ledger_balance: "685.00", adjusted_balance: "685.00", difference: "0.00", unmatched_statement_lines: 0, can_complete: true });
    await expect(t(ws, (c) => completeReconciliation(c, ws.orgId, "test", bank.id, daysAgo(0), "700.00", ws.actor))).rejects.toMatchObject({ code: "not_reconciled" });
    const done = await t(ws, (c) => completeReconciliation(c, ws.orgId, "test", bank.id, daysAgo(0), "685.00", ws.actor));
    expect(done.reconciled_through).toBe(daysAgo(0));
    await assertBooksHold(ws);
  });
});

describe("network fees", () => {
  it("waits for a rate instead of guessing a token price, then posts once a rate exists", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "1.00");
    const id = await t(ws, (c) => recordNetworkFee(c, { organizationId: ws.orgId, environment: "test", walletId: ws.wallet.id, chainId: ws.wallet.chain_id, transactionHash: randomHash(), nativeSymbol: "MON", feeNative: 10n ** 18n, paidByWallet: true, blockTimestamp: new Date() }));
    expect(id).toBeTruthy();
    expect(await bal(ws, "network_fees")).toBe("0.00");
    const [issue] = await q(ws, "SELECT message FROM accounting_issues WHERE resolved_at IS NULL");
    expect(issue.message).toMatch(/No MON to USD rate/);
    await t(ws, (c) => setRate(c, ws.orgId, { base: "MON", rate_date: daysAgo(1), rate: "0.5" }, ws.actor));
    await t(ws, (c) => repairBooks(c, ws.orgId, "test", ws.actor));
    expect(await bal(ws, "network_fees")).toBe("0.50");
    const [gas] = await q(ws, "SELECT * FROM ledger_accounts WHERE native_symbol = 'MON'");
    expect(await balOf(ws, gas.id)).toBe("-0.50");
    const [line] = await q(ws, "SELECT rate_source FROM journal_lines WHERE account_id = $1", [gas.id]);
    expect(line.rate_source).toBe(`manual:MON/USD@0.500000000000000000:${daysAgo(1)}`);
    await assertBooksHold(ws);
  });
});

describe("customer credits and credit notes", () => {
  it("applies an overpayment to another invoice, undoes it, and withdraws it if the payment is reversed", async () => {
    const ws = await workspace();
    await invoice(ws, "Nova Systems", "1000.00");
    const r = await ingest(ws, transfer(ws, usd("1200"), ws.customers["Nova Systems"]!.address!));
    const p = await paymentFor(ws, r.observationId!);
    const b = await invoice(ws, "Nova Systems", "150.00");
    const app = await t(ws, (c) => applyCustomerCredit(c, ws.orgId, "test", { payment_id: p.id, invoice_id: b.id }, ws.actor));
    expect(app.amount).toBe(usd("150").toString());
    expect((await q(ws, "SELECT status FROM invoices WHERE id = $1", [b.id]))[0]!.status).toBe("paid");
    expect(await bal(ws, "customer_credits")).toBe("50.00");
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    const other = await invoice(ws, "Acme Ltd", "10.00");
    await expect(t(ws, (c) => applyCustomerCredit(c, ws.orgId, "test", { payment_id: p.id, invoice_id: other.id }, ws.actor))).rejects.toMatchObject({ code: "different_customer" });
    await expect(t(ws, (c) => correctPayment(c, ws.orgId, p.id, { action: "unassign", reason: "test" }, ws.actor))).rejects.toMatchObject({ code: "payment_credit_applied" });
    await t(ws, (c) => undoCustomerCredit(c, ws.orgId, "test", app.id, "Applied by mistake", ws.actor));
    expect((await q(ws, "SELECT status FROM invoices WHERE id = $1", [b.id]))[0]!.status).toBe("open");
    expect(await bal(ws, "customer_credits")).toBe("200.00");
    await t(ws, (c) => applyCustomerCredit(c, ws.orgId, "test", { payment_id: p.id, invoice_id: b.id, amount: "100.00" }, ws.actor));
    await t(ws, (c) => reversePayment(c, p.id, "Chain reorganized"));
    expect((await q(ws, "SELECT status, amount_paid FROM invoices WHERE id = $1", [b.id]))[0]).toMatchObject({ status: "open", amount_paid: "0" });
    expect(await bal(ws, "customer_credits")).toBe("0.00");
    await assertBooksHold(ws);
  });

  it("a credit note lowers what's owed and revenue, keeps the original total, and can't exceed what's owed", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "500.00");
    await expect(t(ws, (c) => createCreditNote(c, ws.orgId, "test", { invoice_id: i.id, amount: "600.00", reason: "Too much" }, ws.actor))).rejects.toMatchObject({ code: "exceeds_owed" });
    const cn = await t(ws, (c) => createCreditNote(c, ws.orgId, "test", { invoice_id: i.id, amount: "100.00", reason: "Discount agreed" }, ws.actor));
    expect(cn.number).toMatch(/^CN-\d{5}$/);
    expect((await q(ws, "SELECT amount_due, amount_credited FROM invoices WHERE id = $1", [i.id]))[0]).toMatchObject({ amount_due: usd("400").toString(), amount_credited: usd("100").toString() });
    expect(await bal(ws, "accounts_receivable")).toBe("400.00");
    expect((await t(ws, (c) => profitAndLoss(c, ws.orgId, "test", START, END))).revenue.total).toBe("400.00");
    await ingest(ws, transfer(ws, usd("400"), ws.customers["Acme Ltd"]!.address!));
    expect((await q(ws, "SELECT status FROM invoices WHERE id = $1", [i.id]))[0]!.status).toBe("paid");
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    await assertBooksHold(ws);
  });

  it("cancelling a credit-noted invoice clears its receivable", async () => {
    const ws = await workspace();
    const i = await invoice(ws, "Acme Ltd", "500.00");
    await t(ws, (c) => createCreditNote(c, ws.orgId, "test", { invoice_id: i.id, amount: "50.00", reason: "Discount" }, ws.actor));
    await t(ws, (c) => cancelInvoice(c, ws.orgId, i.id, "Deal fell through", ws.actor));
    expect(await bal(ws, "accounts_receivable")).toBe("0.00");
    expect(await bal(ws, "refunds")).toBe("0.00");
    await assertBooksHold(ws);
  });
});

describe("year-end close", () => {
  it("moves the year's result to retained earnings, keeps the year's P&L readable, and re-closes after adjustments", async () => {
    const ws = await workspace();
    const year = new Date().getUTCFullYear() - 1;
    await t(ws, (c) => ensureBooks(c, ws.orgId, "test"));
    const [bank, sales, software] = await Promise.all([acct(ws, "1030"), acct(ws, "4000"), acct(ws, "6020")]);
    const post = (date: string, lines: any[], description: string) => t(ws, (c) => createManualEntry(c, { organizationId: ws.orgId, environment: "test", date, description, actor: ws.actor, post: true, lines }));
    await post(`${year}-06-01`, [{ accountId: bank.id, debit: usd("1000") }, { accountId: sales.id, credit: usd("1000") }], "Sale");
    await post(`${year}-07-01`, [{ accountId: software.id, debit: usd("300") }, { accountId: bank.id, credit: usd("300") }], "Software");
    const first = await t(ws, (c) => closeYear(c, ws.orgId, "test", year, ws.actor));
    expect(first).toMatchObject({ net_income: "700.00", changed: true });
    expect(await bal(ws, "retained_earnings")).toBe("700.00");
    expect(await bal(ws, "sales")).toBe("0.00");
    const pl = await t(ws, (c) => profitAndLoss(c, ws.orgId, "test", `${year}-01-01`, `${year}-12-31`));
    expect(pl).toMatchObject({ net_income: "700.00" });
    const bs = await t(ws, (c) => balanceSheet(c, ws.orgId, "test", END));
    expect(bs.equity.current_earnings).toBe("0.00");
    const periods = await q(ws, "SELECT count(*)::int AS n FROM accounting_periods WHERE status = 'closed' AND start_date BETWEEN $1 AND $2", [`${year}-01-01`, `${year}-12-31`]);
    expect(periods[0]!.n).toBe(12);
    expect((await t(ws, (c) => closeYear(c, ws.orgId, "test", year, ws.actor))).changed).toBe(false);
    await t(ws, (c) => reopenPeriod(c, ws.orgId, "test", `${year}-12`, "Late invoice", ws.actor));
    await post(`${year}-12-20`, [{ accountId: software.id, debit: usd("50") }, { accountId: bank.id, credit: usd("50") }], "Late software bill");
    const again = await t(ws, (c) => closeYear(c, ws.orgId, "test", year, ws.actor));
    expect(again).toMatchObject({ net_income: "650.00", changed: true });
    expect(await bal(ws, "retained_earnings")).toBe("650.00");
    await assertBooksHold(ws);
  });
});

describe("undoing a classification", () => {
  it("returns the money to the holding account so it can be classified again", async () => {
    const ws = await workspace();
    const r = await ingest(ws, transfer(ws, usd("740"), randomAddress()));
    const p = await paymentFor(ws, r.observationId!);
    const [expense, equity] = await Promise.all([acct(ws, "6000"), acct(ws, "3000")]);
    const cls = await t(ws, (c) => classifyTransaction(c, ws.orgId, "test", { payment_id: p.id, account_id: expense.id, reason: "mmm" }, ws.actor));
    expect(await bal(ws, "general_expense")).toBe("-740.00");
    await t(ws, (c) => undoClassification(c, ws.orgId, "test", cls.id, "Wrong account", ws.actor));
    expect(await bal(ws, "general_expense")).toBe("0.00");
    expect(await bal(ws, "payments_to_identify")).toBe("740.00");
    await expect(t(ws, (c) => undoClassification(c, ws.orgId, "test", cls.id, "again", ws.actor))).rejects.toMatchObject({ code: "already_undone" });
    await t(ws, (c) => classifyTransaction(c, ws.orgId, "test", { payment_id: p.id, account_id: equity.id, reason: "Founder top-up" }, ws.actor));
    expect(await bal(ws, "owner_equity")).toBe("740.00");
    await assertBooksHold(ws);
  });
});

describe("exports, attachments and recurring bills", () => {
  it("exports the posted journal in QuickBooks and Xero layouts that balance", async () => {
    const ws = await workspace();
    await invoice(ws, "Acme Ltd", "250.00");
    await ingest(ws, transfer(ws, usd("250"), ws.customers["Acme Ltd"]!.address!));
    const { journalExport, chartExport } = await import("../src");
    const qb = await t(ws, (c) => journalExport(c, ws.orgId, "test", { format: "quickbooks", from: daysAgo(1), to: daysAgo(-1) }));
    expect(qb.headers).toEqual(["Journal No", "Journal Date", "Account", "Debits", "Credits", "Description", "Name"]);
    expect(qb.entries).toBe(3);
    expect(qb.rows[0]![1]).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    const xero = await t(ws, (c) => journalExport(c, ws.orgId, "test", { format: "xero", from: daysAgo(1), to: daysAgo(-1) }));
    const total = xero.rows.reduce((s, r) => s + Math.round(Number(r[5]) * 100), 0);
    expect(total).toBe(0);
    const chart = await t(ws, (c) => chartExport(c, ws.orgId, "test", "xero"));
    expect(chart.rows.find((r) => r[0] === "1030")![2]).toBe("BANK");
  });

  it("keeps attachments with the record, checks file contents, and never deletes them", async () => {
    const ws = await workspace();
    const vendor = await t(ws, (c) => createVendor(c, ws.orgId, "test", { name: "Figma" }, ws.actor));
    const bill = await t(ws, (c) => createBill(c, ws.orgId, "test", { vendor_id: vendor.id, number: "F-9", title: "Seats", amount: "45.00", bill_date: daysAgo(0) }, ws.actor));
    const { addAttachment, listAttachments, removeAttachment } = await import("../src");
    const pdf = Buffer.from("%PDF-1.4\n% receipt\n").toString("base64");
    const a = await t(ws, (c) => addAttachment(c, ws.orgId, "test", { object_type: "bill", object_id: bill.id, filename: "../../etc/receipt.pdf", content_type: "application/pdf", data_base64: pdf }, ws.actor));
    expect(a.filename).toBe("receipt.pdf");
    await expect(t(ws, (c) => addAttachment(c, ws.orgId, "test", { object_type: "bill", object_id: bill.id, filename: "x.png", content_type: "image/png", data_base64: pdf }, ws.actor))).rejects.toMatchObject({ code: "file_type_mismatch" });
    expect(await t(ws, (c) => listAttachments(c, ws.orgId, "test", "bill", bill.id))).toHaveLength(1);
    await expect(q(ws, "DELETE FROM attachments WHERE id = $1", [a.id])).rejects.toThrow();
    await t(ws, (c) => removeAttachment(c, ws.orgId, "test", a.id, ws.actor));
    expect(await t(ws, (c) => listAttachments(c, ws.orgId, "test", "bill", bill.id))).toHaveLength(0);
  });

  it("recurring bills keep the day of the month, catch up once, and never duplicate", async () => {
    const { nextOccurrence, createRecurringBill, generateDueRecurringBills } = await import("../src");
    expect(nextOccurrence("2026-01-31", "monthly", 31)).toBe("2026-02-28");
    expect(nextOccurrence("2026-02-28", "monthly", 31)).toBe("2026-03-31");
    expect(nextOccurrence("2026-11-15", "quarterly", 15)).toBe("2027-02-15");
    const ws = await workspace();
    const vendor = await t(ws, (c) => createVendor(c, ws.orgId, "test", { name: "Landlord" }, ws.actor));
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 2);
    await t(ws, (c) => createRecurringBill(c, ws.orgId, "test", { vendor_id: vendor.id, title: "Office rent", amount: "1200.00", frequency: "monthly", start_date: iso(start), auto_approve: true, number_prefix: "RENT" }, ws.actor));
    expect(await t(ws, (c) => generateDueRecurringBills(c, ws.orgId, "test"))).toBe(3);
    expect(await t(ws, (c) => generateDueRecurringBills(c, ws.orgId, "test"))).toBe(0);
    const bills = await q(ws, "SELECT number, status FROM bills ORDER BY bill_date");
    expect(bills.map((b) => b.status)).toEqual(["approved", "approved", "approved"]);
    expect(bills[0]!.number).toBe(`RENT-${iso(start)}`);
    expect(await bal(ws, "accounts_payable")).toBe("3600.00");
    await assertBooksHold(ws);
  });
});
