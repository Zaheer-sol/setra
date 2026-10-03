import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { cashFlow, ensureBooks, money, payablesAging, profitAndLoss, receivablesAging, trialBalance } from "@setra/engine";
import type { Environment } from "@setra/schemas";
import { ApiError } from "../../lib/errors";
import { route } from "../../lib/route";
import { unclassified } from "./classifications";

type Row = Record<string, any>;
type Check = { key: string; label: string; status: "ok" | "attention" | "blocking"; detail: string; link?: string };

const monthParam = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM") });

const lastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const inMonth = (at: string | Date, start: string, end: string) => {
  const d = new Date(at).toISOString().slice(0, 10);
  return d >= start && d <= end;
};
/** Sum of decimal amount strings ("1,250.50" style without commas), exactly, as micro-units. */
const micro = (v: string) => {
  const [w, f = ""] = v.replace(/,/g, "").split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0").slice(0, 6));
};

/**
 * One month of books, summarised from the ledger, with what has to be true before it can be trusted
 * and closed. Every figure comes from the same reports the console shows; nothing here is computed from
 * raw wallet inflows or outflows.
 */
export async function monthClose(c: Client, organizationId: string, environment: Environment, month: string) {
  await ensureBooks(c, organizationId, environment);
  const start = `${month}-01`;
  const end = lastDay(month);
  const today = new Date().toISOString().slice(0, 10);
  const ended = end < today;
  const asOf = ended ? end : today;

  const [pl, tb, ar, ap, cf, open] = await Promise.all([
    profitAndLoss(c, organizationId, environment, start, asOf),
    trialBalance(c, organizationId, environment, asOf),
    receivablesAging(c, organizationId, environment, asOf),
    payablesAging(c, organizationId, environment, asOf),
    cashFlow(c, organizationId, environment, start, asOf),
    unclassified(c, organizationId, environment)
  ]);
  const period = (await c.query("SELECT * FROM accounting_periods WHERE organization_id = $1 AND environment = $2 AND start_date = $3", [organizationId, environment, start])).rows[0] as Row | undefined;

  // Stablecoin that moved in the month, by asset (money movement, not accounting: see the P&L for that).
  const moved = async (table: "payments" | "outgoing_transfers", extra: string) =>
    (
      await c.query(
        `SELECT a.symbol, a.decimals, sum(t.amount)::text AS total, count(*)::int AS n FROM ${table} t JOIN assets a ON a.id = t.asset_id
          WHERE t.organization_id = $1 AND t.environment = $2 AND t.block_timestamp >= $3::date AND t.block_timestamp < ($4::date + 1) ${extra}
          GROUP BY a.symbol, a.decimals ORDER BY a.symbol`,
        [organizationId, environment, start, end]
      )
    ).rows.map((r: Row) => ({ asset: r.symbol, amount: money(BigInt(r.total) * 10n ** BigInt(Math.max(0, 6 - r.decimals)) / 10n ** BigInt(Math.max(0, r.decimals - 6))), count: r.n }));
  const received = await moved("payments", "AND t.status NOT IN ('confirming', 'reversed')");
  const paidOut = await moved("outgoing_transfers", "AND t.canonical");

  const receipts = open.receipts.filter((r) => inMonth(r.received_at, start, end));
  const transfers = open.outgoing.filter((t) => inMonth(t.sent_at, start, end));
  const sum = (rows: Array<{ amount: string }>) => money(rows.reduce((s, r) => s + micro(r.amount), 0n));
  const exceptions = (
    await c.query(
      `SELECT count(*)::int AS n FROM exceptions e JOIN payments p ON p.id = e.payment_id
        WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'open' AND p.block_timestamp < ($3::date + 1)`,
      [organizationId, environment, end]
    )
  ).rows[0]!.n as number;
  const drafts = (
    await c.query(
      "SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND status IN ('draft','approved') AND entry_date BETWEEN $3 AND $4",
      [organizationId, environment, start, end]
    )
  ).rows[0]!.n as number;

  // Has every monitored network been read past the end of the month?
  const chains = (await c.query("SELECT DISTINCT chain_id FROM wallets WHERE organization_id = $1 AND environment = $2 AND archived_at IS NULL", [organizationId, environment])).rows.map((r: Row) => Number(r.chain_id));
  const cursors = chains.length ? ((await c.query("SELECT chain_id, updated_at, last_error, last_error_at FROM chain_cursors WHERE stage = 'settled' AND chain_id = ANY($1)", [chains])).rows as Row[]) : [];
  const monthEnd = new Date(`${end}T23:59:59Z`).getTime();
  const behind = chains.filter((id) => {
    const cur = cursors.find((x) => Number(x.chain_id) === id);
    if (!cur) return true;
    const failing = cur.last_error && cur.last_error_at && new Date(cur.last_error_at) > new Date(cur.updated_at);
    return failing || (ended && new Date(cur.updated_at).getTime() < monthEnd);
  });

  const name = new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const checks: Check[] = [
    ended
      ? { key: "ended", label: "The month has ended", status: "ok", detail: `${name} ended on ${day(end)}.` }
      : { key: "ended", label: "Wait for the month to end", status: "blocking", detail: `${name} runs until ${day(end)}. A month can only be closed once it's over.` },
    behind.length
      ? { key: "wallets", label: "Every wallet is read to the end of the month", status: "attention", detail: `Still catching up on ${behind.map((id) => networks().byChainId(id)?.name ?? id).join(", ")}. Payments from the last days may be missing.`, link: "/app/wallets" }
      : { key: "wallets", label: "Every wallet is read to the end of the month", status: "ok", detail: chains.length ? "Every monitored wallet has been read past the end of the month." : "No wallets are monitored." },
    receipts.length
      ? { key: "identified", label: "All money received is identified", status: "attention", detail: `${receipts.length} payment${receipts.length === 1 ? "" : "s"} (${sum(receipts)}) received this month aren't tied to an invoice or classified.`, link: "/app/accounting/classify" }
      : { key: "identified", label: "All money received is identified", status: "ok", detail: "Every payment received this month is tied to an invoice or classified." },
    transfers.length
      ? { key: "classified", label: "All money sent is classified", status: "attention", detail: `${transfers.length} transfer${transfers.length === 1 ? "" : "s"} (${sum(transfers)}) sent this month aren't recorded as a bill, expense, refund or classification.`, link: "/app/accounting/classify" }
      : { key: "classified", label: "All money sent is classified", status: "ok", detail: "Every transfer sent this month is accounted for." },
    exceptions
      ? { key: "exceptions", label: "No payment is waiting for review", status: "attention", detail: `${exceptions} open review item${exceptions === 1 ? "" : "s"} for payments up to ${day(end)}.`, link: "/app/exceptions" }
      : { key: "exceptions", label: "No payment is waiting for review", status: "ok", detail: "Nothing is waiting for review." },
    drafts
      ? { key: "drafts", label: "No draft journal entries", status: "blocking", detail: `${drafts} draft entr${drafts === 1 ? "y" : "ies"} dated this month must be posted or voided first.`, link: "/app/accounting/journal" }
      : { key: "drafts", label: "No draft journal entries", status: "ok", detail: "No drafts are dated this month." },
    { key: "trial_balance", label: "Trial balance balances", status: tb.totals.balanced ? "ok" : "blocking", detail: `Debits ${tb.totals.debit}, credits ${tb.totals.credit} as of ${day(asOf)}.` },
    !ar.ledger_check
      ? { key: "receivables", label: "Receivables match unpaid invoices", status: "ok", detail: "These books use cash basis, so unpaid invoices aren't in the ledger and there's nothing to tie." }
      : {
          key: "receivables",
          label: "Receivables match unpaid invoices",
          status: ar.ledger_check.matches ? "ok" : "attention",
          detail: ar.ledger_check.matches ? `Accounts receivable ${ar.ledger_check.account_balance} equals the unpaid invoices.` : `Accounts receivable is ${ar.ledger_check.account_balance} but unpaid invoices total ${ar.ledger_check.subledger_total}.`,
          link: "/app/reports/receivables-aging"
        },
    {
      key: "payables",
      label: "Payables match unpaid bills",
      status: ap.ledger_check.matches ? "ok" : "attention",
      detail: ap.ledger_check.matches ? `Accounts payable ${ap.ledger_check.account_balance} equals the approved unpaid bills.` : `Accounts payable is ${ap.ledger_check.account_balance} but unpaid bills total ${ap.ledger_check.subledger_total}.`,
      link: "/app/reports/payables-aging"
    }
  ];

  return {
    month,
    start_date: start,
    end_date: end,
    as_of: asOf,
    ended,
    status: (period?.status as string | undefined) ?? "open",
    closed_at: period?.closed_at ?? null,
    closed_by: period?.closed_by_label ?? null,
    can_close: ended && (period?.status ?? "open") !== "closed" && !checks.some((x) => x.status === "blocking"),
    needs_attention: checks.filter((x) => x.status === "attention").length,
    summary: {
      revenue: pl.revenue.total,
      expenses: money(pl.raw.cogs + pl.raw.expenses),
      net_income: pl.net_income,
      stablecoin_received: received,
      stablecoin_paid_out: paidOut,
      cash_closing: cf.closing_balance,
      receivables: ar.total,
      payables: ap.total,
      unidentified_receipts: { count: receipts.length, amount: sum(receipts) },
      unclassified_transfers: { count: transfers.length, amount: sum(transfers) },
      open_exceptions: exceptions
    },
    checks
  };
}

export function monthCloseRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/periods/:month/summary",
    summary: "A month's results and what still needs attention before it can be closed",
    tags: ["accounting"],
    permission: "financials:read",
    params: monthParam,
    handler: ({ tx, params, organizationId, environment }) =>
      tx((c) => {
        if (params.month > new Date().toISOString().slice(0, 7)) throw new ApiError(422, "future_month", "That month hasn't started yet.");
        return monthClose(c, organizationId, environment, params.month);
      })
  });
}
