import { withSystem, withTenant, type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, log, type Actor } from "../context";
import { approveBill, createBill } from "./bills";
import { ledgerAmount } from "./amounts";
import { accountById, systemAccount } from "./chart";
import { isoDate } from "./ledger";
import { money } from "./reports";

type Row = Record<string, any>;

export type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** The next date on the schedule, keeping the original day of the month (clamped to month end). */
export function nextOccurrence(date: string, frequency: Frequency, anchorDay: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (frequency === "weekly") return isoDate(new Date(Date.UTC(y, m - 1, d + 7)));
  const months = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  const ty = y + Math.floor((m - 1 + months) / 12);
  const tm = ((m - 1 + months) % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(ty, tm - 1, Math.min(anchorDay, last))));
}

export async function createRecurringBill(
  client: Client,
  organizationId: string,
  environment: Environment,
  input: { vendor_id: string; title: string; amount: string; account_id?: string | null; frequency: Frequency; start_date: string; end_date?: string | null; due_days?: number; auto_approve?: boolean; number_prefix?: string | null },
  actor: Actor
): Promise<Row> {
  const vendor = (await client.query("SELECT * FROM vendors WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL", [input.vendor_id, organizationId, environment])).rows[0] as Row | undefined;
  if (!vendor) throw new EngineError("vendor_not_found", "Choose a vendor from this workspace.", 404);
  const accountId = input.account_id ?? vendor.default_account_id ?? (await systemAccount(client, organizationId, environment, "general_expense")).id;
  const account = await accountById(client, organizationId, environment, accountId);
  if (!["expense", "cogs", "asset"].includes(account.type) || account.subtype === "cash") throw new EngineError("invalid_account", "Choose an expense, cost of goods or (non-cash) asset account.", 422);
  if (input.end_date && input.end_date < input.start_date) throw new EngineError("invalid_end_date", "The end date is before the start date.", 422);
  const amount = ledgerAmount(input.amount);
  const prefix = (input.number_prefix ?? vendor.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()) || "BILL";
  const id = newId("recurringBill");
  await client.query(
    `INSERT INTO recurring_bills (id, organization_id, environment, vendor_id, title, amount, account_id, frequency, anchor_day, next_date, end_date, due_days, auto_approve, number_prefix, created_by_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, organizationId, environment, vendor.id, input.title, amount.toString(), account.id, input.frequency, Number(input.start_date.slice(8, 10)), input.start_date, input.end_date ?? null, input.due_days ?? 14, input.auto_approve ?? false, prefix, actor.label ?? null]
  );
  await audit(client, actor, { organizationId, environment, action: "recurring_bill_created", objectType: "recurring_bill", objectId: id, next: { vendor: vendor.name, title: input.title, amount: input.amount, frequency: input.frequency, start: input.start_date } });
  return serializeRecurring((await client.query("SELECT r.*, v.name AS vendor_name FROM recurring_bills r JOIN vendors v ON v.id = r.vendor_id WHERE r.id = $1", [id])).rows[0] as Row);
}

export function serializeRecurring(r: Row) {
  return {
    id: r.id,
    object: "recurring_bill",
    vendor: { id: r.vendor_id, name: r.vendor_name },
    title: r.title,
    amount: money(BigInt(r.amount)),
    account_id: r.account_id,
    frequency: r.frequency,
    next_date: r.status === "active" ? r.next_date : null,
    end_date: r.end_date,
    due_days: r.due_days,
    auto_approve: r.auto_approve,
    number_prefix: r.number_prefix,
    status: r.status,
    bills_created: r.bills_created,
    last_bill_date: r.last_bill_date,
    created_at: r.created_at
  };
}

export async function setRecurringBillStatus(client: Client, organizationId: string, environment: Environment, id: string, status: "active" | "paused" | "ended", actor: Actor): Promise<Row> {
  const r = (await client.query("SELECT * FROM recurring_bills WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [id, organizationId, environment])).rows[0] as Row | undefined;
  if (!r) throw new EngineError("not_found", "No such recurring bill.", 404);
  if (r.status === "ended") throw new EngineError("recurring_ended", "This schedule has ended. Create a new one.", 409);
  let next = r.next_date as string;
  // Resuming never creates a backlog of missed bills: the schedule picks up from today.
  if (status === "active" && r.status === "paused") while (next < isoDate(new Date())) next = nextOccurrence(next, r.frequency, r.anchor_day);
  await client.query("UPDATE recurring_bills SET status = $2, next_date = $3, updated_at = now() WHERE id = $1", [id, status, next]);
  await audit(client, actor, { organizationId, environment, action: "recurring_bill_status_changed", objectType: "recurring_bill", objectId: id, previous: { status: r.status }, next: { status } });
  return serializeRecurring((await client.query("SELECT r.*, v.name AS vendor_name FROM recurring_bills r JOIN vendors v ON v.id = r.vendor_id WHERE r.id = $1", [id])).rows[0] as Row);
}

const RECURRING_ACTOR: Actor = { type: "system", id: "setra", label: "Setra (recurring bill)" };

/**
 * Create the bills that are due for one workspace. Idempotent: a schedule never creates two bills
 * for the same date. Catches up at most 12 missed occurrences per run.
 */

export async function generateDueRecurringBills(client: Client, organizationId: string, environment: Environment, today = isoDate(new Date())): Promise<number> {
  const due = (await client.query("SELECT * FROM recurring_bills WHERE organization_id = $1 AND environment = $2 AND status = 'active' AND next_date <= $3::date ORDER BY next_date FOR UPDATE", [organizationId, environment, today])).rows as Row[];
  let created = 0;
  for (const r of due) {
    let next = r.next_date as string;
    for (let i = 0; i < 12 && next <= today; i++) {
      if (r.end_date && next > r.end_date) break;
      const exists = (await client.query("SELECT 1 FROM bills WHERE recurring_bill_id = $1 AND bill_date = $2", [r.id, next])).rows[0];
      if (!exists) {
        const due_date = isoDate(new Date(Date.parse(`${next}T00:00:00Z`) + r.due_days * 86_400_000));
        const bill = await createBill(client, organizationId, environment, { vendor_id: r.vendor_id, number: `${r.number_prefix}-${next}`, title: r.title, amount: money(BigInt(r.amount)), account_id: r.account_id, bill_date: next, due_date, description: "Created from a recurring bill schedule." }, RECURRING_ACTOR);
        await client.query("UPDATE bills SET recurring_bill_id = $2 WHERE id = $1", [bill.id, r.id]);
        if (r.auto_approve) await approveBill(client, organizationId, environment, bill.id, RECURRING_ACTOR);
        await client.query("UPDATE recurring_bills SET bills_created = bills_created + 1, last_bill_date = $2, updated_at = now() WHERE id = $1", [r.id, next]);
        created += 1;
      }
      next = nextOccurrence(next, r.frequency, r.anchor_day);
    }
    const ended = r.end_date && next > r.end_date;
    await client.query("UPDATE recurring_bills SET next_date = $2, status = $3, updated_at = now() WHERE id = $1", [r.id, next, ended ? "ended" : "active"]);
  }
  return created;
}

/** Worker job: generate due recurring bills across workspaces. */
export async function runRecurringBills(): Promise<number> {
  const orgs = await withSystem(async (c) => (await c.query("SELECT DISTINCT organization_id, environment FROM recurring_bills WHERE status = 'active' AND next_date <= current_date")).rows as Row[]);
  let total = 0;
  for (const o of orgs) {
    try {
      total += await withTenant(o.organization_id, (c) => generateDueRecurringBills(c, o.organization_id, o.environment));
    } catch (error) {
      log().error("recurring_bills_failed", { organizationId: o.organization_id, error: (error as Error).message });
    }
  }
  if (total) log().info("recurring_bills_created", { count: total });
  return total;
}
