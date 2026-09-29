import type { Client } from "@setra/database";
import type { Environment } from "@setra/schemas";
import { EngineError } from "../context";
import { money } from "./reports";

type Row = Record<string, any>;

/**
 * Exports for accountants and other accounting systems. Setra can sit alongside QuickBooks Online
 * or Xero: the posted journal and the chart of accounts come out in each product's import layout.
 * Only posted entries are exported; drafts never leave Setra. Amounts are the reporting currency.
 */

export type ExportFormat = "quickbooks" | "xero" | "setra";

export type ExportDateFormat = "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD";

const fmtDate = (iso: string, f: ExportDateFormat) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return f === "MM/DD/YYYY" ? `${m}/${d}/${y}` : f === "DD/MM/YYYY" ? `${d}/${m}/${y}` : `${y}-${m}-${d}`;
};

export async function journalExport(
  client: Client,
  organizationId: string,
  environment: Environment,
  opts: { format: ExportFormat; from: string; to: string; dateFormat?: ExportDateFormat; taxRate?: string; includeClosing?: boolean }
): Promise<{ filename: string; headers: string[]; rows: Array<Array<string | number | null>>; entries: number }> {
  if (opts.from > opts.to) throw new EngineError("invalid_range", "The start date is after the end date.", 422);
  const lines = (
    await client.query(
      `SELECT e.id AS entry_id, e.number, e.entry_date, e.description, e.memo AS entry_memo, e.source_type, l.debit, l.credit, l.memo,
              a.code, a.name AS account_name, c.name AS customer_name, v.name AS vendor_name
         FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN ledger_accounts a ON a.id = l.account_id
         LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN vendors v ON v.id = l.vendor_id
        WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'posted' AND e.entry_date BETWEEN $3::date AND $4::date
          AND ($5::boolean OR e.source_type <> 'year_end')
        ORDER BY e.entry_date, e.number, l.position`,
      [organizationId, environment, opts.from, opts.to, opts.includeClosing ?? false]
    )
  ).rows as Row[];
  const entries = new Set(lines.map((l) => l.entry_id)).size;
  const df = opts.dateFormat ?? (opts.format === "quickbooks" ? "MM/DD/YYYY" : opts.format === "xero" ? "DD/MM/YYYY" : "YYYY-MM-DD");
  const range = `${opts.from}-to-${opts.to}`;
  if (opts.format === "quickbooks") {
    // QuickBooks Online: Settings → Import data → Journal entries. Accounts are matched by name.
    return {
      filename: `setra-journal-quickbooks-${range}.csv`,
      entries,
      headers: ["Journal No", "Journal Date", "Account", "Debits", "Credits", "Description", "Name"],
      rows: lines.map((l) => [
        l.number,
        fmtDate(l.entry_date, df),
        l.account_name,
        BigInt(l.debit) > 0n ? money(BigInt(l.debit)) : "",
        BigInt(l.credit) > 0n ? money(BigInt(l.credit)) : "",
        (l.memo ?? l.description ?? "").slice(0, 4000),
        l.customer_name ?? l.vendor_name ?? ""
      ])
    };
  }
  if (opts.format === "xero") {
    // Xero: Accounting → Manual journals → Import. Rows with the same narration and date form one
    // journal; a positive amount is a debit, a negative amount a credit. Accounts match by code.
    const tax = opts.taxRate ?? "Tax Exempt";
    return {
      filename: `setra-journal-xero-${range}.csv`,
      entries,
      headers: ["*Narration", "*Date", "Description", "*AccountCode", "*TaxRate", "*Amount", "TrackingName1", "TrackingOption1", "TrackingName2", "TrackingOption2"],
      rows: lines.map((l) => [
        `${l.number} ${l.description}`.slice(0, 1000),
        fmtDate(l.entry_date, df),
        (l.memo ?? l.customer_name ?? l.vendor_name ?? "").slice(0, 1000),
        l.code,
        tax,
        money(BigInt(l.debit) - BigInt(l.credit)),
        "",
        "",
        "",
        ""
      ])
    };
  }
  return {
    filename: `setra-journal-${range}.csv`,
    entries,
    headers: ["entry", "date", "description", "source", "account_code", "account", "debit", "credit", "memo", "customer", "vendor"],
    rows: lines.map((l) => [l.number, fmtDate(l.entry_date, df), l.description, l.source_type, l.code, l.account_name, money(BigInt(l.debit)), money(BigInt(l.credit)), l.memo ?? "", l.customer_name ?? "", l.vendor_name ?? ""])
  };
}

/** Account types in each product's vocabulary, so the chart can be recreated there before importing. */
const QBO_TYPE: Record<string, [string, string]> = {
  cash: ["Bank", "Checking"],
  receivable: ["Accounts receivable (A/R)", "Accounts Receivable (A/R)"],
  other_asset: ["Other Current Assets", "Other Current Assets"],
  clearing: ["Other Current Assets", "Other Current Assets"],
  native: ["Other Current Assets", "Other Current Assets"],
  payable: ["Accounts payable (A/P)", "Accounts Payable (A/P)"],
  customer_credit: ["Other Current Liabilities", "Other Current Liabilities"],
  suspense: ["Other Current Liabilities", "Other Current Liabilities"],
  other_liability: ["Other Current Liabilities", "Other Current Liabilities"],
  equity: ["Equity", "Owner's Equity"],
  retained_earnings: ["Equity", "Retained Earnings"],
  revenue: ["Income", "Service/Fee Income"],
  contra_revenue: ["Income", "Discounts/Refunds Given"],
  cogs: ["Cost of Goods Sold", "Supplies & Materials - COGS"],
  expense: ["Expenses", "Other Miscellaneous Service Cost"]
};

const XERO_TYPE: Record<string, string> = {
  cash: "BANK",
  receivable: "CURRENT",
  other_asset: "CURRENT",
  clearing: "CURRENT",
  native: "CURRENT",
  payable: "CURRLIAB",
  customer_credit: "CURRLIAB",
  suspense: "CURRLIAB",
  other_liability: "CURRLIAB",
  equity: "EQUITY",
  retained_earnings: "EQUITY",
  revenue: "REVENUE",
  contra_revenue: "REVENUE",
  cogs: "DIRECTCOSTS",
  expense: "EXPENSE"
};

export async function chartExport(client: Client, organizationId: string, environment: Environment, format: ExportFormat, taxRate?: string) {
  const accounts = (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND archived_at IS NULL ORDER BY code", [organizationId, environment])).rows as Row[];
  if (format === "quickbooks") {
    return {
      filename: "setra-chart-of-accounts-quickbooks.csv",
      headers: ["Account Number", "Account Name", "Type", "Detail Type", "Description"],
      rows: accounts.map((a) => {
        const [type, detail] = QBO_TYPE[a.subtype] ?? QBO_TYPE[a.type] ?? ["Expenses", "Other Miscellaneous Service Cost"];
        return [a.code, a.name, type, detail, a.description ?? ""];
      })
    };
  }
  if (format === "xero") {
    return {
      filename: "setra-chart-of-accounts-xero.csv",
      headers: ["*Code", "*Name", "*Type", "*Tax Code", "Description", "Dashboard", "Expense Claims", "Enable Payments"],
      rows: accounts.map((a) => [a.code, a.name, XERO_TYPE[a.subtype] ?? XERO_TYPE[a.type] ?? "EXPENSE", taxRate ?? "Tax Exempt", a.description ?? "", "No", "No", a.subtype === "cash" ? "Yes" : "No"])
    };
  }
  return {
    filename: "setra-chart-of-accounts.csv",
    headers: ["code", "name", "type", "subtype", "normal_balance", "system", "description"],
    rows: accounts.map((a) => [a.code, a.name, a.type, a.subtype, a.normal_balance, a.system_key ? "yes" : "no", a.description ?? ""])
  };
}
