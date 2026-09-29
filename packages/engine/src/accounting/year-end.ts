import type { Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { systemAccount } from "./chart";
import { ensureBooks } from "./posting-rules";
import { isoDate, postEntry, reverseEntry, type LineInput } from "./ledger";
import { money } from "./reports";

type Row = Record<string, any>;

/**
 * Close a year: move the year's revenue and expenses into Retained Earnings with one closing entry
 * dated December 31, and close any of the year's months still open. Running it again after a late
 * adjustment replaces the closing entry, so Retained Earnings always matches the year's result.
 * Reports exclude closing entries from profit and loss, so the year's P&L still reads normally.
 */
export async function closeYear(client: Client, organizationId: string, environment: Environment, year: number, actor: Actor): Promise<{ entry_id: string | null; net_income: string; changed: boolean }> {
  await ensureBooks(client, organizationId, environment);
  const end = `${year}-12-31`;
  if (end >= isoDate(new Date())) throw new EngineError("year_not_ended", `${year} hasn't ended yet.`, 409);
  const drafts = (await client.query("SELECT number FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND status IN ('draft','approved') AND entry_date BETWEEN $3::date AND $4::date LIMIT 3", [organizationId, environment, `${year}-01-01`, end])).rows as Row[];
  if (drafts.length) throw new EngineError("period_has_drafts", `Post or discard the draft entries in ${year} first (${drafts.map((d) => d.number).join(", ")}).`, 409);
  const balances = (
    await client.query(
      `SELECT a.id, a.type, COALESCE(sum(l.debit - l.credit), 0)::text AS net FROM ledger_accounts a
         JOIN journal_lines l ON l.account_id = a.id JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.organization_id = $1 AND a.environment = $2 AND a.type IN ('revenue','cogs','expense') AND e.status = 'posted' AND e.source_type <> 'year_end'
          AND e.entry_date BETWEEN $3::date AND $4::date
        GROUP BY a.id, a.type HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.id`,
      [organizationId, environment, `${year}-01-01`, end]
    )
  ).rows as Row[];
  const re = await systemAccount(client, organizationId, environment, "retained_earnings");
  const lines: LineInput[] = [];
  let net = 0n; // debits minus credits of the year's P&L accounts (negative = profit)
  for (const b of balances) {
    const v = BigInt(b.net);
    net += v;
    lines.push({ accountId: b.id, [v > 0n ? "credit" : "debit"]: v > 0n ? v : -v, memo: `Close ${year}` });
  }
  if (net !== 0n) lines.push({ accountId: re.id, [net > 0n ? "debit" : "credit"]: net > 0n ? net : -net, memo: net < 0n ? `${year} profit` : `${year} loss` });
  const sig = (ls: Array<{ account: string; debit: bigint; credit: bigint }>) => ls.map((l) => `${l.account}:${l.debit}:${l.credit}`).sort().join("|");
  const signature = sig(lines.map((l) => ({ account: l.accountId, debit: l.debit ?? 0n, credit: l.credit ?? 0n })));

  const active = (
    await client.query(
      `SELECT e.* FROM journal_entries e WHERE e.organization_id = $1 AND e.environment = $2 AND e.source_type = 'year_end' AND e.source_id = $3 AND e.status = 'posted' AND e.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.status <> 'void')`,
      [organizationId, environment, String(year)]
    )
  ).rows[0] as Row | undefined;
  let entryId: string | null = active?.id ?? null;
  let changed = false;
  const activeSignature = active
    ? sig(((await client.query("SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1", [active.id])).rows as Row[]).map((l) => ({ account: l.account_id, debit: BigInt(l.debit), credit: BigInt(l.credit) })))
    : null;
  if (activeSignature !== signature) {
    if (active) await reverseEntry(client, organizationId, environment, active.id, { reason: `Year ${year} closed again after adjustments`, actor, date: end, sourceKey: `year-end-replaced:${active.id}`, automatic: true });
    entryId = null;
    if (lines.length >= 2) {
      const { entry } = await postEntry(client, { organizationId, environment, date: end, description: `Close ${year} to Retained Earnings`, memo: `Moves ${year}'s revenue and expenses into Retained Earnings.`, sourceType: "year_end", sourceId: String(year), sourceKey: `year-end:${year}:${newId("journalEntry")}`, actor, lines });
      entryId = entry.id;
    }
    changed = true;
  }
  for (let m = 1; m <= 12; m++) {
    const start = `${year}-${String(m).padStart(2, "0")}-01`;
    const monthEnd = isoDate(new Date(Date.UTC(year, m, 0)));
    await client.query(
      `INSERT INTO accounting_periods (id, organization_id, environment, start_date, end_date, status, closed_at, closed_by, closed_by_label)
       VALUES ($1,$2,$3,$4,$5,'closed',now(),$6,$7) ON CONFLICT (organization_id, environment, start_date) DO UPDATE SET status = 'closed', closed_at = COALESCE(accounting_periods.closed_at, now()), updated_at = now()`,
      [newId("accountingPeriod"), organizationId, environment, start, monthEnd, actor.id ?? null, actor.label ?? null]
    );
  }
  await audit(client, actor, { organizationId, environment, action: "year_closed", objectType: "organization", objectId: organizationId, next: { year, entry_id: entryId, net_income: money(-net), changed } });
  return { entry_id: entryId, net_income: money(-net), changed };
}
