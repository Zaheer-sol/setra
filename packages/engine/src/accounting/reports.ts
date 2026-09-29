import type { Client } from "@setra/database";
import type { Environment } from "@setra/schemas";
import { EngineError } from "../context";
import { LEDGER_DECIMALS, valueInReporting } from "./chart";

type Row = Record<string, any>;

/**
 * Financial reports. Every number comes from one place: posted journal lines, summed by account.
 * The P&L, balance sheet, trial balance, cash flow and general ledger never use separate business
 * logic, so they can't disagree. Amounts are exact decimal strings (6-decimal reporting micro-units
 * formatted to 2+ decimals).
 */

export interface AccountBalance {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: "debit" | "credit";
  system_key: string | null;
  wallet_id: string | null;
  debits: bigint;
  credits: bigint;
  /** Balance on the account's normal side (positive = normal). */
  balance: bigint;
}

export const money = (v: bigint): string => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(LEDGER_DECIMALS);
  let frac = (abs % base).toString().padStart(LEDGER_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${abs / base}.${frac}`;
};

const dateOnly = (v: string | Date | undefined | null): string | null => (v ? (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10)) : null);

function checkRange(from: string | null, to: string | null) {
  for (const d of [from, to]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new EngineError("invalid_date", "Dates must be YYYY-MM-DD.", 422);
  if (from && to && from > to) throw new EngineError("invalid_range", "The start date is after the end date.", 422);
}

/** Debit/credit totals per account from posted entries, optionally within a date range. */
export async function accountBalances(client: Client, organizationId: string, environment: Environment, range: { from?: string | null; to?: string | null; excludeClosing?: boolean } = {}): Promise<AccountBalance[]> {
  const from = dateOnly(range.from);
  const to = dateOnly(range.to);
  checkRange(from, to);
  const rows = (
    await client.query(
      `SELECT a.id, a.code, a.name, a.type, a.subtype, a.normal_balance, a.system_key, a.wallet_id, a.archived_at,
              COALESCE(sum(l.debit), 0)::text AS debits, COALESCE(sum(l.credit), 0)::text AS credits
         FROM ledger_accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id
              AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = l.entry_id AND e.status = 'posted'
                            AND ($3::date IS NULL OR e.entry_date >= $3::date) AND ($4::date IS NULL OR e.entry_date <= $4::date)
                            AND (NOT $5::boolean OR e.source_type <> 'year_end'))
        WHERE a.organization_id = $1 AND a.environment = $2
        GROUP BY a.id
        ORDER BY a.code`,
      [organizationId, environment, from, to, range.excludeClosing ?? false]
    )
  ).rows as Row[];
  return rows.map((r) => {
    const debits = BigInt(r.debits);
    const credits = BigInt(r.credits);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      normal_balance: r.normal_balance,
      system_key: r.system_key,
      wallet_id: r.wallet_id,
      debits,
      credits,
      balance: r.normal_balance === "debit" ? debits - credits : credits - debits,
      archived: r.archived_at !== null
    } as AccountBalance;
  });
}

const serializeAccount = (a: AccountBalance, value?: bigint) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, amount: money(value ?? a.balance) });

// ── Trial balance ──────────────────────────────────────────────────────────────────────────────

export async function trialBalance(client: Client, organizationId: string, environment: Environment, asOf: string) {
  const accounts = await accountBalances(client, organizationId, environment, { to: asOf });
  let totalDebit = 0n;
  let totalCredit = 0n;
  const rows = accounts
    .filter((a) => a.debits !== 0n || a.credits !== 0n)
    .map((a) => {
      const net = a.debits - a.credits;
      const debit = net > 0n ? net : 0n;
      const credit = net < 0n ? -net : 0n;
      totalDebit += debit;
      totalCredit += credit;
      return { id: a.id, code: a.code, name: a.name, type: a.type, debits: money(a.debits), credits: money(a.credits), debit_balance: money(debit), credit_balance: money(credit) };
    });
  return { as_of: asOf, accounts: rows, totals: { debit: money(totalDebit), credit: money(totalCredit), balanced: totalDebit === totalCredit } };
}

// ── Profit & loss ──────────────────────────────────────────────────────────────────────────────

export async function profitAndLoss(client: Client, organizationId: string, environment: Environment, from: string, to: string) {
  const accounts = await accountBalances(client, organizationId, environment, { from, to, excludeClosing: true });
  // Revenue is reported net of contra-revenue (refunds): a contra account's normal side is debit, so
  // it subtracts.
  const revenueValue = (a: AccountBalance) => a.credits - a.debits;
  const expenseValue = (a: AccountBalance) => a.debits - a.credits;
  // Accounts whose activity nets to zero in the period (e.g. an entry and its reversal) are left out.
  const revenue = accounts.filter((a) => a.type === "revenue" && a.debits !== a.credits);
  const cogs = accounts.filter((a) => a.type === "cogs" && a.debits !== a.credits);
  const expenses = accounts.filter((a) => a.type === "expense" && a.debits !== a.credits);
  const totalRevenue = revenue.reduce((s, a) => s + revenueValue(a), 0n);
  const totalCogs = cogs.reduce((s, a) => s + expenseValue(a), 0n);
  const totalExpenses = expenses.reduce((s, a) => s + expenseValue(a), 0n);
  const gross = totalRevenue - totalCogs;
  return {
    from,
    to,
    revenue: { total: money(totalRevenue), accounts: revenue.map((a) => serializeAccount(a, revenueValue(a))) },
    cost_of_goods_sold: { total: money(totalCogs), accounts: cogs.map((a) => serializeAccount(a, expenseValue(a))) },
    gross_profit: money(gross),
    operating_expenses: { total: money(totalExpenses), accounts: expenses.map((a) => serializeAccount(a, expenseValue(a))) },
    net_income: money(gross - totalExpenses),
    raw: { revenue: totalRevenue, cogs: totalCogs, expenses: totalExpenses, net: gross - totalExpenses }
  };
}

// ── Balance sheet ──────────────────────────────────────────────────────────────────────────────

export async function balanceSheet(client: Client, organizationId: string, environment: Environment, asOf: string) {
  const accounts = await accountBalances(client, organizationId, environment, { to: asOf });
  const pick = (type: string) => accounts.filter((a) => a.type === type && (a.debits || a.credits));
  const assets = pick("asset");
  const liabilities = pick("liability");
  const equity = pick("equity");
  const sum = (list: AccountBalance[]) => list.reduce((s, a) => s + a.balance, 0n);
  // Earnings to date: revenue less costs and expenses since the books began (no closing entries are
  // made; they're shown as current earnings within equity).
  const earnings = accounts.filter((a) => a.type === "revenue").reduce((s, a) => s + (a.credits - a.debits), 0n) - accounts.filter((a) => a.type === "cogs" || a.type === "expense").reduce((s, a) => s + (a.debits - a.credits), 0n);
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + earnings;
  return {
    as_of: asOf,
    assets: { total: money(totalAssets), accounts: assets.map((a) => serializeAccount(a)) },
    liabilities: { total: money(totalLiabilities), accounts: liabilities.map((a) => serializeAccount(a)) },
    equity: { total: money(totalEquity), accounts: equity.map((a) => serializeAccount(a)), current_earnings: money(earnings) },
    liabilities_and_equity: money(totalLiabilities + totalEquity),
    balanced: totalAssets === totalLiabilities + totalEquity
  };
}

// ── Cash flow ──────────────────────────────────────────────────────────────────────────────────

export type CashCategory =
  | "customer_payments"
  | "unidentified_receipts"
  | "refunds"
  | "expenses_paid"
  | "bills_paid"
  | "unclassified_outgoing"
  | "other_operating"
  | "financing"
  | "internal_transfers";

const CASH_LABEL: Record<CashCategory, string> = {
  customer_payments: "Payments from customers",
  unidentified_receipts: "Received, not yet identified",
  refunds: "Refunds sent",
  expenses_paid: "Expenses paid",
  bills_paid: "Vendor bills paid",
  unclassified_outgoing: "Sent, not yet classified",
  other_operating: "Other operating",
  financing: "Owner contributions & draws",
  internal_transfers: "Transfers between your own accounts"
};

/**
 * Money in and out of cash accounts (wallets and bank), by what it was for. Transfers between your
 * own accounts are shown separately and excluded from the net change, never counted as income.
 */
export async function cashFlow(client: Client, organizationId: string, environment: Environment, from: string, to: string) {
  checkRange(from, to);
  const cash = (await client.query("SELECT id FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND subtype = 'cash'", [organizationId, environment])).rows.map((r) => r.id as string);
  const cashSet = new Set(cash);
  const clearing = (await client.query("SELECT id FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND system_key = 'transfers_to_classify'", [organizationId, environment])).rows[0]?.id as string | undefined;
  const opening = await cashBalance(client, organizationId, environment, cash, dayBefore(from));
  const closing = await cashBalance(client, organizationId, environment, cash, to);
  const entries = (
    await client.query(
      `SELECT e.id, e.source_type, e.source_id, e.reverses_entry_id FROM journal_entries e
        WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'posted' AND e.entry_date BETWEEN $3::date AND $4::date
          AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id AND l.account_id = ANY($5))
        ORDER BY e.entry_date, e.id`,
      [organizationId, environment, from, to, cash]
    )
  ).rows as Row[];
  const totals = new Map<CashCategory, bigint>();
  const add = (c: CashCategory, v: bigint) => totals.set(c, (totals.get(c) ?? 0n) + v);
  for (const e of entries) {
    const lines = (await client.query("SELECT l.*, a.type, a.subtype, a.system_key FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id WHERE l.entry_id = $1", [e.id])).rows as Row[];
    const delta = lines.filter((l) => cashSet.has(l.account_id)).reduce((s, l) => s + BigInt(l.debit) - BigInt(l.credit), 0n);
    if (delta === 0n) {
      if (lines.every((l) => cashSet.has(l.account_id))) add("internal_transfers", 0n);
      continue;
    }
    add(await categorize(client, e, lines, cashSet, clearing), delta);
  }
  const section = (cats: CashCategory[]) => cats.filter((c) => totals.has(c)).map((c) => ({ category: c, label: CASH_LABEL[c], amount: money(totals.get(c)!) }));
  const operatingCats: CashCategory[] = ["customer_payments", "unidentified_receipts", "refunds", "expenses_paid", "bills_paid", "unclassified_outgoing", "other_operating"];
  const operating = operatingCats.reduce((s, c) => s + (totals.get(c) ?? 0n), 0n);
  const financing = totals.get("financing") ?? 0n;
  const internal = totals.get("internal_transfers") ?? 0n;
  return {
    from,
    to,
    opening_balance: money(opening),
    operating: { total: money(operating), lines: section(operatingCats) },
    financing: { total: money(financing), lines: section(["financing"]) },
    internal_transfers: { net: money(internal), note: "Money moved between your own wallets and accounts. Not income or spending." },
    net_change: money(closing - opening),
    closing_balance: money(closing),
    reconciles: operating + financing + internal === closing - opening
  };
}

async function categorize(client: Client, e: Row, lines: Row[], cashSet: Set<string>, clearing: string | undefined): Promise<CashCategory> {
  const counter = lines.filter((l) => !cashSet.has(l.account_id));
  if (counter.length === 0) return "internal_transfers";
  const sourceEntry = e.reverses_entry_id ? ((await client.query("SELECT source_type, source_id FROM journal_entries WHERE id = $1", [e.reverses_entry_id])).rows[0] as Row) : e;
  if (sourceEntry.source_type === "payment") {
    if (counter.every((l) => l.account_id === clearing)) return "internal_transfers";
    const p = (await client.query("SELECT invoice_id, status FROM payments WHERE id = $1", [sourceEntry.source_id])).rows[0] as Row | undefined;
    return p?.invoice_id ? "customer_payments" : "unidentified_receipts";
  }
  if (sourceEntry.source_type === "outgoing_transfer") {
    const t = (await client.query("SELECT * FROM outgoing_transfers WHERE id = $1", [sourceEntry.source_id])).rows[0] as Row | undefined;
    if (!t) return "unclassified_outgoing";
    const own = (await client.query("SELECT 1 FROM wallets WHERE organization_id = $1 AND environment = $2 AND chain_id = $3 AND address = $4", [t.organization_id, t.environment, t.chain_id, t.to_address])).rows[0];
    if (own) return "internal_transfers";
    if ((await client.query("SELECT 1 FROM refunds WHERE outgoing_transfer_id = $1", [t.id])).rows[0]) return "refunds";
    if ((await client.query("SELECT 1 FROM bill_payments WHERE outgoing_transfer_id = $1", [t.id])).rows[0]) return "bills_paid";
    if ((await client.query("SELECT 1 FROM expenses WHERE outgoing_transfer_id = $1 AND status = 'approved'", [t.id])).rows[0]) return "expenses_paid";
    const cls = (await client.query("SELECT a.type FROM transaction_classifications c JOIN ledger_accounts a ON a.id = c.account_id WHERE c.outgoing_transfer_id = $1 AND c.reversed_at IS NULL", [t.id])).rows[0] as Row | undefined;
    if (cls) return cls.type === "equity" ? "financing" : "other_operating";
    return "unclassified_outgoing";
  }
  if (counter.some((l) => l.type === "equity")) return "financing";
  if (counter.some((l) => l.system_key === "accounts_payable")) return "bills_paid";
  if (counter.some((l) => l.type === "expense" || l.type === "cogs")) return "expenses_paid";
  if (counter.some((l) => l.system_key === "accounts_receivable" || l.type === "revenue")) return "customer_payments";
  return "other_operating";
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function cashBalance(client: Client, organizationId: string, environment: Environment, cash: string[], asOf: string): Promise<bigint> {
  if (!cash.length) return 0n;
  const r = await client.query<{ s: string }>(
    `SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.organization_id = $1 AND l.environment = $2 AND e.status = 'posted' AND e.entry_date <= $3::date AND l.account_id = ANY($4)`,
    [organizationId, environment, asOf, cash]
  );
  return BigInt(r.rows[0]!.s);
}

// ── General ledger ─────────────────────────────────────────────────────────────────────────────

export interface LedgerFilters {
  accountId?: string;
  from?: string;
  to?: string;
  customerId?: string;
  vendorId?: string;
  sourceType?: string;
  entryId?: string;
  paymentId?: string;
  invoiceId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Posted ledger lines with their entry, account and source; a running balance when one account is selected. */
export async function generalLedger(client: Client, organizationId: string, environment: Environment, f: LedgerFilters) {
  checkRange(f.from ?? null, f.to ?? null);
  const where = ["l.organization_id = $1", "l.environment = $2", "e.status = 'posted'"];
  const params: unknown[] = [organizationId, environment];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.accountId) add("l.account_id = ?", f.accountId);
  if (f.from) add("e.entry_date >= ?::date", f.from);
  if (f.to) add("e.entry_date <= ?::date", f.to);
  if (f.customerId) add("l.customer_id = ?", f.customerId);
  if (f.vendorId) add("l.vendor_id = ?", f.vendorId);
  if (f.sourceType) add("e.source_type = ?", f.sourceType);
  if (f.entryId) add("e.id = ?", f.entryId);
  if (f.paymentId) add("l.payment_id = ?", f.paymentId);
  if (f.invoiceId) add("l.invoice_id = ?", f.invoiceId);
  if (f.search) {
    params.push(`%${f.search}%`);
    const n = `$${params.length}`;
    where.push(`(e.description ILIKE ${n} OR e.number ILIKE ${n} OR l.memo ILIKE ${n})`);
  }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const rows = (
    await client.query(
      `SELECT l.*, e.number, e.entry_date, e.description, e.source_type, e.source_id, e.reverses_entry_id, e.memo AS entry_memo,
              a.code AS account_code, a.name AS account_name, a.type AS account_type, a.normal_balance,
              c.name AS customer_name, v.name AS vendor_name, i.number AS invoice_number, i.title AS invoice_title,
              p.transaction_hash, p.source AS payment_source
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN ledger_accounts a ON a.id = l.account_id
         LEFT JOIN customers c ON c.id = l.customer_id
         LEFT JOIN vendors v ON v.id = l.vendor_id
         LEFT JOIN invoices i ON i.id = l.invoice_id
         LEFT JOIN payments p ON p.id = l.payment_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.entry_date, e.id, l.position
        LIMIT ${limit + 1} OFFSET ${offset}`,
      params
    )
  ).rows as Row[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  let running: bigint | null = null;
  let opening: bigint | null = null;
  let normal: "debit" | "credit" | null = null;
  if (f.accountId) {
    const acct = (await client.query("SELECT normal_balance FROM ledger_accounts WHERE id = $1 AND organization_id = $2", [f.accountId, organizationId])).rows[0] as Row | undefined;
    if (!acct) throw new EngineError("account_not_found", "No such account.", 404);
    normal = acct.normal_balance;
    // Opening balance: everything before the range, plus the rows skipped by pagination.
    const before = await client.query<{ d: string; c: string }>(
      `SELECT COALESCE(sum(l.debit), 0)::text AS d, COALESCE(sum(l.credit), 0)::text AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = $1 AND e.status = 'posted' AND ($2::date IS NOT NULL AND e.entry_date < $2::date)`,
      [f.accountId, f.from ?? null]
    );
    const signed = (d: bigint, c: bigint) => (normal === "debit" ? d - c : c - d);
    opening = signed(BigInt(before.rows[0]!.d), BigInt(before.rows[0]!.c));
    running = opening;
    if (offset > 0) {
      const skipped = (
        await client.query(
          `SELECT l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
            LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN vendors v ON v.id = l.vendor_id LEFT JOIN invoices i ON i.id = l.invoice_id LEFT JOIN payments p ON p.id = l.payment_id
            WHERE ${where.join(" AND ")} ORDER BY e.entry_date, e.id, l.position LIMIT ${offset}`,
          params
        )
      ).rows as Row[];
      for (const s of skipped) running += signed(BigInt(s.debit), BigInt(s.credit));
    }
  }
  const lines = page.map((l) => {
    const debit = BigInt(l.debit);
    const credit = BigInt(l.credit);
    if (running !== null) running += normal === "debit" ? debit - credit : credit - debit;
    return {
      id: l.id,
      entry: { id: l.entry_id, number: l.number, date: dateOnly(l.entry_date), description: l.description, memo: l.entry_memo, source_type: l.source_type, source_id: l.source_id, reverses_entry_id: l.reverses_entry_id },
      account: { id: l.account_id, code: l.account_code, name: l.account_name, type: l.account_type },
      debit: money(debit),
      credit: money(credit),
      memo: l.memo,
      running_balance: running === null ? null : money(running),
      customer: l.customer_id ? { id: l.customer_id, name: l.customer_name } : null,
      vendor: l.vendor_id ? { id: l.vendor_id, name: l.vendor_name } : null,
      invoice: l.invoice_id ? { id: l.invoice_id, number: l.invoice_number, title: l.invoice_title } : null,
      payment: l.payment_id ? { id: l.payment_id, transaction_hash: l.transaction_hash, simulated: l.payment_source === "simulated" } : null,
      bill_id: l.bill_id,
      expense_id: l.expense_id,
      outgoing_transfer_id: l.outgoing_transfer_id,
      financial_event_id: l.financial_event_id,
      observation_id: l.observation_id,
      asset: l.asset_id ? { id: l.asset_id, amount_base_units: l.asset_amount, rate_source: l.rate_source } : null
    };
  });
  return { lines, has_more: hasMore, opening_balance: opening === null ? null : money(opening), closing_balance: running === null ? null : money(running) };
}

// ── Aging ──────────────────────────────────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  { key: "current", label: "Current", min: -Infinity, max: 0 },
  { key: "d1_30", label: "1-30 days", min: 1, max: 30 },
  { key: "d31_60", label: "31-60 days", min: 31, max: 60 },
  { key: "d61_90", label: "61-90 days", min: 61, max: 90 },
  { key: "d90_plus", label: "Over 90 days", min: 91, max: Infinity }
] as const;

function bucketFor(dueDate: Date | string | null, asOf: string): (typeof AGING_BUCKETS)[number]["key"] {
  if (!dueDate) return "current";
  const due = new Date(typeof dueDate === "string" ? `${dueDate.slice(0, 10)}T00:00:00Z` : dueDate.toISOString().slice(0, 10) + "T00:00:00Z");
  const days = Math.floor((new Date(`${asOf}T00:00:00Z`).getTime() - due.getTime()) / 86_400_000);
  return AGING_BUCKETS.find((b) => days >= b.min && days <= b.max)!.key;
}

/** Receivables aging from the invoice subledger, checked against the Accounts Receivable account. */
export async function receivablesAging(client: Client, organizationId: string, environment: Environment, asOf: string) {
  const invoices = (
    await client.query(
      `SELECT i.id, i.number, i.title, i.due_at, i.issued_at, i.amount_due, i.amount_paid, i.amount_written_off, i.status, i.asset_id, c.id AS customer_id, c.name AS customer_name
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.organization_id = $1 AND i.environment = $2 AND i.status IN ('open','partially_paid','expired') AND i.issued_at::date <= $3::date
        ORDER BY i.due_at NULLS LAST, i.id`,
      [organizationId, environment, asOf]
    )
  ).rows as Row[];
  const byCustomer = new Map<string, { id: string; name: string; buckets: Record<string, bigint>; total: bigint }>();
  const totals: Record<string, bigint> = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0n]));
  const rows = [];
  let grand = 0n;
  for (const i of invoices) {
    const remainingBase = BigInt(i.amount_due) - BigInt(i.amount_paid) - BigInt(i.amount_written_off);
    if (remainingBase <= 0n) continue;
    const remaining = valueInReporting(i.asset_id, remainingBase, "USD").amount;
    const bucket = bucketFor(i.due_at, asOf);
    totals[bucket] = (totals[bucket] ?? 0n) + remaining;
    grand += remaining;
    const c = byCustomer.get(i.customer_id) ?? { id: i.customer_id, name: i.customer_name, buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0n])), total: 0n };
    c.buckets[bucket] = (c.buckets[bucket] ?? 0n) + remaining;
    c.total += remaining;
    byCustomer.set(i.customer_id, c);
    rows.push({ id: i.id, number: i.number, title: i.title, customer: { id: i.customer_id, name: i.customer_name }, due_at: dateOnly(i.due_at), bucket, remaining: money(remaining), status: i.status });
  }
  const ar = (await client.query("SELECT id FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND system_key = 'accounts_receivable'", [organizationId, environment])).rows[0] as Row | undefined;
  const ledger = ar ? (await accountBalances(client, organizationId, environment, { to: asOf })).find((a) => a.id === ar.id)?.balance ?? 0n : 0n;
  const method = (await client.query("SELECT method FROM accounting_settings WHERE organization_id = $1 AND environment = $2", [organizationId, environment])).rows[0]?.method ?? "accrual";
  return {
    as_of: asOf,
    buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, amount: money(totals[b.key] ?? 0n) })),
    total: money(grand),
    customers: [...byCustomer.values()].sort((a, b) => (b.total > a.total ? 1 : -1)).map((c) => ({ id: c.id, name: c.name, total: money(c.total), buckets: Object.fromEntries(Object.entries(c.buckets).map(([k, v]) => [k, money(v)])) })),
    invoices: rows,
    // In accrual books, the Accounts Receivable account should equal the open invoices.
    ledger_check: method === "accrual" ? { account_balance: money(ledger), subledger_total: money(grand), matches: ledger === grand } : null
  };
}

/** Payables aging from approved bills, checked against the Accounts Payable account. */
export async function payablesAging(client: Client, organizationId: string, environment: Environment, asOf: string) {
  const bills = (
    await client.query(
      `SELECT b.*, v.name AS vendor_name FROM bills b JOIN vendors v ON v.id = b.vendor_id
        WHERE b.organization_id = $1 AND b.environment = $2 AND b.status IN ('approved','partially_paid') AND b.bill_date <= $3::date
        ORDER BY b.due_date NULLS LAST, b.id`,
      [organizationId, environment, asOf]
    )
  ).rows as Row[];
  const byVendor = new Map<string, { id: string; name: string; buckets: Record<string, bigint>; total: bigint }>();
  const totals: Record<string, bigint> = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0n]));
  const rows = [];
  let grand = 0n;
  for (const b of bills) {
    const remaining = BigInt(b.amount) - BigInt(b.amount_paid);
    if (remaining <= 0n) continue;
    const bucket = bucketFor(b.due_date, asOf);
    totals[bucket] = (totals[bucket] ?? 0n) + remaining;
    grand += remaining;
    const v = byVendor.get(b.vendor_id) ?? { id: b.vendor_id, name: b.vendor_name, buckets: Object.fromEntries(AGING_BUCKETS.map((x) => [x.key, 0n])), total: 0n };
    v.buckets[bucket] = (v.buckets[bucket] ?? 0n) + remaining;
    v.total += remaining;
    byVendor.set(b.vendor_id, v);
    rows.push({ id: b.id, number: b.number, title: b.title, vendor: { id: b.vendor_id, name: b.vendor_name }, due_date: dateOnly(b.due_date), bucket, remaining: money(remaining), status: b.status });
  }
  const ap = (await client.query("SELECT id FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND system_key = 'accounts_payable'", [organizationId, environment])).rows[0] as Row | undefined;
  const ledger = ap ? (await accountBalances(client, organizationId, environment, { to: asOf })).find((a) => a.id === ap.id)?.balance ?? 0n : 0n;
  return {
    as_of: asOf,
    buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, amount: money(totals[b.key] ?? 0n) })),
    total: money(grand),
    vendors: [...byVendor.values()].sort((a, b) => (b.total > a.total ? 1 : -1)).map((v) => ({ id: v.id, name: v.name, total: money(v.total), buckets: Object.fromEntries(Object.entries(v.buckets).map(([k, x]) => [k, money(x)])) })),
    bills: rows,
    ledger_check: { account_balance: money(ledger), subledger_total: money(grand), matches: ledger === grand }
  };
}
