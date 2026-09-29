import type { Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { accountById, systemAccount } from "./chart";
import { ensureBooks } from "./posting-rules";
import { ledgerAmount } from "./amounts";
import { closedPeriodFor, postEntry, reverseEntry, type LineInput } from "./ledger";
import { money } from "./reports";

type Row = Record<string, any>;

const NOT_FOR_OPENING = new Set(["accounts_receivable", "accounts_payable", "payments_to_identify", "transfers_to_classify", "customer_credits", "opening_balance_equity"]);

/**
 * Starting balances for books that begin partway through a business's life: what was in the bank,
 * in wallets before monitoring began, owed on loans, and so on. One entry, balanced against Opening
 * Balance Equity. Setting them again replaces the previous opening entry (reversed, not edited).
 * Customer and vendor balances come from invoices and bills, so AR and AP aren't set here.
 */

export async function setOpeningBalances(
  client: Client,
  organizationId: string,
  environment: Environment,
  input: { date: string; lines: Array<{ account_id: string; amount: string; memo?: string | null }> },
  actor: Actor
): Promise<Row> {
  await ensureBooks(client, organizationId, environment);
  if (await closedPeriodFor(client, organizationId, environment, input.date)) throw new EngineError("period_closed", "That date is in a closed period.", 409);
  if (!input.lines.length) throw new EngineError("no_lines", "Enter at least one balance.", 422);
  const obe = await systemAccount(client, organizationId, environment, "opening_balance_equity");
  const lines: LineInput[] = [];
  let net = 0n; // debits minus credits
  const seen = new Set<string>();
  for (const l of input.lines) {
    const a = await accountById(client, organizationId, environment, l.account_id);
    if (seen.has(a.id)) throw new EngineError("duplicate_account", `${a.code} ${a.name} is listed twice.`, 422);
    seen.add(a.id);
    if (a.system_key && NOT_FOR_OPENING.has(a.system_key)) throw new EngineError("invalid_account", `${a.name} isn't set with an opening balance. ${a.system_key === "accounts_receivable" ? "Enter open customer invoices instead." : a.system_key === "accounts_payable" ? "Enter unpaid bills instead." : ""}`.trim(), 422);
    if (!["asset", "liability", "equity"].includes(a.type)) throw new EngineError("invalid_account", "Opening balances are for balance sheet accounts (assets, liabilities, equity).", 422);
    const negative = l.amount.trim().startsWith("-");
    const value = ledgerAmount(negative ? l.amount.trim().slice(1) : l.amount, `${a.code} ${a.name}`);
    // A positive amount sits on the account's normal side.
    const debitSide = (a.normal_balance === "debit") !== negative;
    lines.push({ accountId: a.id, [debitSide ? "debit" : "credit"]: value, memo: l.memo ?? "Opening balance" });
    net += debitSide ? value : -value;
  }
  if (net !== 0n) lines.push({ accountId: obe.id, [net > 0n ? "credit" : "debit"]: net > 0n ? net : -net, memo: "Balances the opening entry" });
  const previous = (
    await client.query(
      `SELECT e.id FROM journal_entries e WHERE e.organization_id = $1 AND e.environment = $2 AND e.source_type = 'opening_balance' AND e.status = 'posted' AND e.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.status <> 'void')`,
      [organizationId, environment]
    )
  ).rows as Row[];
  for (const p of previous) await reverseEntry(client, organizationId, environment, p.id, { reason: "Replaced by new opening balances", actor, date: input.date, sourceKey: `opening-replaced:${p.id}`, automatic: true });
  const { entry } = await postEntry(client, { organizationId, environment, date: input.date, description: "Opening balances", sourceType: "opening_balance", sourceId: null, sourceKey: `opening:${newId("journalEntry")}`, actor, lines });
  await audit(client, actor, { organizationId, environment, action: "opening_balances_set", objectType: "journal_entry", objectId: entry.id, next: { date: input.date, accounts: input.lines.length, replaced: previous.length } });
  return entry;
}

export async function openingBalances(client: Client, organizationId: string, environment: Environment): Promise<{ date: string | null; entry_id: string | null; lines: Array<{ account_id: string; code: string; name: string; amount: string }> }> {
  const e = (
    await client.query(
      `SELECT e.* FROM journal_entries e WHERE e.organization_id = $1 AND e.environment = $2 AND e.source_type = 'opening_balance' AND e.status = 'posted' AND e.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.status <> 'void') ORDER BY e.created_at DESC LIMIT 1`,
      [organizationId, environment]
    )
  ).rows[0] as Row | undefined;
  if (!e) return { date: null, entry_id: null, lines: [] };
  const lines = (await client.query("SELECT l.*, a.code, a.name, a.normal_balance, a.system_key FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY l.position", [e.id])).rows as Row[];
  return {
    date: e.entry_date,
    entry_id: e.id,
    lines: lines
      .filter((l) => l.system_key !== "opening_balance_equity")
      .map((l) => {
        const v = BigInt(l.debit) - BigInt(l.credit);
        return { account_id: l.account_id, code: l.code, name: l.name, amount: money(l.normal_balance === "debit" ? v : -v) };
      })
  };
}
