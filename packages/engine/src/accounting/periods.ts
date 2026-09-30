import { type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { ensureBooks } from "./posting-rules";
import { isoDate } from "./ledger";

type Row = Record<string, any>;

export const monthBounds = (month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new EngineError("invalid_period", "Periods are months, like 2026-09.", 422);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start: isoDate(start), end: isoDate(end) };
};

/** Close a month: nothing can be posted into it afterwards (automatic postings move to the next open date). */
export async function closePeriod(client: Client, organizationId: string, environment: Environment, month: string, actor: Actor): Promise<Row> {
  await ensureBooks(client, organizationId, environment);
  const { start, end } = monthBounds(month);
  if (end >= isoDate(new Date())) throw new EngineError("period_not_ended", "A period can only be closed after it ends.", 409);
  const drafts = (await client.query("SELECT number FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND status IN ('draft','approved') AND entry_date BETWEEN $3 AND $4 LIMIT 3", [organizationId, environment, start, end])).rows as Row[];
  if (drafts.length) throw new EngineError("period_has_drafts", `Post or void the draft entries in this period first (${drafts.map((d) => d.number).join(", ")}).`, 409);
  await client.query(
    `INSERT INTO accounting_periods (id, organization_id, environment, start_date, end_date, status, closed_at, closed_by, closed_by_label)
     VALUES ($1,$2,$3,$4,$5,'closed',now(),$6,$7)
     ON CONFLICT (organization_id, environment, start_date) DO UPDATE SET status = 'closed', closed_at = now(), closed_by = $6, closed_by_label = $7, updated_at = now()`,
    [newId("accountingPeriod"), organizationId, environment, start, end, actor.id ?? null, actor.label ?? null]
  );
  await audit(client, actor, { organizationId, environment, action: "period_closed", objectType: "accounting_period", objectId: month, next: { start, end } });
  return (await client.query("SELECT * FROM accounting_periods WHERE organization_id = $1 AND environment = $2 AND start_date = $3", [organizationId, environment, start])).rows[0] as Row;
}

/** Reopen a closed month for a controlled adjustment. The reason is recorded permanently. */
export async function reopenPeriod(client: Client, organizationId: string, environment: Environment, month: string, reason: string, actor: Actor): Promise<Row> {
  const { start } = monthBounds(month);
  const period = (await client.query("SELECT * FROM accounting_periods WHERE organization_id = $1 AND environment = $2 AND start_date = $3 FOR UPDATE", [organizationId, environment, start])).rows[0] as Row | undefined;
  if (!period || period.status !== "closed") throw new EngineError("period_not_closed", "That period isn't closed.", 409);
  await client.query("UPDATE accounting_periods SET status = 'open', reopened_at = now(), reopen_reason = $2, updated_at = now() WHERE id = $1", [period.id, reason]);
  await audit(client, actor, { organizationId, environment, action: "period_reopened", objectType: "accounting_period", objectId: month, previous: { status: "closed" }, next: { status: "open", reason } });
  return (await client.query("SELECT * FROM accounting_periods WHERE id = $1", [period.id])).rows[0] as Row;
}
