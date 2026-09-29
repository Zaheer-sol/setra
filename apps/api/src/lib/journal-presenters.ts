import type { Client } from "@setra/database";
import { explorerTx, money } from "@setra/engine";
import type { Environment } from "@setra/schemas";
import { notFound } from "./errors";

type Row = Record<string, any>;

/** Where a journal entry's source lives in the console, so every number can be traced back. */
export function sourceLink(type: string | null, id: string | null, row?: Row): string | null {
  if (!type || !id) return null;
  switch (type) {
    case "payment":
      return `/app/payments/${id}`;
    case "invoice":
      return `/app/invoices/${id}`;
    case "bill":
      return `/app/bills/${id}`;
    case "bill_payment":
      return row?.bill_id ? `/app/bills/${row.bill_id}` : null;
    case "expense":
      return `/app/expenses/${id}`;
    case "classification":
      return row?.payment_id ? `/app/payments/${row.payment_id}` : null;
    default:
      return null;
  }
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual entry",
  reversal: "Reversal",
  payment: "Payment",
  invoice: "Invoice",
  outgoing_transfer: "Outgoing transfer",
  refund: "Refund",
  resolution: "Exception resolution",
  bill: "Bill",
  bill_payment: "Bill payment",
  expense: "Expense",
  classification: "Classification"
};

export function serializeEntryRow(e: Row) {
  return {
    id: e.id,
    object: "journal_entry",
    number: e.number,
    date: e.entry_date,
    original_date: e.original_date,
    description: e.description,
    memo: e.memo,
    status: e.status,
    currency: e.currency,
    source: { type: e.source_type, label: SOURCE_LABEL[e.source_type] ?? e.source_type, id: e.source_id, link: sourceLink(e.source_type, e.source_id) },
    automatic: !["manual", "reversal"].includes(e.source_type) || (e.source_type === "reversal" && !e.created_by_id),
    reverses_entry_id: e.reverses_entry_id,
    total: e.total !== undefined ? money(BigInt(e.total)) : undefined,
    created_by: e.created_by_label,
    approved_by: e.approved_by_label,
    posted_by: e.posted_by_label,
    posted_at: e.posted_at,
    voided_at: e.voided_at,
    void_reason: e.void_reason,
    created_at: e.created_at
  };
}

/** A journal entry with its lines and everything each line points at. */
export async function journalEntryDetail(c: Client, organizationId: string, environment: Environment, id: string) {
  const e = (await c.query("SELECT * FROM journal_entries WHERE id = $1 AND organization_id = $2 AND environment = $3", [id, organizationId, environment])).rows[0] as Row | undefined;
  if (!e) throw notFound("journal entry");
  const lines = (
    await c.query(
      `SELECT l.*, a.code, a.name AS account_name, a.type AS account_type, cu.name AS customer_name, v.name AS vendor_name, i.number AS invoice_number, b.number AS bill_number,
              p.transaction_hash AS payment_tx, p.chain_id AS payment_chain, so.source_type = 'simulated' AS payment_simulated, ot.transaction_hash AS transfer_tx, ot.chain_id AS transfer_chain
         FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
         LEFT JOIN customers cu ON cu.id = l.customer_id LEFT JOIN vendors v ON v.id = l.vendor_id
         LEFT JOIN invoices i ON i.id = l.invoice_id LEFT JOIN bills b ON b.id = l.bill_id
         LEFT JOIN payments p ON p.id = l.payment_id LEFT JOIN source_observations so ON so.id = p.observation_id LEFT JOIN outgoing_transfers ot ON ot.id = l.outgoing_transfer_id
        WHERE l.entry_id = $1 ORDER BY l.position`,
      [id]
    )
  ).rows as Row[];
  const reversedBy = (await c.query("SELECT id, number FROM journal_entries WHERE reverses_entry_id = $1 AND status <> 'void'", [id])).rows[0] ?? null;
  const reverses = e.reverses_entry_id ? ((await c.query("SELECT id, number FROM journal_entries WHERE id = $1", [e.reverses_entry_id])).rows[0] ?? null) : null;
  let sourceRow: Row | undefined;
  if (e.source_type === "bill_payment") sourceRow = (await c.query("SELECT bill_id FROM bill_payments WHERE id = $1", [e.source_id])).rows[0];
  if (e.source_type === "classification") sourceRow = (await c.query("SELECT payment_id FROM transaction_classifications WHERE id = $1", [e.source_id])).rows[0];
  const debits = lines.reduce((s, l) => s + BigInt(l.debit), 0n);
  const credits = lines.reduce((s, l) => s + BigInt(l.credit), 0n);
  const audit = (await c.query("SELECT action, actor_label, created_at FROM audit_logs WHERE organization_id = $1 AND object_type = 'journal_entry' AND object_id = $2 ORDER BY created_at", [organizationId, id])).rows;
  return {
    ...serializeEntryRow(e),
    source: { type: e.source_type, label: SOURCE_LABEL[e.source_type] ?? e.source_type, id: e.source_id, link: sourceLink(e.source_type, e.source_id, sourceRow) },
    reverses,
    reversed_by: reversedBy,
    totals: { debit: money(debits), credit: money(credits), balanced: debits === credits },
    lines: lines.map((l) => ({
      id: l.id,
      account: { id: l.account_id, code: l.code, name: l.account_name, type: l.account_type },
      debit: BigInt(l.debit) > 0n ? money(BigInt(l.debit)) : null,
      credit: BigInt(l.credit) > 0n ? money(BigInt(l.credit)) : null,
      memo: l.memo,
      customer: l.customer_id ? { id: l.customer_id, name: l.customer_name } : null,
      vendor: l.vendor_id ? { id: l.vendor_id, name: l.vendor_name } : null,
      invoice: l.invoice_id ? { id: l.invoice_id, number: l.invoice_number } : null,
      bill: l.bill_id ? { id: l.bill_id, number: l.bill_number } : null,
      payment: l.payment_id ? { id: l.payment_id, transaction_hash: l.payment_tx, chain_id: l.payment_chain, explorer_url: explorerTx(Number(l.payment_chain), l.payment_tx, !!l.payment_simulated), simulated: !!l.payment_simulated } : null,
      outgoing_transfer: l.outgoing_transfer_id ? { id: l.outgoing_transfer_id, transaction_hash: l.transfer_tx, chain_id: l.transfer_chain, explorer_url: explorerTx(Number(l.transfer_chain), l.transfer_tx) } : null,
      asset: l.asset_id ? { id: l.asset_id, amount_base_units: l.asset_amount, rate_source: l.rate_source } : null
    })),
    history: audit
  };
}
