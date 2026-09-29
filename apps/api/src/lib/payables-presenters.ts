import type { Client } from "@setra/database";
import { money } from "@setra/engine";
import type { Environment } from "@setra/schemas";
import { notFound } from "./errors";
import { today } from "./dates";
import { serializeEntryRow } from "./journal-presenters";

/** How bills and expenses are presented in API responses. */

type Row = Record<string, any>;

export const serializeBill = (b: Row) => ({
  id: b.id,
  object: "bill",
  number: b.number,
  title: b.title,
  description: b.description,
  vendor: { id: b.vendor_id, name: b.vendor_name },
  account: b.account_code ? { id: b.account_id, code: b.account_code, name: b.account_name } : { id: b.account_id },
  amount: money(BigInt(b.amount)),
  amount_paid: money(BigInt(b.amount_paid)),
  amount_remaining: money(BigInt(b.amount) - BigInt(b.amount_paid)),
  currency: b.currency,
  bill_date: b.bill_date,
  due_date: b.due_date,
  status: b.status,
  overdue: ["approved", "partially_paid"].includes(b.status) && b.due_date !== null && b.due_date < today(),
  approved_by: b.approved_by_label,
  approved_at: b.approved_at,
  void_reason: b.void_reason,
  created_at: b.created_at
});

export const serializeExpense = (x: Row) => ({
  id: x.id,
  object: "expense",
  title: x.title,
  description: x.description,
  vendor: x.vendor_id ? { id: x.vendor_id, name: x.vendor_name } : null,
  account: x.account_code ? { id: x.account_id, code: x.account_code, name: x.account_name } : { id: x.account_id },
  amount: money(BigInt(x.amount)),
  currency: x.currency,
  expense_date: x.expense_date,
  method: x.method,
  outgoing_transfer: x.outgoing_transfer_id ? { id: x.outgoing_transfer_id, transaction_hash: x.transfer_tx ?? null } : null,
  paid_from_account_id: x.paid_from_account_id,
  reference: x.reference,
  notes: x.notes,
  status: x.status,
  rejected_reason: x.rejected_reason,
  created_by: x.created_by_label,
  approved_by: x.approved_by_label,
  approved_at: x.approved_at,
  created_at: x.created_at
});

export const BILL_SELECT = `SELECT b.*, v.name AS vendor_name, a.code AS account_code, a.name AS account_name FROM bills b JOIN vendors v ON v.id = b.vendor_id JOIN ledger_accounts a ON a.id = b.account_id`;

export const EXPENSE_SELECT = `SELECT x.*, v.name AS vendor_name, a.code AS account_code, a.name AS account_name, t.transaction_hash AS transfer_tx FROM expenses x LEFT JOIN vendors v ON v.id = x.vendor_id JOIN ledger_accounts a ON a.id = x.account_id LEFT JOIN outgoing_transfers t ON t.id = x.outgoing_transfer_id`;

export async function billDetail(c: Client, organizationId: string, environment: Environment, id: string) {
  const b = (await c.query(`${BILL_SELECT} WHERE b.id = $1 AND b.organization_id = $2 AND b.environment = $3`, [id, organizationId, environment])).rows[0] as Row | undefined;
  if (!b) throw notFound("bill");
  const payments = (await c.query("SELECT bp.*, t.transaction_hash, a.code AS account_code, a.name AS account_name FROM bill_payments bp LEFT JOIN outgoing_transfers t ON t.id = bp.outgoing_transfer_id LEFT JOIN ledger_accounts a ON a.id = bp.paid_from_account_id WHERE bp.bill_id = $1 ORDER BY bp.created_at", [id])).rows as Row[];
  const entries = (await c.query("SELECT * FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND (source_id = $3 OR source_id = ANY($4)) ORDER BY number", [organizationId, environment, id, payments.map((p) => p.id)])).rows as Row[];
  return {
    ...serializeBill(b),
    payments: payments.map((p) => ({ id: p.id, amount: money(BigInt(p.amount)), method: p.method, paid_on: p.paid_on, reference: p.reference, transaction_hash: p.transaction_hash, paid_from: p.account_code ? { id: p.paid_from_account_id, code: p.account_code, name: p.account_name } : null, by: p.actor_label, created_at: p.created_at })),
    journal_entries: entries.map(serializeEntryRow)
  };
}
