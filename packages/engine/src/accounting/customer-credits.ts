import type { Client } from "@setra/database";
import { networks } from "@setra/config";
import { newId, toBaseUnits, type Environment } from "@setra/schemas";
import { audit, EngineError, SYSTEM, type Actor } from "../context";
import { closeExceptionsBySystem, recomputeInvoice } from "../pipeline";
import { systemAccount, valueInReporting } from "./chart";
import { accountSafely } from "./posting-rules";
import { postEntry, reverseEntry } from "./ledger";

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

/** Excess on the invoice a payment overpaid, less any of it already refunded. Base units of the invoice asset. */
export async function availableCredit(client: Client, payment: Row): Promise<{ invoice: Row | null; amount: bigint }> {
  if (payment.status !== "overpaid" || !payment.invoice_id) return { invoice: null, amount: 0n };
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1", [payment.invoice_id])).rows[0] as Row;
  const refunded = BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(amount), 0)::text AS s FROM refunds WHERE payment_id = $1", [payment.id])).rows[0]!.s);
  const excess = BigInt(inv.amount_paid) - BigInt(inv.amount_due) - refunded;
  return { invoice: inv, amount: excess > 0n ? excess : 0n };
}

export async function applyCustomerCredit(client: Client, organizationId: string, environment: Environment, input: { payment_id: string; invoice_id: string; amount?: string; reason?: string | null }, actor: Actor): Promise<Row> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [input.payment_id, organizationId, environment])).rows[0] as Row | undefined;
  if (!payment) throw new EngineError("not_found", "No such payment.", 404);
  const { invoice: from, amount: available } = await availableCredit(client, payment);
  if (!from || available <= 0n) throw new EngineError("no_credit", "This payment has no unused overpayment to apply.", 409);
  const to = (await client.query("SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [input.invoice_id, organizationId, environment])).rows[0] as Row | undefined;
  if (!to) throw new EngineError("not_found", "No such invoice.", 404);
  if (to.id === from.id) throw new EngineError("same_invoice", "Choose a different invoice.", 422);
  if (to.customer_id !== from.customer_id) throw new EngineError("different_customer", "A customer's credit can only go to their own invoices.", 422);
  if (to.asset_id !== from.asset_id) throw new EngineError("different_asset", "The credit and the invoice must be in the same stablecoin.", 422);
  if (!["open", "partially_paid", "expired"].includes(to.status)) throw new EngineError("invoice_not_open", `That invoice is ${to.status.replace("_", " ")}.`, 409);
  const owed = BigInt(to.amount_due) - BigInt(to.amount_paid) - BigInt(to.amount_written_off);
  const decimals = networks().asset(to.asset_id)?.asset.decimals ?? 6;
  const requested = input.amount ? toBaseUnits(input.amount, decimals) : available < owed ? available : owed;
  if (requested <= 0n) throw new EngineError("invalid_amount", "Enter an amount greater than zero.", 422);
  if (requested > available) throw new EngineError("exceeds_credit", "That's more than the customer's unused credit on this payment.", 422);
  if (requested > owed) throw new EngineError("exceeds_owed", "That's more than the customer still owes on that invoice.", 422);

  const id = newId("creditApplication");
  await client.query(
    `INSERT INTO credit_applications (id, organization_id, environment, customer_id, payment_id, from_invoice_id, to_invoice_id, asset_id, amount, reason, actor_type, actor_id, actor_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, organizationId, environment, from.customer_id, payment.id, from.id, to.id, to.asset_id, requested.toString(), input.reason ?? null, actor.type, actor.id ?? null, actor.label ?? null]
  );
  await recomputeInvoice(client, from.id);
  await recomputeInvoice(client, to.id);
  if (requested === available) {
    await closeExceptionsBySystem(client, { organizationId, paymentId: payment.id, types: ["overpayment"], reason: `The overpayment was applied to ${to.number}.` });
  }
  await accountSafely(client, { organizationId, environment, sourceKey: `credit-apply:${id}`, sourceType: "credit_application", sourceId: id }, async (s) => {
    const { amount, rateSource } = valueInReporting(to.asset_id, requested, s.reportingCurrency);
    const credits = await systemAccount(client, organizationId, environment, "customer_credits");
    const target = s.method === "accrual" ? await systemAccount(client, organizationId, environment, "accounts_receivable") : { id: to.revenue_account_id ?? (await systemAccount(client, organizationId, environment, "sales")).id };
    const refs = { customerId: to.customer_id, paymentId: payment.id, assetId: to.asset_id, assetAmount: requested, rateSource };
    await postEntry(client, {
      organizationId,
      environment,
      date: new Date(),
      description: `Customer credit applied to ${to.number}`,
      memo: `From the overpayment on ${from.number}${input.reason ? `: ${input.reason}` : ""}`,
      // Filed under the payment, so if the payment is ever reversed this entry is reversed with it.
      sourceType: "payment",
      sourceId: payment.id,
      sourceKey: `credit-apply:${id}`,
      actor,
      lines: [
        { ...refs, accountId: credits.id, debit: amount, invoiceId: from.id, memo: `Credit from ${from.number}` },
        { ...refs, accountId: target.id, credit: amount, invoiceId: to.id, memo: `Applied to ${to.number}` }
      ]
    });
  });
  await audit(client, actor, { organizationId, environment, action: "customer_credit_applied", objectType: "invoice", objectId: to.id, next: { credit_application_id: id, payment_id: payment.id, from_invoice: from.number, amount: requested.toString() } });
  return (await client.query("SELECT * FROM credit_applications WHERE id = $1", [id])).rows[0] as Row;
}

/** Undo a credit application: a reversing row, both invoices recomputed, the entry reversed. */
export async function undoCustomerCredit(client: Client, organizationId: string, environment: Environment, applicationId: string, reason: string, actor: Actor): Promise<void> {
  const app = (await client.query("SELECT * FROM credit_applications WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [applicationId, organizationId, environment])).rows[0] as Row | undefined;
  if (!app || BigInt(app.amount) < 0n) throw new EngineError("not_found", "No such credit application.", 404);
  if ((await client.query("SELECT 1 FROM credit_applications WHERE reverses_id = $1", [applicationId])).rows[0]) throw new EngineError("already_undone", "That credit application was already undone.", 409);
  const to = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [app.to_invoice_id])).rows[0] as Row;
  await insertReversal(client, app, reason, actor);
  await recomputeInvoice(client, app.from_invoice_id);
  await recomputeInvoice(client, to.id);
  const entry = (await client.query("SELECT id FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [organizationId, environment, `credit-apply:${applicationId}`])).rows[0] as Row | undefined;
  if (entry) await reverseEntry(client, organizationId, environment, entry.id, { reason: `Credit application undone: ${reason}`, actor, sourceKey: `credit-undo:${applicationId}`, automatic: true });
  await audit(client, actor, { organizationId, environment, action: "customer_credit_undone", objectType: "invoice", objectId: to.id, next: { credit_application_id: applicationId, reason } });
}

async function insertReversal(client: Client, app: Row, reason: string, actor: Actor): Promise<void> {
  await client.query(
    `INSERT INTO credit_applications (id, organization_id, environment, customer_id, payment_id, from_invoice_id, to_invoice_id, asset_id, amount, reverses_id, reason, actor_type, actor_id, actor_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [newId("creditApplication"), app.organization_id, app.environment, app.customer_id, app.payment_id, app.from_invoice_id, app.to_invoice_id, app.asset_id, (-BigInt(app.amount)).toString(), app.id, reason, actor.type, actor.id ?? null, actor.label ?? null]
  );
}

/** When a payment is reversed (a reorg), the credit it provided is withdrawn. Returns the invoices touched. */
export async function reverseCreditApplicationsForPayment(client: Client, paymentId: string, reason: string): Promise<string[]> {
  const active = (
    await client.query(
      `SELECT a.* FROM credit_applications a WHERE a.payment_id = $1 AND a.amount > 0 AND NOT EXISTS (SELECT 1 FROM credit_applications r WHERE r.reverses_id = a.id)`,
      [paymentId]
    )
  ).rows as Row[];
  const touched = new Set<string>();
  for (const a of active) {
    await insertReversal(client, a, `Payment reversed: ${reason}`, SYSTEM);
    touched.add(a.from_invoice_id);
    touched.add(a.to_invoice_id);
  }
  return [...touched];
}

export async function activeCreditApplications(client: Client, paymentId: string): Promise<Row[]> {
  return (
    await client.query(
      `SELECT a.*, t.number AS to_number FROM credit_applications a JOIN invoices t ON t.id = a.to_invoice_id
        WHERE a.payment_id = $1 AND a.amount > 0 AND NOT EXISTS (SELECT 1 FROM credit_applications r WHERE r.reverses_id = a.id) ORDER BY a.created_at`,
      [paymentId]
    )
  ).rows as Row[];
}
