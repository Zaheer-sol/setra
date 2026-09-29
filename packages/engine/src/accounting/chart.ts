import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { EngineError } from "../context";

type Row = Record<string, any>;

/** Amounts in the ledger are integer micro-units of the reporting currency. */
export const LEDGER_DECIMALS = 6;

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "cogs" | "expense";

/** Accounts Setra posts to automatically, by stable key. */
export type SystemKey =
  | "bank"
  | "accounts_receivable"
  | "transfers_to_classify"
  | "accounts_payable"
  | "customer_credits"
  | "payments_to_identify"
  | "owner_equity"
  | "retained_earnings"
  | "sales"
  | "refunds"
  | "cogs"
  | "general_expense"
  | "network_fees"
  | "bad_debt"
  | "opening_balance_equity"
  | "fx_gain_loss";

interface Seed {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  normal: "debit" | "credit";
  key?: SystemKey;
  description?: string;
}

/**
 * The starting chart of accounts. Businesses add, rename and archive their own accounts; the
 * system accounts (with a key) keep their role because automatic postings depend on them.
 * Wallet accounts (1010–1029) are created per monitored wallet and asset.
 */
export const DEFAULT_CHART: Seed[] = [
  { code: "1030", name: "Bank Account", type: "asset", subtype: "cash", normal: "debit", key: "bank", description: "Money held off-chain, for payments made outside Setra's wallets." },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable", normal: "debit", key: "accounts_receivable", description: "What customers owe on issued invoices." },
  { code: "1950", name: "Transfers to Classify", type: "asset", subtype: "clearing", normal: "debit", key: "transfers_to_classify", description: "Stablecoin sent from your wallets that hasn't been assigned to a refund, bill, expense or transfer yet. Should be zero once everything is classified." },
  { code: "2010", name: "Accounts Payable", type: "liability", subtype: "payable", normal: "credit", key: "accounts_payable", description: "What you owe vendors on approved bills." },
  { code: "2020", name: "Customer Credits", type: "liability", subtype: "customer_credit", normal: "credit", key: "customer_credits", description: "Money customers paid beyond what they owed (overpayments), until refunded or applied." },
  { code: "2050", name: "Payments to Identify", type: "liability", subtype: "suspense", normal: "credit", key: "payments_to_identify", description: "Money received that isn't tied to an invoice yet (unknown senders, duplicates, set-aside payments). Never counted as revenue." },
  { code: "3000", name: "Owner's Equity", type: "equity", subtype: "equity", normal: "credit", key: "owner_equity" },
  { code: "3050", name: "Opening Balance Equity", type: "equity", subtype: "equity", normal: "credit", key: "opening_balance_equity", description: "The other side of opening balances entered when you start your books. Usually moved to Owner's Equity or Retained Earnings once confirmed." },
  { code: "3900", name: "Retained Earnings", type: "equity", subtype: "retained_earnings", normal: "credit", key: "retained_earnings" },
  { code: "4000", name: "Sales", type: "revenue", subtype: "revenue", normal: "credit", key: "sales", description: "Default revenue account for invoices." },
  { code: "4010", name: "Software Services", type: "revenue", subtype: "revenue", normal: "credit" },
  { code: "4020", name: "Consulting", type: "revenue", subtype: "revenue", normal: "credit" },
  { code: "4030", name: "Product Sales", type: "revenue", subtype: "revenue", normal: "credit" },
  { code: "4900", name: "Refunds & Returns", type: "revenue", subtype: "contra_revenue", normal: "debit", key: "refunds", description: "Money returned to customers after revenue was recognized. Reduces revenue." },
  { code: "5000", name: "Cost of Goods Sold", type: "cogs", subtype: "cogs", normal: "debit", key: "cogs" },
  { code: "6000", name: "General Expenses", type: "expense", subtype: "expense", normal: "debit", key: "general_expense" },
  { code: "6010", name: "Contractor Expense", type: "expense", subtype: "expense", normal: "debit" },
  { code: "6020", name: "Software", type: "expense", subtype: "expense", normal: "debit" },
  { code: "6030", name: "Marketing", type: "expense", subtype: "expense", normal: "debit" },
  { code: "6040", name: "Network Fees", type: "expense", subtype: "expense", normal: "debit", key: "network_fees", description: "Blockchain gas and network fees." },
  { code: "6050", name: "Payment & Bank Fees", type: "expense", subtype: "expense", normal: "debit" },
  { code: "6060", name: "Professional Services", type: "expense", subtype: "expense", normal: "debit" },
  { code: "6070", name: "Office & Admin", type: "expense", subtype: "expense", normal: "debit" },
  { code: "6080", name: "Travel", type: "expense", subtype: "expense", normal: "debit" },
  { code: "6950", name: "Exchange Gains & Losses", type: "expense", subtype: "expense", normal: "debit", key: "fx_gain_loss", description: "Differences from exchange-rate movements on non-USD stablecoins. A negative balance is a net gain." },
  { code: "6900", name: "Bad Debts & Write-offs", type: "expense", subtype: "expense", normal: "debit", key: "bad_debt", description: "Invoice balances written off as uncollectable." }
];

export const NORMAL_BALANCE: Record<AccountType, "debit" | "credit"> = { asset: "debit", expense: "debit", cogs: "debit", liability: "credit", equity: "credit", revenue: "credit" };

export interface BooksSettings {
  method: "accrual" | "cash";
  reportingCurrency: string;
  initialized: boolean;
}

/** Read (creating if needed) the accounting settings for an organization and mode. */
export async function booksSettings(client: Client, organizationId: string, environment: Environment): Promise<BooksSettings> {
  await client.query("INSERT INTO accounting_settings (organization_id, environment) VALUES ($1,$2) ON CONFLICT DO NOTHING", [organizationId, environment]);
  const s = (await client.query("SELECT * FROM accounting_settings WHERE organization_id = $1 AND environment = $2", [organizationId, environment])).rows[0] as Row;
  return { method: s.method, reportingCurrency: s.reporting_currency, initialized: s.books_initialized_at !== null };
}

/** Create the default chart for an organization and mode (idempotent). */
export async function seedChart(client: Client, organizationId: string, environment: Environment): Promise<void> {
  for (const a of DEFAULT_CHART) {
    await client.query(
      `INSERT INTO ledger_accounts (id, organization_id, environment, code, name, type, subtype, normal_balance, description, system_key)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
        WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE organization_id = $2 AND environment = $3 AND (code = $4 OR ($10::text IS NOT NULL AND system_key = $10)))`,
      [newId("ledgerAccount"), organizationId, environment, a.code, a.name, a.type, a.subtype, a.normal, a.description ?? null, a.key ?? null]
    );
  }
}

/** The account with a given system role. Seeds the chart if it's missing. */
export async function systemAccount(client: Client, organizationId: string, environment: Environment, key: SystemKey): Promise<Row> {
  let row = (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND system_key = $3", [organizationId, environment, key])).rows[0] as Row | undefined;
  if (!row) {
    await seedChart(client, organizationId, environment);
    row = (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND system_key = $3", [organizationId, environment, key])).rows[0] as Row | undefined;
  }
  if (!row) throw new EngineError("account_missing", `The ${key.replaceAll("_", " ")} account is missing.`, 500);
  return row;
}

/**
 * The asset account that mirrors one wallet's holding of one asset (e.g. "USDC · Main Wallet").
 * Created on first use, numbered in the 1010–1029 range (then 1200+ if that fills up).
 */
export async function walletAccount(client: Client, organizationId: string, environment: Environment, walletId: string, assetId: string): Promise<Row> {
  const existing = (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND wallet_id = $3 AND asset_id = $4", [organizationId, environment, walletId, assetId])).rows[0] as Row | undefined;
  if (existing) return existing;
  const wallet = (await client.query("SELECT * FROM wallets WHERE id = $1 AND organization_id = $2", [walletId, organizationId])).rows[0] as Row | undefined;
  if (!wallet) throw new EngineError("wallet_not_found", "No such wallet.", 404);
  const found = networks().asset(assetId);
  if (!found) throw new EngineError("asset_unknown", "That asset isn't supported.", 422);
  const used = new Set(
    (await client.query<{ code: string }>("SELECT code FROM ledger_accounts WHERE organization_id = $1 AND environment = $2", [organizationId, environment])).rows.map((r) => r.code)
  );
  const candidates = [...Array.from({ length: 20 }, (_, i) => String(1010 + i)), ...Array.from({ length: 700 }, (_, i) => String(1200 + i))];
  const code = candidates.find((c) => !used.has(c));
  if (!code) throw new EngineError("account_codes_exhausted", "No free account code for this wallet.", 500);
  const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  await client.query(
    `INSERT INTO ledger_accounts (id, organization_id, environment, code, name, type, subtype, normal_balance, description, wallet_id, asset_id)
     VALUES ($1,$2,$3,$4,$5,'asset','cash','debit',$6,$7,$8)
     ON CONFLICT DO NOTHING`,
    [newId("ledgerAccount"), organizationId, environment, code, `${found.asset.symbol} · ${wallet.name}`.slice(0, 120), `${found.asset.symbol} held in ${wallet.name} on ${found.network.name} (${short}). Tracks what Setra has seen move in and out since monitoring began.`, walletId, assetId]
  );
  return (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND wallet_id = $3 AND asset_id = $4", [organizationId, environment, walletId, assetId])).rows[0] as Row;
}

/**
 * The account for a wallet's native token (e.g. "MON gas · Main Wallet"), which pays network fees.
 * Setra doesn't observe native-token deposits, so its balance only reflects fees and whatever the
 * business records (for example an opening balance).
 */
export async function nativeAccount(client: Client, organizationId: string, environment: Environment, walletId: string, symbol: string): Promise<Row> {
  const existing = (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND wallet_id = $3 AND native_symbol = $4", [organizationId, environment, walletId, symbol])).rows[0] as Row | undefined;
  if (existing) return existing;
  const wallet = (await client.query("SELECT * FROM wallets WHERE id = $1 AND organization_id = $2", [walletId, organizationId])).rows[0] as Row | undefined;
  if (!wallet) throw new EngineError("wallet_not_found", "No such wallet.", 404);
  const used = new Set((await client.query<{ code: string }>("SELECT code FROM ledger_accounts WHERE organization_id = $1 AND environment = $2", [organizationId, environment])).rows.map((r) => r.code));
  const code = Array.from({ length: 200 }, (_, i) => String(1300 + i)).find((c) => !used.has(c));
  if (!code) throw new EngineError("account_codes_exhausted", "No free account code for this wallet.", 500);
  await client.query(
    `INSERT INTO ledger_accounts (id, organization_id, environment, code, name, type, subtype, normal_balance, description, wallet_id, native_symbol)
     VALUES ($1,$2,$3,$4,$5,'asset','native','debit',$6,$7,$8)`,
    [newId("ledgerAccount"), organizationId, environment, code, `${symbol} gas · ${wallet.name}`.slice(0, 120), `${symbol} in ${wallet.name}, used to pay network fees. Setra records fees paid; record deposits or an opening balance yourself.`, walletId, symbol]
  );
  return (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND wallet_id = $3 AND native_symbol = $4", [organizationId, environment, walletId, symbol])).rows[0] as Row;
}

/** Look up an account that belongs to this organization and mode. */
export async function accountById(client: Client, organizationId: string, environment: Environment, accountId: string): Promise<Row> {
  const row = (await client.query("SELECT * FROM ledger_accounts WHERE id = $1 AND organization_id = $2 AND environment = $3", [accountId, organizationId, environment])).rows[0] as Row | undefined;
  if (!row) throw new EngineError("account_not_found", "Choose an account from this workspace's chart of accounts.", 404);
  return row;
}

/**
 * Value an asset amount in the reporting currency. Stablecoins are valued at their peg; an asset
 * whose peg isn't the reporting currency has no valuation rule, and Setra says so instead of
 * inventing a rate.
 */
export function valueInReporting(assetId: string | null | undefined, baseUnits: bigint, reportingCurrency: string): { amount: bigint; rateSource: string } {
  const found = assetId ? networks().asset(assetId) : undefined;
  if (!found) throw new EngineError("no_valuation", "This token isn't a supported asset, so it has no accounting value.", 422);
  if (found.asset.pegCurrency !== reportingCurrency) {
    throw new EngineError("no_valuation", `${found.asset.symbol} is pegged to ${found.asset.pegCurrency}, not ${reportingCurrency}; no exchange rate is configured.`, 422);
  }
  const d = found.asset.decimals;
  let amount: bigint;
  if (d === LEDGER_DECIMALS) amount = baseUnits;
  else if (d < LEDGER_DECIMALS) amount = baseUnits * 10n ** BigInt(LEDGER_DECIMALS - d);
  else {
    // Round half up to the ledger's precision; the exact asset quantity stays on the line.
    const div = 10n ** BigInt(d - LEDGER_DECIMALS);
    amount = (baseUnits + div / 2n) / div;
  }
  return { amount, rateSource: `peg:${found.asset.pegCurrency}` };
}
