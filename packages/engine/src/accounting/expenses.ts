import { type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { systemAccount, valueInReporting } from "./chart";
import { ensureBooks } from "./posting-rules";
import { isoDate, postEntry } from "./ledger";
import { emitBusinessEvent } from "./business-events";
import { money } from "./reports";
import { ledgerAmount } from "./amounts";
import { spendAccount, usableTransfer, paidFromAccount } from "./payment-sources";
import { vendorById } from "./vendors";

type Row = Record<string, any>;

export interface ExpenseInput {
  title: string;
  description?: string | null;
  amount?: string;
  account_id?: string | null;
  vendor_id?: string | null;
  expense_date?: string;
  reference?: string | null;
  outgoing_transfer_id?: string | null;
  paid_from_account_id?: string | null;
  notes?: string | null;
}

/**
 * Record an expense. Paid onchain: link the observed outgoing transfer (its amount is the expense).
 * Paid off-chain: choose the account it came from. Created pending; approving posts it.
 */

export async function createExpense(client: Client, organizationId: string, environment: Environment, input: ExpenseInput & { approve?: boolean }, actor: Actor): Promise<Row> {
  const s = await ensureBooks(client, organizationId, environment);
  if (!input.outgoing_transfer_id === !input.paid_from_account_id) throw new EngineError("payment_source_required", "Link the onchain transfer it was paid with, or choose the account it was paid from.", 422);
  const vendor = input.vendor_id ? await vendorById(client, organizationId, environment, input.vendor_id) : null;
  const account = await spendAccount(client, organizationId, environment, input.account_id, vendor);
  let amount: bigint;
  let date = input.expense_date;
  if (input.outgoing_transfer_id) {
    const t = await usableTransfer(client, organizationId, environment, input.outgoing_transfer_id);
    amount = valueInReporting(t.asset_id, BigInt(t.amount), s.reportingCurrency).amount;
    if (input.amount && ledgerAmount(input.amount) !== amount) throw new EngineError("amount_mismatch", `The linked transfer is ${money(amount)}; the expense amount must match it.`, 422);
    date ??= isoDate(new Date(t.block_timestamp));
  } else {
    if (!input.amount) throw new EngineError("amount_required", "Enter the expense amount.", 422);
    amount = ledgerAmount(input.amount);
    await paidFromAccount(client, organizationId, environment, input.paid_from_account_id!);
  }
  date ??= isoDate(new Date());
  const id = newId("expense");
  await client.query(
    `INSERT INTO expenses (id, organization_id, environment, vendor_id, title, description, amount, account_id, expense_date, reference, method, outgoing_transfer_id, paid_from_account_id, notes, created_by_id, created_by_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, organizationId, environment, vendor?.id ?? null, input.title, input.description ?? null, amount.toString(), account.id, date, input.reference ?? null, input.outgoing_transfer_id ? "onchain" : "offchain", input.outgoing_transfer_id ?? null, input.paid_from_account_id ?? null, input.notes ?? null, actor.id ?? null, actor.label ?? null]
  );
  await audit(client, actor, { organizationId, environment, action: "expense_created", objectType: "expense", objectId: id, next: { title: input.title, amount: money(amount), vendor: vendor?.name ?? null } });
  if (input.approve) return approveExpense(client, organizationId, environment, id, actor);
  return (await client.query("SELECT * FROM expenses WHERE id = $1", [id])).rows[0] as Row;
}

/** Approve an expense: Dr the expense account, Cr Transfers to Classify (onchain) or the paying account. */
export async function approveExpense(client: Client, organizationId: string, environment: Environment, expenseId: string, actor: Actor): Promise<Row> {
  const x = (await client.query("SELECT * FROM expenses WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [expenseId, organizationId, environment])).rows[0] as Row | undefined;
  if (!x) throw new EngineError("not_found", "No such expense.", 404);
  if (x.status !== "pending") throw new EngineError("expense_not_pending", `This expense is ${x.status}.`, 409);
  const s = await ensureBooks(client, organizationId, environment);
  const vendor = x.vendor_id ? ((await client.query("SELECT * FROM vendors WHERE id = $1", [x.vendor_id])).rows[0] as Row) : null;
  const transfer = x.outgoing_transfer_id ? ((await client.query("SELECT * FROM outgoing_transfers WHERE id = $1", [x.outgoing_transfer_id])).rows[0] as Row) : null;
  const creditAccount = transfer ? (await systemAccount(client, organizationId, environment, "transfers_to_classify")).id : x.paid_from_account_id;
  const amount = BigInt(x.amount);
  await client.query("UPDATE expenses SET status = 'approved', approved_at = now(), approved_by_id = $2, approved_by_label = $3, updated_at = now() WHERE id = $1", [x.id, actor.id ?? null, actor.label ?? null]);
  const { entry } = await postEntry(client, {
    organizationId,
    environment,
    date: x.expense_date,
    description: `Expense${vendor ? ` (${vendor.name})` : ""}: ${x.title}`,
    memo: x.description ?? x.notes ?? null,
    sourceType: "expense",
    sourceId: x.id,
    sourceKey: `expense:${x.id}`,
    actor,
    lines: [
      { accountId: x.account_id, debit: amount, vendorId: vendor?.id ?? null, expenseId: x.id, memo: x.title },
      { accountId: creditAccount, credit: amount, vendorId: vendor?.id ?? null, expenseId: x.id, outgoingTransferId: transfer?.id ?? null, assetId: transfer?.asset_id ?? null, assetAmount: transfer ? BigInt(transfer.amount) : null, rateSource: transfer ? `peg:${s.reportingCurrency}` : null, memo: transfer ? `Transaction ${transfer.transaction_hash}` : "Paid off-chain" }
    ]
  });
  await emitBusinessEvent(client, { organizationId, environment, type: "EXPENSE_RECORDED", dedupeKey: `expense:${x.id}`, amount, vendorId: vendor?.id ?? null, journalEntryId: entry.id, data: { expense: { id: x.id, title: x.title, amount: money(amount), date: isoDate(x.expense_date instanceof Date ? x.expense_date : String(x.expense_date)), method: x.method }, vendor: vendor ? { id: vendor.id, name: vendor.name } : null } });
  await audit(client, actor, { organizationId, environment, action: "expense_approved", objectType: "expense", objectId: x.id, previous: { status: "pending" }, next: { status: "approved", journal_entry_id: entry.id } });
  return (await client.query("SELECT * FROM expenses WHERE id = $1", [x.id])).rows[0] as Row;
}

export async function rejectExpense(client: Client, organizationId: string, environment: Environment, expenseId: string, reason: string, actor: Actor): Promise<Row> {
  const x = (await client.query("SELECT * FROM expenses WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [expenseId, organizationId, environment])).rows[0] as Row | undefined;
  if (!x) throw new EngineError("not_found", "No such expense.", 404);
  if (x.status !== "pending") throw new EngineError("expense_not_pending", `This expense is ${x.status}; approved expenses are corrected with a reversing entry.`, 409);
  await client.query("UPDATE expenses SET status = 'rejected', rejected_reason = $2, updated_at = now() WHERE id = $1", [x.id, reason]);
  await audit(client, actor, { organizationId, environment, action: "expense_rejected", objectType: "expense", objectId: x.id, previous: { status: "pending" }, next: { status: "rejected", reason } });
  return (await client.query("SELECT * FROM expenses WHERE id = $1", [x.id])).rows[0] as Row;
}
