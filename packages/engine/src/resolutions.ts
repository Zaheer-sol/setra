import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { ALLOWED_RESOLUTIONS, newId, type ExceptionType, type ResolveExceptionInput } from "@setra/schemas";
import { audit, EngineError, log, type Actor } from "./context";
import { emitFinancialEvent } from "./financial-events";
import { recordRefund } from "./corrections";
import { applyPayment, closeExceptionsBySystem, recomputeInvoice } from "./pipeline";
import { accountWriteOff } from "./accounting/posting-rules";

type Row = Record<string, any>;

/**
 * Resolve an exception on behalf of an operator. The exception, the payment's prior state and the
 * operator's reason are recorded permanently; nothing about the original decision is erased.
 */
export async function resolveException(client: Client, organizationId: string, exceptionId: string, input: ResolveExceptionInput, actor: Actor): Promise<{ exception: Row; resolutionId: string }> {
  const exception = (await client.query("SELECT * FROM exceptions WHERE id = $1 AND organization_id = $2 FOR UPDATE", [exceptionId, organizationId])).rows[0] as Row | undefined;
  if (!exception) throw new EngineError("not_found", "No such exception.", 404);
  if (exception.status !== "open") throw new EngineError("exception_already_resolved", "This exception has already been resolved.", 409);
  const allowed = ALLOWED_RESOLUTIONS[exception.type as ExceptionType];
  if (!allowed.includes(input.action)) {
    throw new EngineError("resolution_not_allowed", `A ${exception.type.replaceAll("_", " ")} can be resolved with: ${allowed.join(", ")}.`, 422);
  }

  const payment = (await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [exception.payment_id])).rows[0] as Row;
  const previousInvoice = payment.invoice_id ? ((await client.query("SELECT id, number, status, amount_paid FROM invoices WHERE id = $1", [payment.invoice_id])).rows[0] as Row) : null;
  const previousState = {
    exception_status: exception.status,
    exception_type: exception.type,
    payment_status: payment.status,
    invoice: previousInvoice
  };

  let target: Row | null = null;
  if (input.action === "assign") {
    if (!["needs_review"].includes(payment.status)) throw new EngineError("payment_already_applied", "This payment is already applied to an invoice.", 409);
    target = (await client.query("SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [input.invoice_id, organizationId, payment.environment])).rows[0] as Row | undefined ?? null;
    if (!target) throw new EngineError("invoice_not_found", "Choose an invoice from this workspace and mode.", 404);
    if (target.status === "cancelled") throw new EngineError("invoice_cancelled", "A cancelled invoice cannot receive payments.", 409);
    const paymentAsset = payment.asset_id ? networks().asset(payment.asset_id) : undefined;
    if (!paymentAsset || paymentAsset.asset.pegCurrency !== target.currency) {
      throw new EngineError("asset_mismatch", "This payment's asset can't settle an invoice in that currency.", 422);
    }
  }
  if (input.action === "write_off" && !exception.invoice_id) throw new EngineError("invalid_resolution", "Nothing to write off.", 422);

  const resolutionId = newId("resolution");
  await client.query(
    `INSERT INTO resolutions (id, organization_id, environment, exception_id, action, reason, invoice_id, actor_type, actor_id, actor_label, previous_state, new_state, rule_version, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}','manual-v1.0',$12)`,
    [resolutionId, organizationId, exception.environment, exception.id, input.action, input.reason, target?.id ?? exception.invoice_id ?? null, actor.type, actor.id ?? null, actor.label ?? null, JSON.stringify(previousState), actor.requestId ?? null]
  );
  // Close this exception first so follow-up exceptions (e.g. partial after assignment) are independent.
  await client.query("UPDATE exceptions SET status = 'resolved', resolution_id = $1, resolved_at = now(), updated_at = now() WHERE id = $2", [resolutionId, exception.id]);

  switch (input.action) {
    case "assign": {
      await applyPayment(client, { payment, invoiceId: target!.id, kind: "manual", resolutionId, actor });
      if (input.remember_sender) await rememberSender(client, payment, target!.customer_id, actor);
      break;
    }
    case "dismiss": {
      await setAside(client, payment, resolutionId, input.reason);
      break;
    }
    case "acknowledge": {
      // For money that belongs to no invoice (wrong token, duplicate kept outside Setra), acknowledging sets it aside.
      if (payment.status === "needs_review") await setAside(client, payment, resolutionId, input.reason);
      break;
    }
    case "refund": {
      // Resolving by refund means the money went back in full; partial refunds are recorded on the payment.
      await recordRefund(client, organizationId, payment.id, { outgoing_transfer_id: input.outgoing_transfer_id!, reason: input.reason }, actor, { resolutionId, requireFull: true });
      break;
    }
    case "write_off": {
      const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [exception.invoice_id])).rows[0] as Row;
      const remaining = BigInt(inv.amount_due) - BigInt(inv.amount_paid) - BigInt(inv.amount_written_off);
      if (remaining <= 0n) throw new EngineError("nothing_to_write_off", "This invoice has no remaining balance.", 409);
      await client.query("UPDATE invoices SET amount_written_off = amount_written_off + $1, updated_at = now() WHERE id = $2", [remaining.toString(), inv.id]);
      const after = await recomputeInvoice(client, inv.id);
      await accountWriteOff(client, inv.id, resolutionId, remaining, actor);
      await audit(client, actor, {
        organizationId,
        environment: inv.environment,
        action: "invoice_written_off",
        objectType: "invoice",
        objectId: inv.id,
        previous: { status: inv.status, amount_written_off: inv.amount_written_off },
        next: { status: after.status, amount_written_off: after.amount_written_off, reason: input.reason }
      });
      await closeExceptionsBySystem(client, { organizationId, invoiceId: inv.id, types: ["partial_payment"], reason: "Remaining balance written off." });
      break;
    }
  }

  const paymentAfter = (await client.query("SELECT status, invoice_id FROM payments WHERE id = $1", [payment.id])).rows[0] as Row;
  const invoiceAfter = paymentAfter.invoice_id
    ? ((await client.query("SELECT id, number, status, amount_paid, amount_written_off FROM invoices WHERE id = $1", [paymentAfter.invoice_id])).rows[0] as Row)
    : exception.invoice_id
      ? ((await client.query("SELECT id, number, status, amount_paid, amount_written_off FROM invoices WHERE id = $1", [exception.invoice_id])).rows[0] as Row)
      : null;
  const newState = { exception_status: "resolved", action: input.action, payment_status: paymentAfter.status, invoice: invoiceAfter };
  // new_state is written exactly once; the database rejects any later change (see guard_resolution_update).
  await client.query("UPDATE resolutions SET new_state = $1 WHERE id = $2", [JSON.stringify(newState), resolutionId]);
  await audit(client, actor, {
    organizationId,
    environment: exception.environment,
    action: "exception_resolved",
    objectType: "exception",
    objectId: exception.id,
    previous: previousState,
    next: { ...newState, reason: input.reason }
  });
  log().info("exception_resolved", { organizationId, exceptionId: exception.id, action: input.action, actor: actor.type });
  const updated = (await client.query("SELECT * FROM exceptions WHERE id = $1", [exception.id])).rows[0] as Row;
  return { exception: updated, resolutionId };
}

async function setAside(client: Client, payment: Row, resolutionId: string, reason: string) {
  await client.query("UPDATE payments SET status = 'dismissed', updated_at = now() WHERE id = $1", [payment.id]);
  await emitFinancialEvent(client, {
    organizationId: payment.organization_id,
    environment: payment.environment,
    type: "PAYMENT_DISMISSED",
    dedupeKey: `dismissed:${payment.id}`,
    paymentId: payment.id,
    ruleVersion: "manual-v1.0",
    resolutionId,
    extra: { dismissal: { reason } }
  });
}

async function rememberSender(client: Client, payment: Row, customerId: string, actor: Actor) {
  const inserted = await client.query(
    `INSERT INTO customer_addresses (id, organization_id, environment, customer_id, chain_id, address, label, source)
     VALUES ($1,$2,$3,$4,$5,$6,'Learned from a resolved payment','resolution') ON CONFLICT (organization_id, chain_id, address) DO NOTHING RETURNING id`,
    [newId("customerAddress"), payment.organization_id, payment.environment, customerId, payment.chain_id, payment.from_address]
  );
  if (inserted.rows[0]) {
    await audit(client, actor, { organizationId: payment.organization_id, environment: payment.environment, action: "customer_address_added", objectType: "customer", objectId: customerId, next: { address: payment.from_address } });
    log().info("customer_address_learned", { organizationId: payment.organization_id, customerId, address: payment.from_address });
  }
}
