import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { MATCH_RULE_VERSION, matchPayment, statusForBalance, type InvoiceCandidate, type MatchDecision, type PaymentIntentRef } from "@setra/matching";
import { formatUsd, newId, type ExceptionType, type FinancialEventType, type PaymentStatus } from "@setra/schemas";
import { reverseCreditApplicationsForPayment } from "./accounting/customer-credits";
import { audit, bigintReplacer, log, SYSTEM, type Actor } from "./context";
import { emitFinancialEvent } from "./financial-events";

/**
 * The payment pipeline. Both the chain worker and the API (test-mode simulations, operator
 * resolutions) call these functions, so live, test and manual paths share one implementation.
 *
 *   observe ──▶ payment (confirming) ──▶ PAYMENT_OBSERVED        no economic effect yet
 *   settle  ──▶ final match decision ──▶ allocation ──▶ invoice   economic effect, once
 *           └─▶ PAYMENT_MATCHED / PARTIALLY_PAID / OVERPAID / UNKNOWN_PAYMENT (+ exception)
 *   drop / reverse ──▶ compensating allocation ──▶ PAYMENT_REVERSED  history is never rewritten
 *
 * Every function must be called inside a tenant-scoped transaction and is idempotent.
 */

type Row = Record<string, any>;

export interface WalletRef {
  id: string;
  organization_id: string;
  environment: "test" | "live";
  chain_id: number;
  name: string;
  address: string;
}

export interface ObservationInput {
  sourceType: "erc20_transfer" | "payment_intent_event" | "simulated";
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  tokenAddress: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  blockTimestamp: Date;
  /** Contract that emitted the log (intent events must come from the configured intent contract). */
  emitter?: string;
  intentHash?: string | null;
  raw?: unknown;
  /** Which path reported it: Setra's RPC ingestion (default) or the Monad execution-events sidecar. */
  detectionSource?: "rpc" | "execution_events";
  /** When the EVM recorded the log, from the execution event ring (execution-events path only). */
  executedAt?: Date;
}

export type Stage = "tip" | "settled";

export interface IngestResult {
  observationId: string | null;
  paymentId: string | null;
  created: boolean;
  skipped?: string;
}

const lower = (v: string) => v.toLowerCase();
const SETTLEMENT_EVENT: Record<"matched" | "partial" | "overpaid" | "needs_review", FinancialEventType> = {
  matched: "PAYMENT_MATCHED",
  partial: "PARTIALLY_PAID",
  overpaid: "OVERPAID",
  needs_review: "UNKNOWN_PAYMENT"
};
const PAYMENT_STATUS_FOR: Record<"matched" | "partial" | "overpaid" | "needs_review", PaymentStatus> = {
  matched: "matched",
  partial: "partial",
  overpaid: "overpaid",
  needs_review: "needs_review"
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Observe
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record one blockchain fact for one monitored wallet. `tip` observations are provisional; `settled`
 * observations are final under the network's settlement policy and are settled immediately.
 */
/** First time each path (RPC, execution events) saw an observation at each stage. Idempotent. */
async function recordSighting(client: Client, observationId: string, organizationId: string, source: string, stage: Stage): Promise<void> {
  await client.query(
    `INSERT INTO observation_sightings (observation_id, organization_id, source, stage) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [observationId, organizationId, source, stage]
  );
}

export async function ingestObservation(client: Client, wallet: WalletRef, input: ObservationInput, stage: Stage): Promise<IngestResult> {
  const registryAsset = networks().assetByAddress(input.chainId, input.tokenAddress);
  let intent: Row | undefined;
  if (input.sourceType === "payment_intent_event") {
    intent = (
      await client.query(
        `SELECT * FROM payment_intents WHERE organization_id = $1 AND chain_id = $2 AND intent_hash = $3 AND contract_address = $4`,
        [wallet.organization_id, input.chainId, lower(input.intentHash ?? ""), lower(input.emitter ?? "")]
      )
    ).rows[0];
    // An intent Setra didn't create (or from another contract) is ignored here; the underlying ERC-20
    // transfer is still observed and matched like any direct payment.
    if (!intent || intent.merchant_address !== wallet.address) return { observationId: null, paymentId: null, created: false, skipped: "unknown_intent" };
  }

  const observationId = newId("observation");
  const state = stage === "settled" ? "finalized" : "observed";
  const inserted = await client.query(
    `INSERT INTO source_observations (id, organization_id, environment, source_type, chain_id, block_number, block_hash, transaction_hash, transaction_index,
       log_index, token_address, asset_id, from_address, to_address, wallet_id, amount, intent_hash, payment_intent_id, block_timestamp,
       confirmation_state, finalized_at, raw, detection_source, executed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (organization_id, chain_id, block_hash, transaction_hash, log_index, source_type) DO NOTHING
     RETURNING *`,
    [
      observationId,
      wallet.organization_id,
      wallet.environment,
      input.sourceType,
      input.chainId,
      input.blockNumber.toString(),
      lower(input.blockHash),
      lower(input.transactionHash),
      input.transactionIndex,
      input.logIndex,
      lower(input.tokenAddress),
      registryAsset?.id ?? null,
      lower(input.fromAddress),
      lower(input.toAddress),
      wallet.id,
      input.amount.toString(),
      input.intentHash ? lower(input.intentHash) : null,
      intent?.id ?? null,
      input.blockTimestamp,
      state,
      stage === "settled" ? new Date() : null,
      JSON.stringify(input.raw ?? {}, bigintReplacer),
      input.sourceType === "simulated" ? "simulated" : (input.detectionSource ?? "rpc"),
      input.executedAt ?? null
    ]
  );
  const sightingSource = input.sourceType === "simulated" ? "simulated" : (input.detectionSource ?? "rpc");

  if (!inserted.rows[0]) {
    // Duplicate log/block/transaction: no new economic effect. A settled re-observation finalizes it.
    const existing = (
      await client.query(
        `SELECT * FROM source_observations WHERE organization_id = $1 AND chain_id = $2 AND block_hash = $3 AND transaction_hash = $4 AND log_index = $5 AND source_type = $6`,
        [wallet.organization_id, input.chainId, lower(input.blockHash), lower(input.transactionHash), input.logIndex, input.sourceType]
      )
    ).rows[0] as Row;
    await recordSighting(client, existing.id, wallet.organization_id, sightingSource, stage);
    if (stage === "settled" && existing.confirmation_state === "observed" && existing.canonical) {
      await settleObservation(client, existing.id, "Confirmed by the network's settlement policy");
    }
    const payment = (await client.query("SELECT id FROM payments WHERE observation_id = $1", [existing.id])).rows[0];
    return { observationId: existing.id, paymentId: payment?.id ?? null, created: false };
  }

  const obs = inserted.rows[0] as Row;
  await recordSighting(client, obs.id, wallet.organization_id, sightingSource, stage);
  await recordStateChange(
    client,
    obs,
    null,
    state,
    true,
    stage === "settled" ? "Observed in a settled block range" : sightingSource === "execution_events" ? "Observed in Monad execution (execution events)" : "Observed at the chain tip"
  );
  log().info("source_observation_created", { organizationId: wallet.organization_id, observationId: obs.id, chainId: input.chainId, tx: obs.transaction_hash, stage, source: sightingSource });

  // A Setra payment-intent payment emits both an ERC-20 Transfer and PaymentIntentPaid in the same
  // transaction. The intent event is the payment; the transfer is supporting evidence, never a second payment.
  if (input.sourceType === "erc20_transfer") {
    const linked = await client.query(
      `UPDATE payments SET supporting_observation_id = $1, updated_at = now()
        WHERE id = (SELECT p.id FROM payments p JOIN source_observations o ON o.id = p.observation_id
                     WHERE p.organization_id = $2 AND p.wallet_id = $3 AND p.transaction_hash = $4 AND p.amount = $5
                       AND o.source_type = 'payment_intent_event' AND o.block_hash = $6 AND p.supporting_observation_id IS NULL
                     LIMIT 1)
        RETURNING id`,
      [obs.id, wallet.organization_id, wallet.id, obs.transaction_hash, obs.amount, obs.block_hash]
    );
    if (linked.rows[0]) return { observationId: obs.id, paymentId: linked.rows[0].id, created: true };
  }

  const paymentId = newId("payment");
  await client.query(
    `INSERT INTO payments (id, organization_id, environment, observation_id, source, wallet_id, chain_id, asset_id, token_address, amount, from_address,
       to_address, transaction_hash, block_number, block_timestamp, payment_intent_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'confirming')`,
    [
      paymentId,
      wallet.organization_id,
      wallet.environment,
      obs.id,
      input.sourceType === "simulated" ? "simulated" : "chain",
      wallet.id,
      obs.chain_id,
      obs.asset_id,
      obs.token_address,
      obs.amount,
      obs.from_address,
      obs.to_address,
      obs.transaction_hash,
      obs.block_number,
      obs.block_timestamp,
      intent?.id ?? null
    ]
  );
  await emitFinancialEvent(client, {
    organizationId: wallet.organization_id,
    environment: wallet.environment,
    type: "PAYMENT_OBSERVED",
    dedupeKey: `observed:${obs.id}`,
    paymentId,
    ruleVersion: "observe-v1.0",
    occurredAt: new Date(obs.block_timestamp)
  });

  if (stage === "settled") {
    await settleObservation(client, obs.id, "Observed in a settled block range", true);
    return { observationId: obs.id, paymentId, created: true };
  }

  // A provisional decision lets the console and hosted page say "payment detected" within one block.
  // It changes no balances. The final decision is made again at settlement against fresh state.
  const provisional = await decide(client, paymentId, false);
  const decisionId = await insertDecision(client, paymentId, provisional, "provisional");
  await client.query("UPDATE payments SET provisional_invoice_id = $1, latest_decision_id = $2, customer_id = $3 WHERE id = $4", [
    provisional.invoiceId,
    decisionId,
    provisional.customerId,
    paymentId
  ]);
  return { observationId: obs.id, paymentId, created: true };
}
// ────────────────────────────────────────────────────────────────────────────────────────────────
// Settle
// ────────────────────────────────────────────────────────────────────────────────────────────────

export async function settleObservation(client: Client, observationId: string, reason: string, alreadyFinal = false): Promise<void> {
  const obs = (await client.query("SELECT * FROM source_observations WHERE id = $1 FOR UPDATE", [observationId])).rows[0] as Row | undefined;
  if (!obs || !obs.canonical) return;
  if (!alreadyFinal && obs.confirmation_state === "observed") {
    await client.query("UPDATE source_observations SET confirmation_state = 'finalized', finalized_at = now() WHERE id = $1", [observationId]);
    await recordStateChange(client, obs, "observed", "finalized", true, reason);
  }
  const payment = (await client.query("SELECT id, status FROM payments WHERE observation_id = $1", [observationId])).rows[0];
  if (payment?.status === "confirming") await settlePayment(client, payment.id);
}

/** Make the final, binding decision for a confirming payment and apply its economic effect exactly once. */
export async function settlePayment(client: Client, paymentId: string, actor: Actor = SYSTEM): Promise<MatchDecision | null> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId])).rows[0] as Row;
  if (!payment || payment.status !== "confirming") return null; // idempotent: already settled, reversed or dismissed

  const decision = await decide(client, paymentId, true);
  const decisionId = await insertDecision(client, paymentId, decision, "final");
  await client.query("UPDATE payments SET finalized_at = now(), latest_decision_id = $1 WHERE id = $2", [decisionId, paymentId]);
  log().info("payment_match_attempted", { organizationId: payment.organization_id, paymentId, outcome: decision.outcome, invoiceId: decision.invoiceId, rule: decision.ruleVersion });

  if (decision.invoiceId) {
    await applyPayment(client, { payment, invoiceId: decision.invoiceId, kind: "automatic", decisionId, exceptionFromDecision: decision, actor });
  } else {
    await client.query("UPDATE payments SET status = 'needs_review', customer_id = $1, provisional_invoice_id = NULL, updated_at = now() WHERE id = $2", [
      decision.customerId,
      paymentId
    ]);
    await emitFinancialEvent(client, {
      organizationId: payment.organization_id,
      environment: payment.environment,
      type: "UNKNOWN_PAYMENT",
      dedupeKey: `settled:${paymentId}`,
      paymentId,
      ruleVersion: decision.ruleVersion,
      decisionId,
      extra: { reason: decision.exceptionType }
    });
    await openException(client, payment, decision.exceptionType as ExceptionType, { decisionId, decision, customerId: decision.customerId });
  }
  return decision;
}

interface ApplyInput {
  payment: Row;
  invoiceId: string;
  kind: "automatic" | "manual";
  decisionId?: string;
  resolutionId?: string;
  /** Set when an operator correction moves the payment here (see corrections.ts). */
  correctionId?: string;
  exceptionFromDecision?: MatchDecision;
  actor: Actor;
}

/** Allocate a payment to an invoice, update balances, emit the settlement event and any follow-up exception. */
export async function applyPayment(client: Client, input: ApplyInput): Promise<{ outcome: "matched" | "partial" | "overpaid"; invoice: Row }> {
  const { payment } = input;
  const before = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [input.invoiceId])).rows[0] as Row;
  const remaining = BigInt(before.amount_due) - BigInt(before.amount_paid) - BigInt(before.amount_written_off);
  const amount = BigInt(payment.amount);
  const outcome = amount === remaining ? "matched" : amount < remaining ? "partial" : "overpaid";

  await client.query(
    `INSERT INTO allocations (id, organization_id, environment, payment_id, invoice_id, amount, kind, match_decision_id, resolution_id, correction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [newId("allocation"), payment.organization_id, payment.environment, payment.id, before.id, payment.amount, input.kind, input.decisionId ?? null, input.resolutionId ?? null, input.correctionId ?? null]
  );
  const invoice = await recomputeInvoice(client, before.id, new Date(payment.block_timestamp));
  await client.query(
    `UPDATE payments SET status = $1, invoice_id = $2, customer_id = $3, provisional_invoice_id = NULL, context_source = $5, updated_at = now() WHERE id = $4`,
    [PAYMENT_STATUS_FOR[outcome], before.id, before.customer_id, payment.id, input.kind === "manual" ? "manual_resolution" : payment.payment_intent_id ? "payment_intent" : "automatic_match"]
  );
  if (payment.payment_intent_id) {
    await client.query(
      `UPDATE payment_intents SET status = 'paid', payer_address = $1, paid_transaction_hash = $2, paid_at = $3, updated_at = now() WHERE id = $4 AND status = 'open'`,
      [payment.from_address, payment.transaction_hash, payment.block_timestamp, payment.payment_intent_id]
    );
  }

  await emitFinancialEvent(client, {
    organizationId: payment.organization_id,
    environment: payment.environment,
    type: SETTLEMENT_EVENT[outcome],
    dedupeKey: input.correctionId
      ? `reassigned:${payment.id}:${input.correctionId}`
      : input.kind === "automatic"
        ? `settled:${payment.id}`
        : `resolved:${payment.id}:${input.resolutionId}`,
    paymentId: payment.id,
    ruleVersion: input.kind === "automatic" ? (input.exceptionFromDecision?.ruleVersion ?? MATCH_RULE_VERSION) : "manual-v1.0",
    decisionId: input.decisionId ?? null,
    resolutionId: input.resolutionId ?? null,
    extra: input.correctionId ? { correction_id: input.correctionId } : undefined
  });
  await audit(client, input.actor, {
    organizationId: payment.organization_id,
    environment: payment.environment,
    action: "payment_matched",
    objectType: "payment",
    objectId: payment.id,
    previous: { status: payment.status, invoice_status: before.status, amount_paid: before.amount_paid },
    next: { status: PAYMENT_STATUS_FOR[outcome], invoice_id: invoice.id, invoice_status: invoice.status, amount_paid: invoice.amount_paid, kind: input.kind }
  });

  if (outcome === "partial") await openException(client, { ...payment, invoice_id: invoice.id, customer_id: invoice.customer_id }, "partial_payment", { decisionId: input.decisionId, invoice, customerId: invoice.customer_id, dedupeSuffix: input.correctionId });
  if (outcome === "overpaid") await openException(client, { ...payment, invoice_id: invoice.id, customer_id: invoice.customer_id }, "overpayment", { decisionId: input.decisionId, invoice, customerId: invoice.customer_id, dedupeSuffix: input.correctionId });
  if (invoice.status === "paid" || invoice.status === "overpaid") {
    await closeExceptionsBySystem(client, { organizationId: payment.organization_id, invoiceId: invoice.id, types: ["partial_payment"], reason: "The remaining balance was received." });
  }
  return { outcome, invoice };
}

/** Recompute an invoice's balance and status from its allocation ledger. The ledger is the source of truth. */
export async function recomputeInvoice(client: Client, invoiceId: string, at: Date = new Date()): Promise<Row> {
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId])).rows[0] as Row;
  // Paid = payments allocated to it, plus customer credit moved onto it, less credit moved off it.
  const paid = BigInt(
    (
      await client.query<{ total: string }>(
        `SELECT (COALESCE((SELECT SUM(amount) FROM allocations WHERE invoice_id = $1), 0)
               + COALESCE((SELECT SUM(amount) FROM credit_applications WHERE to_invoice_id = $1), 0)
               - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE from_invoice_id = $1), 0))::text AS total`,
        [invoiceId]
      )
    ).rows[0]!.total
  );
  let status = inv.status;
  let paidAt = inv.paid_at;
  if (inv.status !== "cancelled") {
    const expired = inv.expires_at !== null && new Date(inv.expires_at).getTime() < Date.now();
    status = statusForBalance(BigInt(inv.amount_due), paid, BigInt(inv.amount_written_off), expired);
    paidAt = status === "paid" || status === "overpaid" ? (inv.paid_at ?? at) : null;
  }
  const updated = await client.query("UPDATE invoices SET amount_paid = $1, status = $2, paid_at = $3, updated_at = now() WHERE id = $4 RETURNING *", [
    paid.toString(),
    status,
    paidAt,
    invoiceId
  ]);
  return updated.rows[0] as Row;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Drop / reverse
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** A tip observation that never made it into the settled chain. Nothing was applied, so nothing is compensated. */
export async function dropObservation(client: Client, observationId: string, reason: string, headBlock?: bigint): Promise<void> {
  const obs = (await client.query("SELECT * FROM source_observations WHERE id = $1 FOR UPDATE", [observationId])).rows[0] as Row | undefined;
  if (!obs || obs.confirmation_state !== "observed" || !obs.canonical) return;
  await client.query("UPDATE source_observations SET confirmation_state = 'dropped', canonical = false WHERE id = $1", [observationId]);
  await recordStateChange(client, obs, "observed", "dropped", false, reason, headBlock);
  log().warn("reorg_detected", { organizationId: obs.organization_id, observationId, tx: obs.transaction_hash, stage: "tip", reason });
  const payment = (await client.query("SELECT * FROM payments WHERE observation_id = $1 FOR UPDATE", [observationId])).rows[0] as Row | undefined;
  if (payment && payment.status === "confirming") {
    await client.query("UPDATE payments SET status = 'reversed', provisional_invoice_id = NULL, updated_at = now() WHERE id = $1", [payment.id]);
    const observed = (await client.query("SELECT id FROM financial_events WHERE organization_id = $1 AND dedupe_key = $2", [obs.organization_id, `observed:${obs.id}`])).rows[0];
    await emitFinancialEvent(client, {
      organizationId: obs.organization_id,
      environment: obs.environment,
      type: "PAYMENT_REVERSED",
      dedupeKey: `reversed:${payment.id}`,
      paymentId: payment.id,
      ruleVersion: "canonicality-v1.0",
      reversesEventId: observed?.id ?? null,
      extra: { reversal: { reason, previous_status: "confirming", economic_effect_reversed: false } }
    });
  }
}

/**
 * The source of a settled payment is no longer canonical (deep reorg on a confirmations-based
 * chain, or a controlled test-mode reorg). Compensate every allocation, reopen invoices, emit
 * PAYMENT_REVERSED and open a reversal exception. The original decision and events stay intact.
 */
export async function reversePayment(client: Client, paymentId: string, reason: string, actor: Actor = SYSTEM): Promise<boolean> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId])).rows[0] as Row | undefined;
  if (!payment || payment.status === "reversed") return false;
  if (payment.status === "confirming") {
    await dropObservation(client, payment.observation_id, reason);
    return true;
  }
  for (const obsId of [payment.observation_id, payment.supporting_observation_id].filter(Boolean)) {
    const obs = (await client.query("SELECT * FROM source_observations WHERE id = $1 FOR UPDATE", [obsId])).rows[0] as Row;
    if (obs.canonical) {
      await client.query("UPDATE source_observations SET confirmation_state = 'dropped', canonical = false WHERE id = $1", [obsId]);
      await recordStateChange(client, obs, obs.confirmation_state, "dropped", false, reason);
    }
  }
  log().warn("reorg_detected", { organizationId: payment.organization_id, paymentId, tx: payment.transaction_hash, stage: "settled", reason });

  const allocations = await client.query(
    `SELECT a.* FROM allocations a WHERE a.payment_id = $1 AND a.kind <> 'reversal'
       AND NOT EXISTS (SELECT 1 FROM allocations r WHERE r.reverses_allocation_id = a.id)`,
    [paymentId]
  );
  const touched = new Map<string, Row>();
  // Credit this payment's overpayment provided to other invoices goes with it.
  for (const invoiceId of await reverseCreditApplicationsForPayment(client, paymentId, reason)) touched.set(invoiceId, await recomputeInvoice(client, invoiceId));
  for (const a of allocations.rows) {
    await client.query(
      `INSERT INTO allocations (id, organization_id, environment, payment_id, invoice_id, amount, kind, reverses_allocation_id)
       VALUES ($1,$2,$3,$4,$5,$6,'reversal',$7)`,
      [newId("allocation"), a.organization_id, a.environment, paymentId, a.invoice_id, (-BigInt(a.amount)).toString(), a.id]
    );
    touched.set(a.invoice_id, await recomputeInvoice(client, a.invoice_id));
  }
  await client.query("UPDATE payments SET status = 'reversed', updated_at = now() WHERE id = $1", [paymentId]);
  if (payment.payment_intent_id) {
    await client.query("UPDATE payment_intents SET status = 'open', payer_address = NULL, paid_transaction_hash = NULL, paid_at = NULL, updated_at = now() WHERE id = $1 AND status = 'paid'", [
      payment.payment_intent_id
    ]);
  }

  const settlement = (
    await client.query(
      `SELECT id FROM financial_events WHERE payment_id = $1 AND type IN ('PAYMENT_MATCHED','PARTIALLY_PAID','OVERPAID','UNKNOWN_PAYMENT','PAYMENT_DISMISSED')
        ORDER BY id DESC LIMIT 1`,
      [paymentId]
    )
  ).rows[0];
  await emitFinancialEvent(client, {
    organizationId: payment.organization_id,
    environment: payment.environment,
    type: "PAYMENT_REVERSED",
    dedupeKey: `reversed:${paymentId}`,
    paymentId,
    ruleVersion: "canonicality-v1.0",
    reversesEventId: settlement?.id ?? null,
    extra: { reversal: { reason, previous_status: payment.status, economic_effect_reversed: allocations.rows.length > 0 } }
  });
  await closeExceptionsBySystem(client, { organizationId: payment.organization_id, paymentId, reason: "The payment was reversed on chain." });
  const invoice = [...touched.values()][0] ?? null;
  await openException(client, { ...payment, status: "reversed" }, "reversal", { invoice, customerId: payment.customer_id, reason });
  await audit(client, actor, {
    organizationId: payment.organization_id,
    environment: payment.environment,
    action: "payment_reversed",
    objectType: "payment",
    objectId: paymentId,
    previous: { status: payment.status, invoice_id: payment.invoice_id },
    next: { status: "reversed", reason, invoices: [...touched.values()].map((i) => ({ id: i.id, status: i.status, amount_paid: i.amount_paid })) }
  });
  return true;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Refunds (SetraPaymentIntent.refund)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A merchant refunded a paid intent through the contract. The refund is recorded as a
 * REFUND_OBSERVED financial event on the original payment, with the refund transaction as evidence.
 * Invoice balances are not changed automatically: whether a refund reopens an invoice is a business
 * decision, surfaced to the operator as history rather than guessed.
 */
export async function recordIntentRefund(
  client: Client,
  wallet: WalletRef,
  refund: { intentHash: string; emitter: string; transactionHash: string; blockNumber: bigint; blockHash: string; logIndex: number; amount: bigint; payer: string; blockTimestamp: Date }
): Promise<string | null> {
  const intent = (
    await client.query("SELECT * FROM payment_intents WHERE organization_id = $1 AND intent_hash = $2 AND contract_address = $3", [wallet.organization_id, refund.intentHash.toLowerCase(), refund.emitter.toLowerCase()])
  ).rows[0] as Row | undefined;
  if (!intent) return null;
  const payment = (await client.query("SELECT * FROM payments WHERE payment_intent_id = $1 AND status <> 'reversed' ORDER BY id DESC LIMIT 1", [intent.id])).rows[0] as Row | undefined;
  if (!payment) return null;
  await client.query("UPDATE payment_intents SET status = 'refunded', updated_at = now() WHERE id = $1 AND status = 'paid'", [intent.id]);
  const event = await emitFinancialEvent(client, {
    organizationId: wallet.organization_id,
    environment: wallet.environment,
    type: "REFUND_OBSERVED",
    dedupeKey: `refund:${refund.blockHash.toLowerCase()}:${refund.transactionHash.toLowerCase()}:${refund.logIndex}`,
    paymentId: payment.id,
    ruleVersion: "refund-v1.0",
    occurredAt: refund.blockTimestamp,
    extra: {
      refund: {
        amount_base_units: refund.amount.toString(),
        recipient: refund.payer.toLowerCase(),
        transaction_hash: refund.transactionHash.toLowerCase(),
        block_number: refund.blockNumber.toString(),
        block_hash: refund.blockHash.toLowerCase(),
        log_index: refund.logIndex,
        contract_event: "PaymentIntentRefunded"
      }
    }
  });
  if (event.created) {
    await audit(client, SYSTEM, { organizationId: wallet.organization_id, environment: wallet.environment, action: "refund_observed", objectType: "payment", objectId: payment.id, next: { transaction_hash: refund.transactionHash } });
    log().info("refund_observed", { organizationId: wallet.organization_id, paymentId: payment.id, tx: refund.transactionHash });
  }
  return event.id;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Matching context
// ────────────────────────────────────────────────────────────────────────────────────────────────

async function decide(client: Client, paymentId: string, lockInvoices: boolean): Promise<MatchDecision> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0] as Row;
  const wallet = (await client.query("SELECT * FROM wallets WHERE id = $1", [payment.wallet_id])).rows[0] as Row;
  const accepted = (await client.query<{ asset_id: string }>("SELECT asset_id FROM wallet_assets WHERE wallet_id = $1", [wallet.id])).rows.map((r) => r.asset_id);
  const sender = (
    await client.query(
      `SELECT ca.customer_id, c.name FROM customer_addresses ca JOIN customers c ON c.id = ca.customer_id
        WHERE ca.organization_id = $1 AND ca.chain_id = $2 AND ca.address = $3 AND c.archived_at IS NULL`,
      [payment.organization_id, payment.chain_id, payment.from_address]
    )
  ).rows[0];

  // Only the invoices a rule can settle or cite: the sender's own, and those whose remaining or
  // original amount equals the payment. Locked in id order; the rest of the wallet's invoices can't
  // change the decision, so they're neither read nor locked.
  const invoices = (
    await client.query(
      `SELECT i.*, c.name AS customer_name, w.address AS wallet_address
         FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN wallets w ON w.id = i.wallet_id
        WHERE i.organization_id = $1 AND i.environment = $2
          AND i.wallet_id IN (SELECT id FROM wallets WHERE organization_id = $1 AND environment = $2 AND address = $3)
          AND (i.status IN ('open','partially_paid','expired') OR (i.status IN ('paid','overpaid') AND i.paid_at > $4::timestamptz - interval '30 days') OR (i.status = 'cancelled' AND i.cancelled_at > $4::timestamptz - interval '30 days'))
          AND (i.customer_id = $5 OR i.amount_due - i.amount_paid - i.amount_written_off = $6::numeric OR i.amount_due = $6::numeric)
        ORDER BY i.id ${lockInvoices ? "FOR UPDATE OF i" : ""}`,
      [payment.organization_id, payment.environment, wallet.address, payment.block_timestamp, sender?.customer_id ?? null, payment.amount]
    )
  ).rows as Row[];

  // Suggestions for an operator when nothing matches: the open invoices this could partly pay, closest
  // first. The matcher shows at most five and never applies a payment to them, so they aren't locked.
  if (payment.asset_id) {
    const fits = (
      await client.query(
        `SELECT i.*, c.name AS customer_name, w.address AS wallet_address
           FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN wallets w ON w.id = i.wallet_id
          WHERE i.organization_id = $1 AND i.wallet_id = $2 AND i.asset_id = $3 AND i.status IN ('open','partially_paid')
            AND i.issued_at <= $4::timestamptz + interval '5 minutes' AND (i.expires_at IS NULL OR i.expires_at >= $4::timestamptz)
            AND i.amount_due - i.amount_paid - i.amount_written_off > $5::numeric
          ORDER BY i.amount_due - i.amount_paid - i.amount_written_off, i.id
          LIMIT 5`,
        [payment.organization_id, wallet.id, payment.asset_id, payment.block_timestamp, payment.amount]
      )
    ).rows as Row[];
    const have = new Set(invoices.map((i) => i.id));
    // Appended after the id-ordered rows: they only feed the partial-fit suggestions, which sort themselves.
    for (const f of fits) if (!have.has(f.id)) invoices.push(f);
  }

  let intentRef: PaymentIntentRef | null = null;
  if (payment.payment_intent_id) {
    const intent = (await client.query("SELECT * FROM payment_intents WHERE id = $1", [payment.payment_intent_id])).rows[0] as Row;
    intentRef = {
      id: intent.id,
      invoiceId: intent.invoice_id,
      walletId: intent.merchant_address === wallet.address && intent.chain_id === wallet.chain_id ? wallet.id : "mismatch",
      assetId: intent.asset_id,
      amount: BigInt(intent.amount)
    };
    if (!invoices.some((i) => i.id === intent.invoice_id)) {
      const extra = (
        await client.query(
          `SELECT i.*, c.name AS customer_name, w.address AS wallet_address FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN wallets w ON w.id = i.wallet_id WHERE i.id = $1 ${lockInvoices ? "FOR UPDATE OF i" : ""}`,
          [intent.invoice_id]
        )
      ).rows[0];
      if (extra) invoices.push(extra);
    }
  }

  const asset = payment.asset_id ? networks().asset(payment.asset_id)?.asset : undefined;
  return matchPayment(
    {
      chainId: payment.chain_id,
      networkName: networks().byChainId(Number(payment.chain_id))?.name,
      walletId: wallet.id,
      walletName: wallet.name,
      walletAddress: wallet.address,
      assetId: payment.asset_id,
      assetSymbol: asset?.symbol ?? `${payment.token_address.slice(0, 6)}…${payment.token_address.slice(-4)}`,
      fromAddress: payment.from_address,
      amount: BigInt(payment.amount),
      timestamp: new Date(payment.block_timestamp),
      paymentIntent: intentRef
    },
    {
      acceptedAssetIds: accepted,
      knownSender: sender ? { customerId: sender.customer_id, customerName: sender.name } : null,
      decimals: asset?.decimals ?? 6,
      invoices: invoices.map(toCandidate)
    }
  );
}

function toCandidate(i: Row): InvoiceCandidate {
  return {
    id: i.id,
    number: i.number,
    customerId: i.customer_id,
    customerName: i.customer_name,
    chainId: Number(i.chain_id),
    walletId: i.wallet_id,
    walletAddress: i.wallet_address,
    assetId: i.asset_id,
    amountDue: BigInt(i.amount_due),
    amountPaid: BigInt(i.amount_paid),
    amountWrittenOff: BigInt(i.amount_written_off),
    status: i.status,
    issuedAt: new Date(i.issued_at),
    dueAt: i.due_at ? new Date(i.due_at) : null,
    expiresAt: i.expires_at ? new Date(i.expires_at) : null,
    paidAt: i.paid_at ? new Date(i.paid_at) : null
  };
}

async function insertDecision(client: Client, paymentId: string, decision: MatchDecision, stage: "provisional" | "final"): Promise<string> {
  const payment = (await client.query("SELECT organization_id, environment, observation_id FROM payments WHERE id = $1", [paymentId])).rows[0] as Row;
  const id = newId("matchDecision");
  await client.query(
    `INSERT INTO match_decisions (id, organization_id, environment, payment_id, observation_id, rule_version, stage, outcome, exception_type, invoice_id, customer_id, checks, candidates, explanation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      payment.organization_id,
      payment.environment,
      paymentId,
      payment.observation_id,
      decision.ruleVersion,
      stage,
      decision.outcome,
      decision.exceptionType,
      decision.invoiceId,
      decision.customerId,
      JSON.stringify(decision.checks),
      JSON.stringify(decision.candidates),
      decision.explanation
    ]
  );
  return id;
}

async function recordStateChange(client: Client, obs: Row, from: string | null, to: string, canonical: boolean, reason: string, head?: bigint) {
  await client.query(
    `INSERT INTO observation_state_changes (organization_id, observation_id, from_state, to_state, canonical, reason, head_block_number) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [obs.organization_id, obs.id, from, to, canonical, reason, head?.toString() ?? null]
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Exceptions
// ────────────────────────────────────────────────────────────────────────────────────────────────

interface ExceptionContext {
  decisionId?: string;
  decision?: MatchDecision;
  invoice?: Row | null;
  customerId?: string | null;
  reason?: string;
  /** Distinguishes a later exception of the same type for the same payment (e.g. after a correction). */
  dedupeSuffix?: string;
  /** Replace the default wording (e.g. a payment an operator took back to review). */
  wording?: { summary: string; detail: string; recommended: string };
}

export async function openException(client: Client, payment: Row, type: ExceptionType, ctx: ExceptionContext): Promise<string | null> {
  const dedupeKey = ctx.dedupeSuffix ? `${type}:${payment.id}:${ctx.dedupeSuffix}` : `${type}:${payment.id}`;
  const existing = await client.query("SELECT id FROM exceptions WHERE organization_id = $1 AND dedupe_key = $2", [payment.organization_id, dedupeKey]);
  if (existing.rows[0]) return null;
  const asset = payment.asset_id ? networks().asset(payment.asset_id)?.asset : undefined;
  const decimals = asset?.decimals ?? 6;
  const money = (v: bigint | string) => formatUsd(BigInt(v), decimals);
  const inv = ctx.invoice;
  const received = money(payment.amount);
  let summary: string;
  let detail: string;
  let recommended: string;
  switch (type) {
    case "unknown_payment":
      summary = `Unknown payment of ${received}`;
      detail = "Setra received this payment but couldn't safely tell which customer or invoice it belongs to.";
      recommended = "Assign it to the right invoice, or mark it as not applied if it isn't a customer payment.";
      break;
    case "ambiguous_match":
      summary = `${received} could belong to more than one invoice`;
      detail = ctx.decision?.explanation ?? "More than one open invoice is an equally good match.";
      recommended = "Choose the invoice this payment belongs to.";
      break;
    case "partial_payment": {
      const remaining = BigInt(inv!.amount_due) - BigInt(inv!.amount_paid) - BigInt(inv!.amount_written_off);
      summary = `Partial payment on ${inv!.number}`;
      detail = `${received} received toward ${money(inv!.amount_due)}. ${money(remaining)} is still due.`;
      recommended = "Wait for the balance, follow up with the customer, or write off the remainder.";
      break;
    }
    case "overpayment": {
      const excess = BigInt(inv!.amount_paid) - BigInt(inv!.amount_due);
      summary = `Overpayment on ${inv!.number}`;
      detail = `${money(inv!.amount_paid)} received for ${money(inv!.amount_due)} due, ${money(excess)} more than requested.`;
      recommended = "Refund the difference to the sender or keep it as customer credit, then acknowledge.";
      break;
    }
    case "duplicate_payment":
      summary = `Possible duplicate payment of ${received}`;
      detail = ctx.decision?.explanation ?? "This looks like a repeat of a payment that was already received.";
      recommended = "Confirm with the customer. Assign it to another open invoice, refund it, or acknowledge it as credit.";
      break;
    case "late_payment":
      summary = `Late payment of ${received}`;
      detail = ctx.decision?.explanation ?? "The payment arrived after the invoice expired.";
      recommended = "Assign it to the expired invoice if you accept late payment, or refund it.";
      break;
    case "wrong_token":
      summary = `Unsupported token received`;
      detail = ctx.decision?.explanation ?? "This asset is not accepted by the receiving wallet and cannot settle an invoice.";
      recommended = "Return the funds to the sender or handle them outside Setra, then record what you did.";
      break;
    case "wrong_network":
      summary = `${received} arrived on the wrong network`;
      detail = ctx.decision?.explanation ?? "The payment matches an invoice that expects a different network.";
      recommended = "If you accept this network, assign it to the invoice. Otherwise refund it.";
      break;
    case "reversal":
      summary = `Payment reversed`;
      detail = `The block containing this ${received} payment is no longer part of the canonical chain.${inv ? ` ${inv.number} was reopened.` : ""} Earlier records are preserved.`;
      recommended = "No funds arrived. Wait for the customer's payment to be re-included, or contact them.";
      break;
  }
  if (ctx.wording) ({ summary, detail, recommended } = ctx.wording);
  const id = newId("exception");
  await client.query(
    `INSERT INTO exceptions (id, organization_id, environment, type, dedupe_key, payment_id, invoice_id, customer_id, amount, asset_id, summary, detail, recommended_action, candidates, match_decision_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      payment.organization_id,
      payment.environment,
      type,
      dedupeKey,
      payment.id,
      inv?.id ?? payment.invoice_id ?? null,
      ctx.customerId ?? inv?.customer_id ?? payment.customer_id ?? null,
      payment.amount,
      payment.asset_id,
      summary,
      detail,
      recommended,
      JSON.stringify(ctx.decision && type !== "partial_payment" && type !== "overpayment" ? ctx.decision.candidates : []),
      ctx.decisionId ?? null
    ]
  );
  log().info("exception_created", { organizationId: payment.organization_id, exceptionId: id, type, paymentId: payment.id });
  await audit(client, SYSTEM, { organizationId: payment.organization_id, environment: payment.environment, action: "exception_created", objectType: "exception", objectId: id, next: { type, payment_id: payment.id } });
  return id;
}

/** Resolve exceptions that no longer need a human (e.g. the balance of a partial payment arrived). History is kept. */
export async function closeExceptionsBySystem(
  client: Client,
  scope: { organizationId: string; invoiceId?: string; paymentId?: string; types?: ExceptionType[]; reason: string }
): Promise<number> {
  const open = await client.query(
    `SELECT * FROM exceptions WHERE organization_id = $1 AND status = 'open'
       AND ($2::text IS NULL OR invoice_id = $2) AND ($3::text IS NULL OR payment_id = $3) AND ($4::text[] IS NULL OR type = ANY($4))
     FOR UPDATE`,
    [scope.organizationId, scope.invoiceId ?? null, scope.paymentId ?? null, scope.types ?? null]
  );
  for (const e of open.rows) {
    const resolutionId = newId("resolution");
    await client.query(
      `INSERT INTO resolutions (id, organization_id, environment, exception_id, action, reason, actor_type, actor_id, actor_label, previous_state, new_state, rule_version)
       VALUES ($1,$2,$3,$4,'acknowledge',$5,'system','setra','Setra',$6,$7,'system-v1.0')`,
      [resolutionId, e.organization_id, e.environment, e.id, scope.reason, JSON.stringify({ exception_status: "open" }), JSON.stringify({ exception_status: "resolved" })]
    );
    await client.query("UPDATE exceptions SET status = 'resolved', resolution_id = $1, resolved_at = now(), updated_at = now() WHERE id = $2", [resolutionId, e.id]);
    log().info("exception_resolved", { organizationId: e.organization_id, exceptionId: e.id, by: "system", reason: scope.reason });
  }
  return open.rowCount ?? 0;
}
