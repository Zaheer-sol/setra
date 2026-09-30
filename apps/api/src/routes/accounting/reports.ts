import type { FastifyInstance } from "fastify";
import { balanceSheet, cashFlow, ensureBooks, generalLedger, payablesAging, profitAndLoss, receivablesAging, trialBalance } from "@setra/engine";
import { generalLedgerQuery, reportAsOfQuery, reportRangeQuery } from "@setra/schemas";
import { route } from "../../lib/route";
import { today } from "../../lib/dates";
import { exportOwner, sendReportCsv } from "../../lib/report-file";

type Row = Record<string, any>;

const monthStart = () => today().slice(0, 8) + "01";

/** The general ledger and financial statements: trial balance, profit and loss, balance sheet, cash flow and aging, as JSON or CSV. */
export function reportRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/ledger",
    summary: "General ledger lines, filterable, with running balances for one account",
    tags: ["accounting"],
    permission: "financials:read",
    query: generalLedgerQuery,
    handler: ({ tx, query, organizationId, environment, reply, actor }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const gl = await generalLedger(c, organizationId, environment, {
          accountId: query.account_id,
          from: query.from,
          to: query.to,
          customerId: query.customer_id,
          vendorId: query.vendor_id,
          sourceType: query.source_type,
          entryId: query.entry_id,
          paymentId: query.payment_id,
          invoiceId: query.invoice_id,
          search: query.search,
          limit: query.format === "csv" ? 10_000 : query.limit,
          offset: query.format === "csv" ? 0 : query.offset
        });
        if (query.format === "csv") {
          const account = query.account_id ? gl.lines[0]?.account : null;
          return sendReportCsv(reply, await exportOwner(c, organizationId, environment, actor), {
            file: account ? `general-ledger-${account.code}` : "general-ledger",
            title: account ? `General ledger: ${account.code} ${account.name}` : "General ledger",
            period: query.from || query.to ? { from: query.from ?? "start", to: query.to ?? today() } : { label: "All dates" },
            details: account ? [["Opening balance", gl.opening_balance ?? "0.00"], ["Closing balance", gl.closing_balance ?? "0.00"]] : [],
            headers: ["date", "entry", "description", "account_code", "account", "debit", "credit", "balance", "memo", "customer", "vendor", "source"],
            rows: gl.lines.map((l: Row) => [l.entry.date, l.entry.number, l.entry.description, l.account.code, l.account.name, l.debit, l.credit, l.running_balance, l.memo, l.customer?.name, l.vendor?.name, l.entry.source_type])
          });
        }
        return gl;
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/reports/trial-balance",
    summary: "Trial balance",
    tags: ["accounting"],
    permission: "financials:read",
    query: reportAsOfQuery,
    handler: ({ tx, query, organizationId, environment, reply, actor }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const r = await trialBalance(c, organizationId, environment, query.as_of ?? today());
        if (query.format === "csv") {
          return sendReportCsv(reply, await exportOwner(c, organizationId, environment, actor), {
            file: "trial-balance",
            title: "Trial balance",
            period: { asOf: r.as_of },
            headers: ["code", "account", "type", "debit", "credit"],
            rows: [...r.accounts.map((a) => [a.code, a.name, a.type, a.debit_balance, a.credit_balance]), ["", "Total", "", r.totals.debit, r.totals.credit]]
          });
        }
        return r;
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/reports/profit-and-loss",
    summary: "Profit and loss for a period",
    tags: ["accounting"],
    permission: "financials:read",
    query: reportRangeQuery,
    handler: ({ tx, query, organizationId, environment, reply, actor }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const { raw, ...r } = await profitAndLoss(c, organizationId, environment, query.from ?? monthStart(), query.to ?? today());
        void raw;
        if (query.format === "csv") {
          const rows: Array<Array<string>> = [];
          const section = (name: string, s: { total: string; accounts: Array<{ code: string; name: string; amount: string }> }) => {
            for (const a of s.accounts) rows.push([name, a.code, a.name, a.amount]);
            rows.push([name, "", `Total ${name.toLowerCase()}`, s.total]);
          };
          section("Revenue", r.revenue);
          section("Cost of goods sold", r.cost_of_goods_sold);
          rows.push(["", "", "Gross profit", r.gross_profit]);
          section("Operating expenses", r.operating_expenses);
          rows.push(["", "", "Net income", r.net_income]);
          return sendReportCsv(reply, await exportOwner(c, organizationId, environment, actor), { file: "profit-and-loss", title: "Profit and loss", period: { from: r.from, to: r.to }, headers: ["section", "code", "account", "amount"], rows });
        }
        return r;
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/reports/balance-sheet",
    summary: "Balance sheet as of a date",
    tags: ["accounting"],
    permission: "financials:read",
    query: reportAsOfQuery,
    handler: ({ tx, query, organizationId, environment, reply, actor }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const r = await balanceSheet(c, organizationId, environment, query.as_of ?? today());
        if (query.format === "csv") {
          const rows: Array<Array<string>> = [];
          for (const [name, s] of [["Assets", r.assets], ["Liabilities", r.liabilities], ["Equity", r.equity]] as const) {
            for (const a of s.accounts) rows.push([name, a.code, a.name, a.amount]);
            if (name === "Equity") rows.push([name, "", "Current earnings", r.equity.current_earnings]);
            rows.push([name, "", `Total ${name.toLowerCase()}`, s.total]);
          }
          return sendReportCsv(reply, await exportOwner(c, organizationId, environment, actor), { file: "balance-sheet", title: "Balance sheet", period: { asOf: r.as_of }, headers: ["section", "code", "account", "amount"], rows });
        }
        return r;
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/reports/cash-flow",
    summary: "Cash flow for a period",
    tags: ["accounting"],
    permission: "financials:read",
    query: reportRangeQuery,
    handler: ({ tx, query, organizationId, environment, reply, actor }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const r = await cashFlow(c, organizationId, environment, query.from ?? monthStart(), query.to ?? today());
        if (query.format === "csv") {
          return sendReportCsv(reply, await exportOwner(c, organizationId, environment, actor), {
            file: "cash-flow",
            title: "Cash flow",
            period: { from: r.from, to: r.to },
            headers: ["section", "category", "amount"],
            rows: [
              ["", "Opening balance", r.opening_balance],
              ...r.operating.lines.map((l) => ["Operating", l.label, l.amount]),
              ["Operating", "Net operating", r.operating.total],
              ...r.financing.lines.map((l) => ["Financing", l.label, l.amount]),
              ["", "Net change", r.net_change],
              ["", "Closing balance", r.closing_balance]
            ]
          });
        }
        return r;
      })
  });

  for (const [kind, fn] of [
    ["receivables-aging", receivablesAging],
    ["payables-aging", payablesAging]
  ] as const) {
    route(app, {
      method: "GET",
      url: `/v1/accounting/reports/${kind}`,
      summary: kind === "receivables-aging" ? "What customers owe, by how overdue" : "What you owe vendors, by how overdue",
      tags: ["accounting"],
      permission: "financials:read",
      query: reportAsOfQuery,
      handler: ({ tx, query, organizationId, environment, reply, actor }) =>
        tx(async (c) => {
          await ensureBooks(c, organizationId, environment);
          const r = (await fn(c, organizationId, environment, query.as_of ?? today())) as Row;
          if (query.format === "csv") {
            return sendReportCsv(reply, await exportOwner(c, organizationId, environment, actor), {
              file: kind,
              title: kind === "receivables-aging" ? "Receivables aging: what customers owe" : "Payables aging: what you owe vendors",
              period: { asOf: query.as_of ?? today() },
              headers: ["number", kind === "receivables-aging" ? "customer" : "vendor", "due_date", "bucket", "remaining"],
              rows: (r.invoices ?? r.bills).map((x: Row) => [x.number, (x.customer ?? x.vendor)?.name, x.due_date ?? x.due_at, x.bucket, x.remaining])
            });
          }
          return r;
        })
    });
  }
}
