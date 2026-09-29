import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { newId, type CorrectPaymentInput, type RecordRefundInput } from "@setra/schemas";
import { audit, EngineError, log, type Actor } from "./context";
import { emitFinancialEvent } from "./financial-events";
import { applyPayment, closeExceptionsBySystem, openException, recomputeInvoice } from "./pipeline";
import { accountForOutgoingTransfer } from "./accounting/posting-rules";

type Row = Record<string, any>;

const APPLIED = ["matched", "partial", "overpaid"];

// ── Corrections ──────────────────────────────────────────────────────────────────────────────

/**
 * An operator corrects how an applied payment is allocated: moves it to another invoice
 * (`reassign`) or takes it off its invoice and back to review (`unassign`).
 *
 * Nothing is rewritten. The original decision/resolution and allocation stay; a compensating
 * (negative) allocation references both the original and this correction, the old invoice's balance
 * is recomputed (a paid invoice reopens), PAYMENT_UNASSIGNED is emitted, and for a reassignment the
 * payment is applied to the new invoice with its own settlement event.
 *
 * Payments identified by an onchain payment-intent reference are not correctable: the transaction
 * itself named the invoice.
 */
export async function correctPayment(client: Client, organizationId: string, paymentId: string, input: CorrectPaymentInput, actor: Actor): Promise<{ correctionId: string }> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1 AND organization_id = $2 FOR UPDATE", [paymentId, organizationId])).rows[0] as Row | undefined;
  if (!payment) throw new EngineError("not_found", "No such payment.", 404);
  if (!APPLIED.includes(payment.status) || !payment.invoice_id) {
    throw new EngineError("payment_not_applied", "Only a payment that is applied to an invoice can be corrected.", 409);
  }
  if (payment.payment_intent_id) {
    throw new EngineError("payment_intent_reference", "This payment carried an onchain reference to its invoice, so it can't be moved.", 409);
  }
  if ((await client.query("SELECT 1 FROM refunds WHERE payment_id = $1", [paymentId])).rows[0]) {
    throw new EngineError("payment_refunded", "Part of this payment was refunded; it can't be moved.", 409);
  }
  if ((await client.query("SELECT 1 FROM credit_applications a WHERE a.payment_id = $1 AND a.amount > 0 AND NOT EXISTS (SELECT 1 FROM credit_applications r WHERE r.reverses_id = a.id)", [paymentId])).rows[0]) {
    throw new EngineError("payment_credit_applied", "Part of this payment's overpayment was applied to another invoice. Undo that first.", 409);
  }
  const from = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [payment.invoice_id])).rows[0] as Row;

  let target: Row | null = null;
  if (input.action === "reassign") {
    target = ((await client.query("SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [input.invoice_id, organizationId, payment.environment])).rows[0] as Row | undefined) ?? null;
    if (!target) throw new EngineError("invoice_not_found", "Choose an invoice from this workspace and mode.", 404);
    if (target.id === from.id) throw new EngineError("same_invoice", "The payment is already applied to that invoice.", 409);
    if (target.status === "cancelled") throw new EngineError("invoice_cancelled", "A cancelled invoice cannot receive payments.", 409);
    const paymentAsset = payment.asset_id ? networks().asset(payment.asset_id) : undefined;
    if (!paymentAsset || paymentAsset.asset.pegCurrency !== target.currency) {
      throw new EngineError("asset_mismatch", "This payment's asset can't settle an invoice in that currency.", 422);
    }
  }

  const correctionId = newId("correction");
  await client.query(
    `INSERT INTO payment_corrections (id, organization_id, environment, payment_id, action, from_invoice_id, to_invoice_id, reason, actor_type, actor_id, actor_label, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [correctionId, organizationId, payment.environment, payment.id, input.action, from.id, target?.id ?? null, input.reason, actor.type, actor.id ?? null, actor.label ?? null, actor.requestId ?? null]
  );

  // Compensate every live allocation of this payment.
  const live = await client.query(
    `SELECT a.* FROM allocations a WHERE a.payment_id = $1 AND a.kind <> 'reversal'
       AND NOT EXISTS (SELECT 1 FROM allocations r WHERE r.reverses_allocation_id = a.id)`,
    [payment.id]
  );
  for (const a of live.rows) {
    await client.query(
      `INSERT INTO allocations (id, organization_id, environment, payment_id, invoice_id, amount, kind, reverses_allocation_id, correction_id)
       VALUES ($1,$2,$3,$4,$5,$6,'reversal',$7,$8)`,
      [newId("allocation"), a.organization_id, a.environment, payment.id, a.invoice_id, (-BigInt(a.amount)).toString(), a.id, correctionId]
    );
  }
  const fromAfter = await recomputeInvoice(client, from.id);
  // Follow-ups that were about this payment on the old invoice no longer apply.
  await closeExceptionsBySystem(client, { organizationId, paymentId: payment.id, types: ["partial_payment", "overpayment"], reason: `Payment moved off ${from.number} by an operator.` });

  await client.query("UPDATE payments SET status = 'needs_review', invoice_id = NULL, context_source = NULL, updated_at = now() WHERE id = $1", [payment.id]);
  await emitFinancialEvent(client, {
    organizationId,
    environment: payment.environment,
    type: "PAYMENT_UNASSIGNED",
    dedupeKey: `unassigned:${payment.id}:${correctionId}`,
    paymentId: payment.id,
    ruleVersion: "manual-v1.0",
    extra: {
      correction: {
        id: correctionId,
        action: input.action,
        reason: input.reason,
        from_invoice: { id: from.id, number: from.number, title: from.title ?? null, status_after: fromAfter.status },
        to_invoice: target ? { id: target.id, number: target.number, title: target.title ?? null } : null,
        actor: { type: actor.type, id: actor.id ?? null, label: actor.label ?? null }
      }
    }
  });

  const current = (await client.query("SELECT * FROM payments WHERE id = $1", [payment.id])).rows[0] as Row;
  if (target) {
    await applyPayment(client, { payment: current, invoiceId: target.id, kind: "manual", correctionId, actor });
  } else {
    await openException(client, current, "unknown_payment", {
      customerId: payment.customer_id,
      dedupeSuffix: correctionId,
      wording: {
        summary: `Payment taken off ${from.number}`,
        detail: `An operator removed this payment from ${from.number}${from.title ? ` (${from.title})` : ""}: “${input.reason}”. It is not applied to any invoice.`,
        recommended: "Assign it to the right invoice, refund it, or mark it as not applied."
      }
    });
  }

  await audit(client, actor, {
    organizationId,
    environment: payment.environment,
    action: input.action === "reassign" ? "payment_reassigned" : "payment_unassigned",
    objectType: "payment",
    objectId: payment.id,
    previous: { status: payment.status, invoice_id: from.id, invoice_status: from.status },
    next: { correction_id: correctionId, invoice_id: target?.id ?? null, from_invoice_status: fromAfter.status, reason: input.reason }
  });
  log().info("payment_corrected", { organizationId, paymentId: payment.id, action: input.action, from: from.id, to: target?.id });
  return { correctionId };
}

// ── Outgoing transfers ───────────────────────────────────────────────────────────────────────

export interface OutgoingTransferInput {
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  tokenAddress: string;
  toAddress: string;
  amount: bigint;
  blockTimestamp: Date;
}

/** Record stablecoin sent from a monitored wallet (finalized data only). Idempotent. */
export async function recordOutgoingTransfer(client: Client, wallet: { id: string; organization_id: string; environment: string }, input: OutgoingTransferInput): Promise<string | null> {
  const asset = networks().assetByAddress(input.chainId, input.tokenAddress);
  const inserted = await client.query(
    `INSERT INTO outgoing_transfers (id, organization_id, environment, wallet_id, chain_id, block_number, block_hash, transaction_hash, transaction_index, log_index, token_address, asset_id, to_address, amount, block_timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (organization_id, chain_id, block_hash, transaction_hash, log_index) DO NOTHING RETURNING id`,
    [
      newId("outgoingTransfer"),
      wallet.organization_id,
      wallet.environment,
      wallet.id,
      input.chainId,
      input.blockNumber.toString(),
      input.blockHash.toLowerCase(),
      input.transactionHash.toLowerCase(),
      input.transactionIndex,
      input.logIndex,
      input.tokenAddress.toLowerCase(),
      asset?.id ?? null,
      input.toAddress.toLowerCase(),
      input.amount.toString(),
      input.blockTimestamp
    ]
  );
  const id = inserted.rows[0]?.id ?? null;
  if (id) await accountForOutgoingTransfer(client, id);
  if (id) log().info("outgoing_transfer_observed", { organizationId: wallet.organization_id, walletId: wallet.id, tx: input.transactionHash, amount: input.amount.toString() });
  return id;
}

// ── Refunds ──────────────────────────────────────────────────────────────────────────────────

/** How much of a payment can still be refunded, in base units. */
async function refundable(client: Client, payment: Row): Promise<{ amount: bigint; basis: "unapplied" | "excess" }> {
  const refunded = BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(amount), 0)::text AS s FROM refunds WHERE payment_id = $1", [payment.id])).rows[0]!.s);
  if (["needs_review", "dismissed"].includes(payment.status)) return { amount: BigInt(payment.amount) - refunded, basis: "unapplied" };
  if (payment.status === "overpaid" && payment.invoice_id) {
    const inv = (await client.query("SELECT amount_due, amount_paid FROM invoices WHERE id = $1", [payment.invoice_id])).rows[0] as Row;
    const excess = BigInt(inv.amount_paid) - BigInt(inv.amount_due);
    const cap = excess < BigInt(payment.amount) ? excess : BigInt(payment.amount);
    return { amount: cap - refunded, basis: "excess" };
  }
  if (payment.status === "refunded") return { amount: 0n, basis: "unapplied" };
  throw new EngineError("payment_not_refundable", "This payment is applied to an invoice. Take it off the invoice first, then record the refund.", 409);
}

/** Outgoing transfers that could be the refund of this payment, most likely first. */
export async function refundCandidates(client: Client, paymentId: string): Promise<Row[]> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0] as Row | undefined;
  if (!payment) throw new EngineError("not_found", "No such payment.", 404);
  const rows = (
    await client.query(
      `SELECT o.* FROM outgoing_transfers o
        WHERE o.wallet_id = $1 AND o.token_address = $2 AND o.canonical AND o.block_number >= $3
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.outgoing_transfer_id = o.id)
        ORDER BY (o.to_address = $4) DESC, o.block_number ASC LIMIT 20`,
      [payment.wallet_id, payment.token_address, payment.block_number, payment.from_address]
    )
  ).rows;
  return rows;
}

/**
 * Record that some or all of a payment was sent back. Proven by an outgoing transfer from the same
 * wallet, in the same token, after the payment, not already used for another refund, and no larger
 * than what is refundable (the whole payment if it was never applied; the excess if it overpaid).
 */
export async function recordRefund(
  client: Client,
  organizationId: string,
  paymentId: string,
  input: RecordRefundInput,
  actor: Actor,
  opts: { resolutionId?: string; requireFull?: boolean } = {}
): Promise<{ refundId: string; paymentStatus: string }> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1 AND organization_id = $2 FOR UPDATE", [paymentId, organizationId])).rows[0] as Row | undefined;
  if (!payment) throw new EngineError("not_found", "No such payment.", 404);
  const out = (await client.query("SELECT * FROM outgoing_transfers WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [input.outgoing_transfer_id, organizationId, payment.environment])).rows[0] as Row | undefined;
  if (!out) throw new EngineError("transfer_not_found", "Choose an outgoing transfer from your wallets in this mode.", 404);
  if (!out.canonical) throw new EngineError("transfer_not_canonical", "That transfer is no longer part of the chain.", 409);
  if (out.wallet_id !== payment.wallet_id) throw new EngineError("wrong_wallet", "The refund must be sent from the wallet that received the payment.", 422);
  if (out.token_address !== payment.token_address) throw new EngineError("wrong_token", "The refund must be in the same token as the payment.", 422);
  if (BigInt(out.block_number) < BigInt(payment.block_number)) throw new EngineError("refund_before_payment", "That transfer happened before the payment arrived.", 422);
  if ((await client.query("SELECT 1 FROM refunds WHERE outgoing_transfer_id = $1", [out.id])).rows[0]) {
    throw new EngineError("transfer_already_used", "That transfer is already recorded as a refund.", 409);
  }
  const { amount: open, basis } = await refundable(client, payment);
  const decimals = (payment.asset_id && networks().asset(payment.asset_id)?.asset.decimals) || 6;
  const amount = BigInt(out.amount);
  if (open <= 0n) throw new EngineError("nothing_to_refund", "Nothing on this payment is left to refund.", 409);
  if (opts.requireFull && amount !== open) {
    throw new EngineError("refund_incomplete", `That transfer covers ${formatUnits(amount, decimals)} of ${formatUnits(open, decimals)} still refundable. Record it from the payment page, and resolve once the rest is handled.`, 422);
  }
  if (amount > open) {
    throw new EngineError("refund_too_large", `That transfer is larger than what can be refunded on this payment (${basis === "excess" ? "the overpaid amount" : "the payment"}).`, 422);
  }

  const refundId = newId("refund");
  await client.query(
    `INSERT INTO refunds (id, organization_id, environment, payment_id, outgoing_transfer_id, amount, reason, actor_type, actor_id, actor_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [refundId, organizationId, payment.environment, payment.id, out.id, amount.toString(), input.reason, actor.type, actor.id ?? null, actor.label ?? null]
  );
  const fully = amount === open;
  if (basis === "unapplied" && fully) {
    await client.query("UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1", [payment.id]);
    await closeExceptionsBySystem(client, {
      organizationId,
      paymentId: payment.id,
      types: ["unknown_payment", "ambiguous_match", "duplicate_payment", "late_payment", "wrong_network"],
      reason: "Refunded to the sender."
    });
  }
  if (basis === "excess" && fully) {
    await closeExceptionsBySystem(client, { organizationId, paymentId: payment.id, types: ["overpayment"], reason: "The overpaid amount was refunded." });
  }
  await emitFinancialEvent(client, {
    organizationId,
    environment: payment.environment,
    type: "REFUND_OBSERVED",
    dedupeKey: `refund-transfer:${out.id}`,
    paymentId: payment.id,
    ruleVersion: "manual-v1.0",
    resolutionId: opts.resolutionId ?? null,
    extra: {
      refund: {
        id: refundId,
        method: "direct_transfer",
        amount_base_units: amount.toString(),
        amount: formatUnits(amount, decimals),
        covers: basis === "excess" ? "overpaid_amount" : "payment",
        fully_refunded: fully,
        to: out.to_address,
        transaction_hash: out.transaction_hash,
        block_number: String(out.block_number),
        block_hash: out.block_hash,
        log_index: out.log_index,
        reason: input.reason
      }
    }
  });
  await audit(client, actor, {
    organizationId,
    environment: payment.environment,
    action: "refund_recorded",
    objectType: "payment",
    objectId: payment.id,
    previous: { status: payment.status },
    next: { refund_id: refundId, outgoing_transfer_id: out.id, amount: amount.toString(), transaction_hash: out.transaction_hash, reason: input.reason }
  });
  log().info("refund_recorded", { organizationId, paymentId: payment.id, refundId, tx: out.transaction_hash });
  const after = (await client.query("SELECT status FROM payments WHERE id = $1", [payment.id])).rows[0] as Row;
  return { refundId, paymentStatus: after.status };
}

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / base}.${frac.padEnd(2, "0")}`;
}
