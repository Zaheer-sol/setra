import { isUniqueViolation, type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { emitBusinessEvent } from "./business-events";
import { money } from "./reports";

type Row = Record<string, any>;

/**
 * The journal: the only way anything reaches the ledger.
 *
 * Every entry is drafted, then posted. Posting checks the double-entry invariant (debits equal
 * credits), active same-tenant accounts and open periods, in application code here and again in the
 * database (see guard_journal_entry). A posted entry is never edited or deleted; it's corrected with a
 * reversing or adjusting entry. Automatic postings are idempotent by source key.
 */

export interface LineInput {
  accountId: string;
  debit?: bigint;
  credit?: bigint;
  memo?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  invoiceId?: string | null;
  billId?: string | null;
  expenseId?: string | null;
  paymentId?: string | null;
  outgoingTransferId?: string | null;
  observationId?: string | null;
  financialEventId?: string | null;
  assetId?: string | null;
  assetAmount?: bigint | null;
  rateSource?: string | null;
}

export interface EntryInput {
  organizationId: string;
  environment: Environment;
  date: Date | string;
  description: string;
  memo?: string | null;
  sourceType: string;
  sourceId?: string | null;
  /** Idempotency: the same source fact never posts twice. */
  sourceKey?: string | null;
  lines: LineInput[];
  actor: Actor;
  reversesEntryId?: string | null;
  currency?: string;
}

export const isoDate = (d: Date | string): string => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

function cleanLines(lines: LineInput[]): LineInput[] {
  return lines.filter((l) => (l.debit ?? 0n) > 0n || (l.credit ?? 0n) > 0n);
}

function validateLines(lines: LineInput[], requireBalanced: boolean) {
  for (const l of lines) {
    const d = l.debit ?? 0n;
    const c = l.credit ?? 0n;
    if (d < 0n || c < 0n) throw new EngineError("invalid_line", "Debits and credits can't be negative.", 422);
    if (d > 0n && c > 0n) throw new EngineError("invalid_line", "A line is either a debit or a credit, not both.", 422);
  }
  if (!requireBalanced) return;
  if (lines.length < 2) throw new EngineError("unbalanced_entry", "A journal entry needs at least two lines.", 422);
  const debits = lines.reduce((s, l) => s + (l.debit ?? 0n), 0n);
  const credits = lines.reduce((s, l) => s + (l.credit ?? 0n), 0n);
  if (debits !== credits) throw new EngineError("unbalanced_entry", `Debits (${money(debits)}) must equal credits (${money(credits)}).`, 422);
  if (debits === 0n) throw new EngineError("unbalanced_entry", "A journal entry must move some amount.", 422);
}

async function checkAccounts(client: Client, organizationId: string, environment: Environment, lines: LineInput[]) {
  const ids = [...new Set(lines.map((l) => l.accountId))];
  if (!ids.length) return;
  const rows = (await client.query("SELECT id, code, archived_at FROM ledger_accounts WHERE id = ANY($1) AND organization_id = $2 AND environment = $3", [ids, organizationId, environment])).rows as Row[];
  if (rows.length !== ids.length) throw new EngineError("account_not_found", "Every line must use an account from this workspace's chart of accounts.", 422);
  const archived = rows.find((r) => r.archived_at);
  if (archived) throw new EngineError("account_archived", `Account ${archived.code} is archived.`, 422);
}

/** Closed period containing a date, if any. */
export async function closedPeriodFor(client: Client, organizationId: string, environment: Environment, date: string): Promise<Row | null> {
  return (
    ((await client.query("SELECT * FROM accounting_periods WHERE organization_id = $1 AND environment = $2 AND status = 'closed' AND $3::date BETWEEN start_date AND end_date LIMIT 1", [organizationId, environment, date])).rows[0] as Row | undefined) ??
    null
  );
}

/** The first date on or after `date` that isn't in a closed period. */
async function nextOpenDate(client: Client, organizationId: string, environment: Environment, date: string): Promise<string> {
  let d = date;
  for (let i = 0; i < 240; i++) {
    const p = await closedPeriodFor(client, organizationId, environment, d);
    if (!p) return d;
    const next = new Date(`${isoDate(p.end_date instanceof Date ? p.end_date.toISOString() : String(p.end_date))}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = isoDate(next);
  }
  throw new EngineError("no_open_period", "No open accounting period is available.", 409);
}

async function nextNumber(client: Client, organizationId: string, environment: Environment): Promise<string> {
  const r = await client.query<{ v: number }>(
    `INSERT INTO journal_sequences (organization_id, environment, next_value) VALUES ($1,$2,2)
     ON CONFLICT (organization_id, environment) DO UPDATE SET next_value = journal_sequences.next_value + 1
     RETURNING next_value - 1 AS v`,
    [organizationId, environment]
  );
  return `JE-${String(r.rows[0]!.v).padStart(5, "0")}`;
}

async function insertEntry(client: Client, input: EntryInput, status: "draft" | "approved", date: string, originalDate: string | null): Promise<string> {
  const id = newId("journalEntry");
  const number = await nextNumber(client, input.organizationId, input.environment);
  await client.query(
    `INSERT INTO journal_entries (id, organization_id, environment, number, entry_date, description, memo, source_type, source_id, source_key, currency, status, reverses_entry_id, original_date,
       created_by_type, created_by_id, created_by_label, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id,
      input.organizationId,
      input.environment,
      number,
      date,
      input.description.slice(0, 500),
      input.memo ?? null,
      input.sourceType,
      input.sourceId ?? null,
      input.sourceKey ?? null,
      input.currency ?? "USD",
      status,
      input.reversesEntryId ?? null,
      originalDate,
      input.actor.type,
      input.actor.id ?? null,
      input.actor.label ?? null,
      input.actor.requestId ?? null
    ]
  );
  await insertLines(client, input.organizationId, input.environment, id, input.lines);
  return id;
}

async function insertLines(client: Client, organizationId: string, environment: Environment, entryId: string, lines: LineInput[]) {
  let position = 0;
  for (const l of lines) {
    position += 1;
    await client.query(
      `INSERT INTO journal_lines (id, organization_id, environment, entry_id, position, account_id, debit, credit, memo, customer_id, vendor_id, invoice_id, bill_id, expense_id, payment_id,
         outgoing_transfer_id, observation_id, financial_event_id, asset_id, asset_amount, rate_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        newId("journalLine"),
        organizationId,
        environment,
        entryId,
        position,
        l.accountId,
        (l.debit ?? 0n).toString(),
        (l.credit ?? 0n).toString(),
        l.memo ?? null,
        l.customerId ?? null,
        l.vendorId ?? null,
        l.invoiceId ?? null,
        l.billId ?? null,
        l.expenseId ?? null,
        l.paymentId ?? null,
        l.outgoingTransferId ?? null,
        l.observationId ?? null,
        l.financialEventId ?? null,
        l.assetId ?? null,
        l.assetAmount === null || l.assetAmount === undefined ? null : l.assetAmount.toString(),
        l.rateSource ?? null
      ]
    );
  }
}

async function markPosted(client: Client, entryId: string, actor: Actor) {
  await client.query("UPDATE journal_entries SET status = 'posted', posted_at = now(), posted_by_id = $2, posted_by_label = $3, updated_at = now() WHERE id = $1", [entryId, actor.id ?? null, actor.label ?? null]);
}

/**
 * Post an automatic entry (from a payment, invoice, bill, expense…). Idempotent by source key.
 * If the entry's date falls in a closed period, it is posted on the next open date and the original
 * date is kept on the entry, so closed books never change.
 */
export async function postEntry(client: Client, input: EntryInput): Promise<{ entry: Row; created: boolean }> {
  if (input.sourceKey) {
    const existing = (await client.query("SELECT * FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [input.organizationId, input.environment, input.sourceKey])).rows[0] as Row | undefined;
    if (existing) return { entry: existing, created: false };
  }
  const lines = cleanLines(input.lines);
  validateLines(lines, true);
  await checkAccounts(client, input.organizationId, input.environment, lines);
  const requested = isoDate(input.date);
  // Year-end closing entries belong on the year's last day, even in a closed period.
  const date = input.sourceType === "year_end" ? requested : await nextOpenDate(client, input.organizationId, input.environment, requested);
  let id: string;
  try {
    id = await insertEntry(client, { ...input, lines }, "draft", date, date === requested ? null : requested);
  } catch (error) {
    if (input.sourceKey && isUniqueViolation(error)) {
      const existing = (await client.query("SELECT * FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [input.organizationId, input.environment, input.sourceKey])).rows[0] as Row;
      return { entry: existing, created: false };
    }
    throw error;
  }
  await markPosted(client, id, input.actor);
  const entry = (await client.query("SELECT * FROM journal_entries WHERE id = $1", [id])).rows[0] as Row;
  return { entry, created: true };
}

/** Create a manual journal entry as a draft. Drafts may be unbalanced; posting requires balance. */
export async function createManualEntry(client: Client, input: Omit<EntryInput, "sourceType"> & { post?: boolean }): Promise<Row> {
  const lines = cleanLines(input.lines);
  validateLines(lines, input.post ?? false);
  await checkAccounts(client, input.organizationId, input.environment, lines);
  const date = isoDate(input.date);
  if (input.post && (await closedPeriodFor(client, input.organizationId, input.environment, date))) {
    throw new EngineError("period_closed", `The accounting period containing ${date} is closed. Post it in an open period, or reopen the period first.`, 409);
  }
  const id = await insertEntry(client, { ...input, lines, sourceType: "manual" }, "draft", date, null);
  await audit(client, input.actor, { organizationId: input.organizationId, environment: input.environment, action: "journal_entry_created", objectType: "journal_entry", objectId: id, next: { date, description: input.description, lines: lines.length } });
  if (input.post) return postManualEntry(client, input.organizationId, input.environment, id, input.actor);
  return (await client.query("SELECT * FROM journal_entries WHERE id = $1", [id])).rows[0] as Row;
}

async function draftFor(client: Client, organizationId: string, environment: Environment, entryId: string): Promise<Row> {
  const entry = (await client.query("SELECT * FROM journal_entries WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [entryId, organizationId, environment])).rows[0] as Row | undefined;
  if (!entry) throw new EngineError("not_found", "No such journal entry.", 404);
  return entry;
}

/** Replace a draft's details and lines. Posted and void entries can't change. */
export async function updateManualEntry(client: Client, organizationId: string, environment: Environment, entryId: string, input: { date?: string; description?: string; memo?: string | null; lines?: LineInput[] }, actor: Actor): Promise<Row> {
  const entry = await draftFor(client, organizationId, environment, entryId);
  if (entry.status !== "draft") throw new EngineError("entry_not_draft", `This entry is ${entry.status}; only drafts can be edited.`, 409);
  if (input.lines) {
    const lines = cleanLines(input.lines);
    validateLines(lines, false);
    await checkAccounts(client, organizationId, environment, lines);
    await client.query("DELETE FROM journal_lines WHERE entry_id = $1", [entryId]);
    await insertLines(client, organizationId, environment, entryId, lines);
  }
  await client.query("UPDATE journal_entries SET entry_date = COALESCE($2::date, entry_date), description = COALESCE($3, description), memo = CASE WHEN $5 THEN $4 ELSE memo END, updated_at = now() WHERE id = $1", [
    entryId,
    input.date ?? null,
    input.description ?? null,
    input.memo ?? null,
    input.memo !== undefined
  ]);
  await audit(client, actor, { organizationId, environment, action: "journal_entry_updated", objectType: "journal_entry", objectId: entryId, next: { date: input.date, description: input.description, lines: input.lines?.length } });
  return (await client.query("SELECT * FROM journal_entries WHERE id = $1", [entryId])).rows[0] as Row;
}

async function linesOf(client: Client, entryId: string): Promise<LineInput[]> {
  return ((await client.query("SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY position", [entryId])).rows as Row[]).map((l) => ({
    accountId: l.account_id,
    debit: BigInt(l.debit),
    credit: BigInt(l.credit),
    memo: l.memo,
    customerId: l.customer_id,
    vendorId: l.vendor_id,
    invoiceId: l.invoice_id,
    billId: l.bill_id,
    expenseId: l.expense_id,
    paymentId: l.payment_id,
    outgoingTransferId: l.outgoing_transfer_id,
    observationId: l.observation_id,
    financialEventId: l.financial_event_id,
    assetId: l.asset_id,
    assetAmount: l.asset_amount === null ? null : BigInt(l.asset_amount),
    rateSource: l.rate_source
  }));
}

/** Approve a draft (a second person, or the same with the right permission). */
export async function approveManualEntry(client: Client, organizationId: string, environment: Environment, entryId: string, actor: Actor): Promise<Row> {
  const entry = await draftFor(client, organizationId, environment, entryId);
  if (entry.status !== "draft") throw new EngineError("entry_not_draft", `This entry is ${entry.status}.`, 409);
  validateLines(await linesOf(client, entryId), true);
  await client.query("UPDATE journal_entries SET status = 'approved', approved_at = now(), approved_by_id = $2, approved_by_label = $3, updated_at = now() WHERE id = $1", [entryId, actor.id ?? null, actor.label ?? null]);
  await audit(client, actor, { organizationId, environment, action: "journal_entry_approved", objectType: "journal_entry", objectId: entryId, previous: { status: "draft" }, next: { status: "approved" } });
  return (await client.query("SELECT * FROM journal_entries WHERE id = $1", [entryId])).rows[0] as Row;
}

/** Post a draft or approved manual entry. After this it can only be reversed. */
export async function postManualEntry(client: Client, organizationId: string, environment: Environment, entryId: string, actor: Actor): Promise<Row> {
  const entry = await draftFor(client, organizationId, environment, entryId);
  if (!["draft", "approved"].includes(entry.status)) throw new EngineError("entry_not_postable", `This entry is ${entry.status}.`, 409);
  const lines = await linesOf(client, entryId);
  validateLines(lines, true);
  await checkAccounts(client, organizationId, environment, lines);
  const date = isoDate(entry.entry_date instanceof Date ? entry.entry_date.toISOString() : String(entry.entry_date));
  if (await closedPeriodFor(client, organizationId, environment, date)) {
    throw new EngineError("period_closed", `The accounting period containing ${date} is closed. Change the date to an open period, or reopen the period first.`, 409);
  }
  await markPosted(client, entryId, actor);
  await audit(client, actor, { organizationId, environment, action: "journal_entry_posted", objectType: "journal_entry", objectId: entryId, previous: { status: entry.status }, next: { status: "posted" } });
  const total = lines.reduce((sum, l) => sum + (l.debit ?? 0n), 0n);
  await emitBusinessEvent(client, { organizationId, environment, type: "JOURNAL_ENTRY_POSTED", dedupeKey: `je-posted:${entryId}`, amount: total, journalEntryId: entryId, data: { journal_entry: { id: entryId, number: entry.number, date, description: entry.description } } });
  return (await client.query("SELECT * FROM journal_entries WHERE id = $1", [entryId])).rows[0] as Row;
}

/** Discard a draft or approved entry. It stays on record as void. */
export async function voidManualEntry(client: Client, organizationId: string, environment: Environment, entryId: string, reason: string, actor: Actor): Promise<Row> {
  const entry = await draftFor(client, organizationId, environment, entryId);
  if (!["draft", "approved"].includes(entry.status)) throw new EngineError("entry_not_voidable", entry.status === "posted" ? "A posted entry can't be voided. Reverse it instead." : `This entry is ${entry.status}.`, 409);
  await client.query("UPDATE journal_entries SET status = 'void', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1", [entryId, reason]);
  await audit(client, actor, { organizationId, environment, action: "journal_entry_voided", objectType: "journal_entry", objectId: entryId, previous: { status: entry.status }, next: { status: "void", reason } });
  return (await client.query("SELECT * FROM journal_entries WHERE id = $1", [entryId])).rows[0] as Row;
}

/**
 * Reverse a posted entry: a new posted entry with every debit and credit swapped, linked to the
 * original. The original stays exactly as it was.
 */
export async function reverseEntry(
  client: Client,
  organizationId: string,
  environment: Environment,
  entryId: string,
  opts: { reason: string; actor: Actor; date?: Date | string; sourceKey?: string; automatic?: boolean }
): Promise<{ entry: Row; created: boolean }> {
  const original = (await client.query("SELECT * FROM journal_entries WHERE id = $1 AND organization_id = $2 AND environment = $3", [entryId, organizationId, environment])).rows[0] as Row | undefined;
  if (!original) throw new EngineError("not_found", "No such journal entry.", 404);
  if (original.status !== "posted") throw new EngineError("entry_not_posted", "Only posted entries can be reversed.", 409);
  const already = (await client.query("SELECT * FROM journal_entries WHERE reverses_entry_id = $1 AND status <> 'void'", [entryId])).rows[0] as Row | undefined;
  if (already) {
    if (opts.automatic) return { entry: already, created: false };
    throw new EngineError("already_reversed", `${original.number} was already reversed by ${already.number}.`, 409);
  }
  const lines = (await linesOf(client, entryId)).map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
  const date = opts.date ?? new Date();
  if (!opts.automatic && (await closedPeriodFor(client, organizationId, environment, isoDate(date)))) {
    throw new EngineError("period_closed", "That date is in a closed period. Reverse it in an open period.", 409);
  }
  const result = await postEntry(client, {
    organizationId,
    environment,
    date,
    description: `Reversal of ${original.number}: ${original.description}`.slice(0, 500),
    memo: opts.reason,
    sourceType: original.source_type === "manual" ? "reversal" : original.source_type,
    sourceId: original.source_id,
    sourceKey: opts.sourceKey ?? `reversal:${entryId}`,
    lines,
    actor: opts.actor,
    reversesEntryId: entryId,
    currency: original.currency
  });
  if (result.created) {
    await audit(client, opts.actor, { organizationId, environment, action: "journal_entry_reversed", objectType: "journal_entry", objectId: entryId, next: { reversal_entry_id: result.entry.id, reason: opts.reason } });
    if (!opts.automatic) {
      const total = lines.reduce((sum, l) => sum + (l.debit ?? 0n), 0n);
      await emitBusinessEvent(client, { organizationId, environment, type: "JOURNAL_ENTRY_REVERSED", dedupeKey: `je-reversed:${entryId}`, amount: total, journalEntryId: result.entry.id, data: { journal_entry: { id: result.entry.id, number: result.entry.number, reverses: { id: original.id, number: original.number }, reason: opts.reason } } });
    }
  }
  return result;
}
