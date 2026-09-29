import { isUniqueViolation, type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { systemAccount, valueInReporting } from "./chart";
import { ensureBooks } from "./posting-rules";
import { isoDate, postEntry, reverseEntry } from "./ledger";
import { emitBusinessEvent } from "./business-events";
import { money } from "./reports";
import { ledgerAmount } from "./amounts";
import { spendAccount, usableTransfer, paidFromAccount } from "./payment-sources";
import { vendorById } from "./vendors";

type Row = Record<string, any>;

export interface BillInput {
  vendor_id: string;
  number: string;
  title: string;
  description?: string | null;
  amount: string;
  account_id?: string | null;
  bill_date: string;
  due_date?: string | null;
}

export async function createBill(client: Client, organizationId: string, environment: Environment, input: BillInput & { approve?: boolean }, actor: Actor): Promise<Row> {
  await ensureBooks(client, organizationId, environment);
  const vendor = await vendorById(client, organizationId, environment, input.vendor_id);
  const account = await spendAccount(client, organizationId, environment, input.account_id, vendor);
  const amount = ledgerAmount(input.amount);
  if (input.due_date && input.due_date < input.bill_date) throw new EngineError("invalid_due_date", "The due date is before the bill date.", 422);
  const id = newId("bill");
  try {
    await client.query(
      `INSERT INTO bills (id, organization_id, environment, vendor_id, number, title, description, amount, account_id, bill_date, due_date, created_by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, organizationId, environment, vendor.id, input.number, input.title, input.description ?? null, amount.toString(), account.id, input.bill_date, input.due_date ?? null, actor.id ?? null]
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new EngineError("bill_number_taken", `${vendor.name} already has a bill numbered ${input.number}.`, 409);
    throw error;
  }
  await audit(client, actor, { organizationId, environment, action: "bill_created", objectType: "bill", objectId: id, next: { vendor: vendor.name, number: input.number, amount: input.amount } });
  if (input.approve) return approveBill(client, organizationId, environment, id, actor);
  return (await client.query("SELECT * FROM bills WHERE id = $1", [id])).rows[0] as Row;
}

/** Approve a bill: it becomes a payable (Dr expense/asset, Cr Accounts Payable). */
export async function approveBill(client: Client, organizationId: string, environment: Environment, billId: string, actor: Actor): Promise<Row> {
  const bill = (await client.query("SELECT * FROM bills WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [billId, organizationId, environment])).rows[0] as Row | undefined;
  if (!bill) throw new EngineError("not_found", "No such bill.", 404);
  if (bill.status !== "draft") throw new EngineError("bill_not_draft", `This bill is ${bill.status.replace("_", " ")}.`, 409);
  const vendor = (await client.query("SELECT * FROM vendors WHERE id = $1", [bill.vendor_id])).rows[0] as Row;
  const ap = await systemAccount(client, organizationId, environment, "accounts_payable");
  const amount = BigInt(bill.amount);
  await client.query("UPDATE bills SET status = 'approved', approved_at = now(), approved_by_id = $2, approved_by_label = $3, updated_at = now() WHERE id = $1", [billId, actor.id ?? null, actor.label ?? null]);
  const { entry } = await postEntry(client, {
    organizationId,
    environment,
    date: bill.bill_date,
    description: `Bill ${bill.number} from ${vendor.name}: ${bill.title}`,
    memo: bill.description,
    sourceType: "bill",
    sourceId: bill.id,
    sourceKey: `bill:${bill.id}`,
    actor,
    lines: [
      { accountId: bill.account_id, debit: amount, vendorId: vendor.id, billId: bill.id, memo: bill.title },
      { accountId: ap.id, credit: amount, vendorId: vendor.id, billId: bill.id, memo: `Owed to ${vendor.name}` }
    ]
  });
  await emitBusinessEvent(client, { organizationId, environment, type: "PAYABLE_CREATED", dedupeKey: `payable:${bill.id}`, amount, vendorId: vendor.id, journalEntryId: entry.id, data: { bill: { id: bill.id, number: bill.number, title: bill.title, amount: money(amount), due_date: bill.due_date }, vendor: { id: vendor.id, name: vendor.name } } });
  await audit(client, actor, { organizationId, environment, action: "bill_approved", objectType: "bill", objectId: billId, previous: { status: "draft" }, next: { status: "approved", journal_entry_id: entry.id } });
  return (await client.query("SELECT * FROM bills WHERE id = $1", [billId])).rows[0] as Row;
}

/** Void a bill that has no payments. An approved bill's payable is reversed. */
export async function voidBill(client: Client, organizationId: string, environment: Environment, billId: string, reason: string, actor: Actor): Promise<Row> {
  const bill = (await client.query("SELECT * FROM bills WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [billId, organizationId, environment])).rows[0] as Row | undefined;
  if (!bill) throw new EngineError("not_found", "No such bill.", 404);
  if (!["draft", "approved"].includes(bill.status) || BigInt(bill.amount_paid) > 0n) throw new EngineError("bill_not_voidable", "A bill with payments can't be voided.", 409);
  if (bill.status === "approved") {
    const e = (await client.query("SELECT id FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [organizationId, environment, `bill:${bill.id}`])).rows[0] as Row | undefined;
    if (e) await reverseEntry(client, organizationId, environment, e.id, { reason: `Bill voided: ${reason}`, actor, sourceKey: `bill-void:${bill.id}` });
  }
  await client.query("UPDATE bills SET status = 'void', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1", [billId, reason]);
  await audit(client, actor, { organizationId, environment, action: "bill_voided", objectType: "bill", objectId: billId, previous: { status: bill.status }, next: { status: "void", reason } });
  return (await client.query("SELECT * FROM bills WHERE id = $1", [billId])).rows[0] as Row;
}

/**
 * Pay (part of) an approved bill: onchain (linking the observed outgoing transfer, which proves it) or
 * off-chain (from a bank, card or owner account). Dr Accounts Payable, Cr the source.
 */

export async function payBill(
  client: Client,
  organizationId: string,
  environment: Environment,
  billId: string,
  input: { outgoing_transfer_id?: string | null; paid_from_account_id?: string | null; amount?: string; paid_on?: string; reference?: string | null; memo?: string | null },
  actor: Actor
): Promise<Row> {
  const bill = (await client.query("SELECT * FROM bills WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [billId, organizationId, environment])).rows[0] as Row | undefined;
  if (!bill) throw new EngineError("not_found", "No such bill.", 404);
  if (!["approved", "partially_paid"].includes(bill.status)) throw new EngineError("bill_not_payable", bill.status === "draft" ? "Approve the bill before paying it." : `This bill is ${bill.status.replace("_", " ")}.`, 409);
  if (!input.outgoing_transfer_id === !input.paid_from_account_id) throw new EngineError("payment_source_required", "Link the onchain transfer, or choose the account it was paid from (not both).", 422);
  const s = await ensureBooks(client, organizationId, environment);
  const remaining = BigInt(bill.amount) - BigInt(bill.amount_paid);
  let amount: bigint;
  let creditAccount: string;
  let transfer: Row | null = null;
  if (input.outgoing_transfer_id) {
    transfer = await usableTransfer(client, organizationId, environment, input.outgoing_transfer_id);
    amount = valueInReporting(transfer.asset_id, BigInt(transfer.amount), s.reportingCurrency).amount;
    creditAccount = (await systemAccount(client, organizationId, environment, "transfers_to_classify")).id;
  } else {
    amount = input.amount ? ledgerAmount(input.amount) : remaining;
    creditAccount = (await paidFromAccount(client, organizationId, environment, input.paid_from_account_id!)).id;
  }
  if (amount > remaining) throw new EngineError("overpays_bill", `That's more than the ${money(remaining)} still owed on this bill.`, 422);
  const vendor = (await client.query("SELECT * FROM vendors WHERE id = $1", [bill.vendor_id])).rows[0] as Row;
  const ap = await systemAccount(client, organizationId, environment, "accounts_payable");
  const id = newId("billPayment");
  const paidOn = input.paid_on ?? (transfer ? isoDate(new Date(transfer.block_timestamp)) : isoDate(new Date()));
  await client.query(
    `INSERT INTO bill_payments (id, organization_id, environment, bill_id, amount, method, outgoing_transfer_id, paid_from_account_id, paid_on, reference, memo, actor_type, actor_id, actor_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, organizationId, environment, bill.id, amount.toString(), transfer ? "onchain" : "offchain", transfer?.id ?? null, transfer ? null : creditAccount, paidOn, input.reference ?? transfer?.transaction_hash ?? null, input.memo ?? null, actor.type, actor.id ?? null, actor.label ?? null]
  );
  const paid = BigInt(bill.amount_paid) + amount;
  await client.query("UPDATE bills SET amount_paid = $2, status = $3, updated_at = now() WHERE id = $1", [bill.id, paid.toString(), paid >= BigInt(bill.amount) ? "paid" : "partially_paid"]);
  const { entry } = await postEntry(client, {
    organizationId,
    environment,
    date: paidOn,
    description: `Paid ${vendor.name}: bill ${bill.number}`,
    memo: transfer ? `Transaction ${transfer.transaction_hash}` : (input.reference ?? null),
    sourceType: "bill_payment",
    sourceId: id,
    sourceKey: `bill-payment:${id}`,
    actor,
    lines: [
      { accountId: ap.id, debit: amount, vendorId: vendor.id, billId: bill.id, memo: `Settles bill ${bill.number}` },
      { accountId: creditAccount, credit: amount, vendorId: vendor.id, billId: bill.id, outgoingTransferId: transfer?.id ?? null, assetId: transfer?.asset_id ?? null, assetAmount: transfer ? BigInt(transfer.amount) : null, rateSource: transfer ? `peg:${s.reportingCurrency}` : null, memo: transfer ? "Onchain payment" : "Paid off-chain" }
    ]
  });
  await emitBusinessEvent(client, { organizationId, environment, type: "PAYABLE_SETTLED", dedupeKey: `payable-settled:${id}`, amount, vendorId: vendor.id, journalEntryId: entry.id, data: { bill: { id: bill.id, number: bill.number, title: bill.title, remaining: money(BigInt(bill.amount) - paid) }, vendor: { id: vendor.id, name: vendor.name }, payment: { id, amount: money(amount), method: transfer ? "onchain" : "offchain", transaction_hash: transfer?.transaction_hash ?? null } } });
  await audit(client, actor, { organizationId, environment, action: "bill_paid", objectType: "bill", objectId: bill.id, next: { bill_payment_id: id, amount: money(amount), outgoing_transfer_id: transfer?.id ?? null } });
  return (await client.query("SELECT * FROM bills WHERE id = $1", [bill.id])).rows[0] as Row;
}
