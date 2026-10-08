import type { Client } from "@setra/database";
import type { Environment } from "@setra/schemas";
import { audit, type Actor } from "../context";
import { booksSettings, valueInReporting } from "./chart";
import { accountForFinancialEvent, accountForOutgoingTransfer, accountInvoiceCancelled, accountInvoiceIssued, accountSafely, backfill, ensureBooks } from "./posting-rules";
import { isoDate } from "./ledger";
import { money, payablesAging, receivablesAging } from "./reports";
import { accountForNetworkFee } from "./network-fees";
import { onchainBalance } from "./onchain-balance";
import { networks } from "@setra/config";

type Row = Record<string, any>;

export interface BooksCheck {
  key: string;
  label: string;
  status: "ok" | "attention" | "not_checked";
  detail: string;
  expected?: string | null;
  actual?: string | null;
  difference?: string | null;
  link?: string | null;
}

const usd = (v: bigint) => {
  const m = money(v);
  const [whole, frac] = m.replace("-", "").split(".");
  return `${m.startsWith("-") ? "-" : ""}$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

const netOf = async (client: Client, accountId: string): Promise<bigint> =>
  BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.status = 'posted'", [accountId])).rows[0]!.s);

/**
 * Does the ledger agree with everything else Setra knows? Receivables and payables against their
 * subledgers, every wallet account against the payments and transfers Setra recorded, the holding
 * accounts that should empty out, facts that should have produced entries, and failed postings.
 */

export async function booksHealth(client: Client, organizationId: string, environment: Environment): Promise<{ healthy: boolean; checked_at: string; method: string; checks: BooksCheck[]; issues: Row[] }> {
  const s = await ensureBooks(client, organizationId, environment);
  const today = isoDate(new Date());
  const checks: BooksCheck[] = [];

  const ar = await receivablesAging(client, organizationId, environment, today);
  if (ar.ledger_check) {
    checks.push({
      key: "receivables",
      label: "Receivables match open invoices",
      status: ar.ledger_check.matches ? "ok" : "attention",
      detail: ar.ledger_check.matches ? "Accounts Receivable equals the total still owed on open invoices." : "Accounts Receivable doesn't equal the open invoice balances. A manual entry to Accounts Receivable is the usual cause.",
      expected: ar.ledger_check.subledger_total,
      actual: ar.ledger_check.account_balance,
      link: "/app/reports/receivables"
    });
  } else {
    checks.push({ key: "receivables", label: "Receivables match open invoices", status: "not_checked", detail: "Cash-basis books don't carry receivables in the ledger." });
  }

  const ap = await payablesAging(client, organizationId, environment, today);
  checks.push({
    key: "payables",
    label: "Payables match unpaid bills",
    status: ap.ledger_check.matches ? "ok" : "attention",
    detail: ap.ledger_check.matches ? "Accounts Payable equals the total still owed on approved bills." : "Accounts Payable doesn't equal the unpaid bill balances. A manual entry to Accounts Payable is the usual cause.",
    expected: ap.ledger_check.subledger_total,
    actual: ap.ledger_check.account_balance,
    link: "/app/reports/payables"
  });

  // Every wallet account against the money Setra saw arrive and leave.
  const walletAccounts = (await client.query("SELECT a.*, w.name AS wallet_name FROM ledger_accounts a JOIN wallets w ON w.id = a.wallet_id WHERE a.organization_id = $1 AND a.environment = $2 AND a.asset_id IS NOT NULL ORDER BY a.code", [organizationId, environment])).rows as Row[];
  for (const a of walletAccounts) {
    const received = BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(amount), 0)::text AS s FROM payments WHERE wallet_id = $1 AND asset_id = $2 AND status NOT IN ('confirming','reversed')", [a.wallet_id, a.asset_id])).rows[0]!.s);
    const sent = BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(amount), 0)::text AS s FROM outgoing_transfers WHERE wallet_id = $1 AND asset_id = $2 AND canonical", [a.wallet_id, a.asset_id])).rows[0]!.s);
    let expected = 0n;
    try {
      expected = valueInReporting(a.asset_id, received, s.reportingCurrency).amount - valueInReporting(a.asset_id, sent, s.reportingCurrency).amount;
    } catch {
      checks.push({ key: `wallet:${a.id}`, label: `${a.name} matches recorded activity`, status: "not_checked", detail: "This asset has no valuation rule for the reporting currency." });
      continue;
    }
    // Balances entered as opening balances (holdings from before monitoring began) are expected too.
    expected += BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.status = 'posted' AND e.source_type = 'opening_balance'", [a.id])).rows[0]!.s);
    const actual = await netOf(client, a.id);
    checks.push({
      key: `wallet:${a.id}`,
      label: `${a.name} matches recorded activity`,
      status: actual === expected ? "ok" : "attention",
      detail:
        actual === expected
          ? "The ledger balance equals confirmed payments received minus transfers sent, as observed onchain since monitoring began. Balances held before monitoring began aren't included; record them with an opening-balance entry."
          : "The ledger balance differs from the confirmed onchain activity Setra recorded for this wallet. Run repair to post anything missing.",
      expected: money(expected),
      actual: money(actual),
      difference: money(actual - expected),
      link: `/app/accounting/ledger?account_id=${a.id}`
    });
  }

  // Every wallet account against the wallet's real balance on chain. Simulated test payments never
  // touched the chain, so they're taken out first.
  for (const a of walletAccounts) {
    const wallet = (await client.query("SELECT address, chain_id FROM wallets WHERE id = $1", [a.wallet_id])).rows[0] as Row | undefined;
    const found = networks().asset(a.asset_id);
    if (!wallet || !found) continue;
    const label = `${a.name} matches its balance on ${found.network.name}`;
    const simulated = BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(amount), 0)::text AS s FROM payments WHERE wallet_id = $1 AND asset_id = $2 AND source = 'simulated' AND status NOT IN ('confirming','reversed')", [a.wallet_id, a.asset_id])).rows[0]!.s);
    const chain = await onchainBalance(Number(wallet.chain_id), found.asset.address, wallet.address);
    if (!chain) {
      checks.push({ key: `onchain:${a.id}`, label, status: "not_checked", detail: `Couldn't read the balance from ${found.network.name} just now. Try again in a minute.` });
      continue;
    }
    let books: bigint;
    let onChain: bigint;
    try {
      books = (await netOf(client, a.id)) - valueInReporting(a.asset_id, simulated, s.reportingCurrency).amount;
      onChain = valueInReporting(a.asset_id, chain.balance, s.reportingCurrency).amount;
    } catch {
      continue;
    }
    const block = chain.blockNumber.toLocaleString("en-US");
    if (books === onChain) {
      checks.push({ key: `onchain:${a.id}`, label, status: "ok", detail: `The books agree with ${found.network.name} at block ${block}.`, expected: money(onChain), actual: money(books), link: `/app/accounting/ledger?account_id=${a.id}` });
    } else if (simulated > 0n && environment === "test") {
      checks.push({ key: `onchain:${a.id}`, label, status: "not_checked", detail: `This wallet has simulated test payments mixed with other entries, so it can't be compared with ${found.network.name} exactly.` });
    } else {
      checks.push({
        key: `onchain:${a.id}`,
        label,
        status: "attention",
        detail: `${found.network.name} shows ${usd(onChain)} at block ${block}; the books show ${usd(books)}. Money held before monitoring began needs an opening balance; a transfer Setra didn't see is fixed by running repair.`,
        expected: money(onChain),
        actual: money(books),
        difference: money(books - onChain),
        link: `/app/accounting/ledger?account_id=${a.id}`
      });
    }
  }

  // Holding accounts that should empty out as things are identified and classified.
  for (const [key, label, what] of [
    ["payments_to_identify", "All received money is identified", "received payments not tied to an invoice or classified yet"],
    ["transfers_to_classify", "All sent money is classified", "money sent from your wallets that isn't recorded as a refund, bill payment, expense or classification yet"]
  ] as const) {
    const acct = (await client.query("SELECT * FROM ledger_accounts WHERE organization_id = $1 AND environment = $2 AND system_key = $3", [organizationId, environment, key])).rows[0] as Row;
    const net = await netOf(client, acct.id);
    const natural = acct.normal_balance === "debit" ? net : -net;
    checks.push({
      key,
      label,
      status: natural === 0n ? "ok" : "attention",
      detail: natural === 0n ? "Nothing waiting." : `${usd(natural < 0n ? -natural : natural)} in ${what}.`,
      actual: money(natural),
      link: "/app/accounting/classify"
    });
  }

  // Facts that should have produced entries but didn't.
  const missing = (
    await client.query<{ kind: string; n: number }>(
      `SELECT 'payment' AS kind, count(*)::int AS n FROM payments p
         WHERE p.organization_id = $1 AND p.environment = $2 AND p.asset_id IS NOT NULL AND p.status NOT IN ('confirming','reversed')
           AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.organization_id = p.organization_id AND e.environment = p.environment AND e.source_key = 'pay-receipt:' || p.id)
       UNION ALL
       SELECT 'outgoing', count(*)::int FROM outgoing_transfers t
         WHERE t.organization_id = $1 AND t.environment = $2 AND t.asset_id IS NOT NULL AND t.canonical
           AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.organization_id = t.organization_id AND e.environment = t.environment AND e.source_key = 'out:' || t.id)
       UNION ALL
       SELECT 'invoice', count(*)::int FROM invoices i
         WHERE i.organization_id = $1 AND i.environment = $2 AND $3 = 'accrual'
           AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.organization_id = i.organization_id AND e.environment = i.environment AND e.source_key = 'inv-issue:' || i.id)`,
      [organizationId, environment, s.method]
    )
  ).rows;
  const missingTotal = missing.reduce((n, r) => n + r.n, 0);
  checks.push({
    key: "missing_entries",
    label: "Every payment, transfer and invoice is in the books",
    status: missingTotal === 0 ? "ok" : "attention",
    detail: missingTotal === 0 ? "Nothing is missing." : missing.filter((r) => r.n > 0).map((r) => `${r.n} ${r.kind === "outgoing" ? "outgoing transfer" : r.kind}${r.n === 1 ? "" : "s"}`).join(", ") + " without an entry. Run repair.",
    actual: String(missingTotal)
  });

  const tb = (await client.query<{ d: string; c: string }>("SELECT COALESCE(sum(l.debit), 0)::text AS d, COALESCE(sum(l.credit), 0)::text AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'posted'", [organizationId, environment])).rows[0]!;
  checks.push({ key: "trial_balance", label: "Debits equal credits", status: tb.d === tb.c ? "ok" : "attention", detail: tb.d === tb.c ? "The trial balance is in balance." : "The trial balance is out of balance.", expected: money(BigInt(tb.d)), actual: money(BigInt(tb.c)) });

  const issues = (await client.query("SELECT * FROM accounting_issues WHERE organization_id = $1 AND environment = $2 AND resolved_at IS NULL ORDER BY created_at", [organizationId, environment])).rows as Row[];
  checks.push({ key: "posting_failures", label: "No failed automatic postings", status: issues.length === 0 ? "ok" : "attention", detail: issues.length === 0 ? "Every automatic posting succeeded." : `${issues.length} automatic posting${issues.length === 1 ? "" : "s"} failed. The underlying payments still went through; run repair after fixing the cause.`, actual: String(issues.length) });

  const manual = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_type IN ('manual','reversal') AND status = 'posted' AND entry_date >= date_trunc('month', now())::date", [organizationId, environment])).rows[0]!.n;
  checks.push({ key: "manual_adjustments", label: "Manual adjustments this month", status: "ok", detail: manual === 0 ? "None." : `${manual} manual entr${manual === 1 ? "y" : "ies"} posted this month. Review them in the journal.`, actual: String(manual), link: "/app/accounting/journal?source_type=manual" });

  return {
    healthy: checks.every((c) => c.status !== "attention"),
    checked_at: new Date().toISOString(),
    method: s.method,
    checks,
    issues: issues.map((i) => ({ id: i.id, source_type: i.source_type, source_id: i.source_id, message: i.message, created_at: i.created_at }))
  };
}

/** Retry failed automatic postings and post anything missing. Idempotent: running it twice changes nothing. */
export async function repairBooks(client: Client, organizationId: string, environment: Environment, actor: Actor): Promise<{ retried: number; still_failing: number; posted: number }> {
  await ensureBooks(client, organizationId, environment);
  const issues = (await client.query("SELECT * FROM accounting_issues WHERE organization_id = $1 AND environment = $2 AND resolved_at IS NULL", [organizationId, environment])).rows as Row[];
  for (const i of issues) {
    if (i.source_type === "financial_event") await accountForFinancialEvent(client, i.source_id);
    else if (i.source_type === "outgoing_transfer") await accountForOutgoingTransfer(client, i.source_id);
    else if (i.source_key.startsWith("inv-issue:")) await accountInvoiceIssued(client, i.source_id);
    else if (i.source_key.startsWith("inv-cancel:")) await accountInvoiceCancelled(client, i.source_id);
    else if (i.source_type === "network_fee") await accountForNetworkFee(client, i.source_id);
  }
  let posted = 0;
  const settings = await booksSettings(client, organizationId, environment);
  await accountSafely(client, { organizationId, environment, sourceKey: "repair:backfill", sourceType: "repair" }, async () => {
    posted = (await backfill(client, organizationId, environment, settings)).posted;
  });
  const still = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM accounting_issues WHERE organization_id = $1 AND environment = $2 AND resolved_at IS NULL", [organizationId, environment])).rows[0]!.n;
  await audit(client, actor, { organizationId, environment, action: "books_repaired", objectType: "organization", objectId: organizationId, next: { retried: issues.length, posted, still_failing: still } });
  return { retried: issues.length, still_failing: still, posted };
}
