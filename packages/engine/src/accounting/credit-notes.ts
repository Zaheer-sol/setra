import type { Client } from "@setra/database";
import { networks } from "@setra/config";
import { newId, toBaseUnits, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { recomputeInvoice } from "../pipeline";
import { accountById, systemAccount, valueInReporting } from "./chart";
import { accountSafely, ensureBooks } from "./posting-rules";
import { isoDate, postEntry } from "./ledger";

type Row = Record<string, any>;

/**
 * Customer credits and credit notes.
 *
 * Applying a credit moves an overpayment's excess from the invoice it overpaid to another open
 * invoice of the same customer (Dr Customer Credits, Cr Accounts Receivable). It's recorded as its
 * own append-only row, which the invoice balance includes, and undone with a reversing row.
 *
 * A credit note lowers what a customer owes on an invoice (Dr Refunds & Returns or a chosen revenue
 * account, Cr Accounts Receivable). The invoice's amount due goes down; the original total and the
 * note stay on record.
 */

export async function createCreditNote(client: Client, organizationId: string, environment: Environment, input: { invoice_id: string; amount: string; reason: string; account_id?: string | null }, actor: Actor): Promise<Row> {
  const s = await ensureBooks(client, organizationId, environment);
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [input.invoice_id, organizationId, environment])).rows[0] as Row | undefined;
  if (!inv) throw new EngineError("not_found", "No such invoice.", 404);
  if (inv.status === "cancelled") throw new EngineError("invoice_cancelled", "That invoice is cancelled.", 409);
  const decimals = networks().asset(inv.asset_id)?.asset.decimals ?? 6;
  let amount: bigint;
  try {
    amount = toBaseUnits(input.amount, decimals);
  } catch {
    throw new EngineError("invalid_amount", "Enter the amount as a decimal, like 150.00.", 422);
  }
  const owed = BigInt(inv.amount_due) - BigInt(inv.amount_paid) - BigInt(inv.amount_written_off);
  if (amount <= 0n) throw new EngineError("invalid_amount", "Enter an amount greater than zero.", 422);
  if (amount > owed) throw new EngineError("exceeds_owed", "A credit note can't be more than what's still owed. For money already paid, refund it or keep it as customer credit.", 422);
  if (amount >= BigInt(inv.amount_due)) throw new EngineError("use_cancel", "To credit the whole invoice, cancel it instead.", 422);
  let account: Row | null = null;
  if (input.account_id) {
    account = await accountById(client, organizationId, environment, input.account_id);
    if (account.type !== "revenue") throw new EngineError("invalid_account", "Choose a revenue account (or leave it to use Refunds & Returns).", 422);
  }
  const count = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_notes WHERE organization_id = $1 AND environment = $2", [organizationId, environment])).rows[0]!.n;
  const number = `CN-${String(count + 1).padStart(5, "0")}`;
  const id = newId("creditNote");
  await client.query(
    `INSERT INTO credit_notes (id, organization_id, environment, invoice_id, customer_id, number, amount, reason, account_id, actor_type, actor_id, actor_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, organizationId, environment, inv.id, inv.customer_id, number, amount.toString(), input.reason, account?.id ?? null, actor.type, actor.id ?? null, actor.label ?? null]
  );
  await client.query("UPDATE invoices SET amount_due = amount_due - $2, amount_credited = amount_credited + $2, updated_at = now() WHERE id = $1", [inv.id, amount.toString()]);
  // Open payment intents were for the old amount.
  await client.query("UPDATE payment_intents SET status = 'cancelled', updated_at = now() WHERE invoice_id = $1 AND status = 'open'", [inv.id]);
  await recomputeInvoice(client, inv.id);
  if (s.method === "accrual") {
    await accountSafely(client, { organizationId, environment, sourceKey: `credit-note:${id}`, sourceType: "credit_note", sourceId: id }, async (settings) => {
      const { amount: value, rateSource } = valueInReporting(inv.asset_id, amount, settings.reportingCurrency);
      const debit = account ?? (await systemAccount(client, organizationId, environment, "refunds"));
      const ar = await systemAccount(client, organizationId, environment, "accounts_receivable");
      const refs = { customerId: inv.customer_id, invoiceId: inv.id, assetId: inv.asset_id, assetAmount: amount, rateSource };
      await postEntry(client, {
        organizationId,
        environment,
        date: isoDate(new Date()),
        description: `Credit note ${number} on ${inv.number}`,
        memo: input.reason,
        sourceType: "credit_note",
        sourceId: id,
        sourceKey: `credit-note:${id}`,
        actor,
        lines: [
          { ...refs, accountId: debit.id, debit: value, memo: input.reason },
          { ...refs, accountId: ar.id, credit: value, memo: `Reduces ${inv.number}` }
        ]
      });
    });
  }
  await audit(client, actor, { organizationId, environment, action: "credit_note_created", objectType: "invoice", objectId: inv.id, next: { credit_note: number, amount: amount.toString(), reason: input.reason } });
  return (await client.query("SELECT * FROM credit_notes WHERE id = $1", [id])).rows[0] as Row;
}
