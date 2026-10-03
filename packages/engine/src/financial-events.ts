import type { Client } from "@setra/database";
import { API_VERSION, EVENT_SCHEMA_VERSION, EVENT_VERSION, webhookEventName, type WebhookEnvelope } from "@setra/events";
import { newId, type FinancialEventType } from "@setra/schemas";
import { bigintReplacer, log } from "./context";
import { amount, assetInfo, decimalsFor, explorerTx, networkInfo, serializeDecision } from "./serializers";
import { accountForFinancialEvent } from "./accounting/posting-rules";

type Row = Record<string, any>;

export interface EmitInput {
  organizationId: string;
  environment: "test" | "live";
  type: FinancialEventType;
  /** Uniqueness key: the same source fact can never produce the same event twice. */
  dedupeKey: string;
  paymentId: string;
  ruleVersion: string;
  decisionId?: string | null;
  resolutionId?: string | null;
  reversesEventId?: string | null;
  occurredAt?: Date;
  extra?: Record<string, unknown>;
}

/**
 * Append a financial event and queue webhook deliveries in the same transaction.
 * Idempotent: a repeated dedupe key returns the original event and queues nothing new.
 */
export async function emitFinancialEvent(client: Client, input: EmitInput): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>("SELECT id FROM financial_events WHERE organization_id = $1 AND dedupe_key = $2", [input.organizationId, input.dedupeKey]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

  const payment = (await client.query("SELECT * FROM payments WHERE id = $1", [input.paymentId])).rows[0] as Row;
  const observation = (await client.query("SELECT * FROM source_observations WHERE id = $1", [payment.observation_id])).rows[0] as Row;
  const invoice = payment.invoice_id ? ((await client.query("SELECT * FROM invoices WHERE id = $1", [payment.invoice_id])).rows[0] as Row) : null;
  const customerId = invoice?.customer_id ?? payment.customer_id ?? null;
  const customer = customerId ? ((await client.query("SELECT id, name, external_ref FROM customers WHERE id = $1", [customerId])).rows[0] as Row) : null;
  const decision = input.decisionId ? ((await client.query("SELECT * FROM match_decisions WHERE id = $1", [input.decisionId])).rows[0] as Row) : null;
  const resolution = input.resolutionId ? ((await client.query("SELECT * FROM resolutions WHERE id = $1", [input.resolutionId])).rows[0] as Row) : null;
  // While a payment is still confirming, the invoice it provisionally matched (never used for money).
  const provisional =
    !invoice && payment.status === "confirming" && payment.provisional_invoice_id
      ? ((await client.query("SELECT id, number, title, purpose FROM invoices WHERE id = $1", [payment.provisional_invoice_id])).rows[0] as Row)
      : null;
  const intent = payment.payment_intent_id ? ((await client.query("SELECT id, intent_hash, contract_address FROM payment_intents WHERE id = $1", [payment.payment_intent_id])).rows[0] as Row) : null;

  const id = newId("financialEvent");
  const createdAt = new Date();
  const occurredAt = input.occurredAt ?? createdAt;
  const d = decimalsFor(payment.asset_id);
  const data = {
    id,
    object: "financial_event",
    type: input.type,
    event_version: EVENT_VERSION,
    schema_version: EVENT_SCHEMA_VERSION,
    livemode: input.environment === "live",
    status: input.type === "PAYMENT_OBSERVED" ? "pending" : "confirmed",
    occurred_at: occurredAt.toISOString(),
    created_at: createdAt.toISOString(),
    customer: customer ? { id: customer.id, name: customer.name, external_ref: customer.external_ref ?? null } : null,
    invoice: invoice
      ? {
          id: invoice.id,
          number: invoice.number,
          // The merchant's own order ID and metadata, so their system can act on the event directly.
          external_id: invoice.external_id ?? null,
          metadata: invoice.metadata ?? {},
          title: invoice.title ?? null,
          purpose: invoice.purpose ?? null,
          status: invoice.status,
          currency: invoice.currency,
          amount_due: amount(invoice.amount_due, d),
          amount_paid: amount(invoice.amount_paid, d),
          amount_remaining: amount(maxZero(BigInt(invoice.amount_due) - BigInt(invoice.amount_paid) - BigInt(invoice.amount_written_off)), d)
        }
      : null,
    // What the money is for, from the invoice it was applied to. "unknown" means Setra has not
    // established it; nothing is guessed.
    purpose_status: invoice ? "known" : provisional ? "provisional" : "unknown",
    context_source: invoice ? (payment.context_source ?? null) : null,
    provisional_invoice: provisional ? { id: provisional.id, number: provisional.number, title: provisional.title ?? null, purpose: provisional.purpose ?? null } : null,
    payment: {
      id: payment.id,
      status: payment.status,
      amount: amount(payment.amount, d),
      amount_base_units: String(payment.amount),
      asset: assetInfo(payment.asset_id)?.symbol ?? null,
      asset_address: payment.token_address,
      ...networkInfo(Number(payment.chain_id)),
      sender: payment.from_address,
      recipient: payment.to_address,
      wallet_id: payment.wallet_id,
      transaction_hash: payment.transaction_hash,
      explorer_url: explorerTx(Number(payment.chain_id), payment.transaction_hash, payment.source === "simulated"),
      simulated: payment.source === "simulated"
    },
    evidence: {
      observation_id: observation.id,
      source_type: observation.source_type,
      block_number: String(observation.block_number),
      block_hash: observation.block_hash,
      block_timestamp: new Date(observation.block_timestamp).toISOString(),
      transaction_index: observation.transaction_index,
      log_index: observation.log_index,
      confirmation_state: observation.confirmation_state,
      canonical: observation.canonical,
      ...(intent ? { payment_intent_id: intent.id, intent_id: intent.intent_hash, contract: intent.contract_address, contract_event: "PaymentIntentPaid" } : {}),
      rule_version: input.ruleVersion
    },
    decision: serializeDecision(decision),
    resolution: resolution
      ? { id: resolution.id, action: resolution.action, reason: resolution.reason, actor: { type: resolution.actor_type, id: resolution.actor_id, label: resolution.actor_label }, created_at: new Date(resolution.created_at).toISOString() }
      : null,
    reverses_event_id: input.reversesEventId ?? null,
    ...(input.extra ?? {})
  };

  await client.query(
    `INSERT INTO financial_events (id, organization_id, environment, type, event_version, schema_version, dedupe_key, payment_id, invoice_id, customer_id,
       observation_id, match_decision_id, resolution_id, reverses_event_id, amount, asset_id, chain_id, rule_version, data, occurred_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      id,
      input.organizationId,
      input.environment,
      input.type,
      EVENT_VERSION,
      EVENT_SCHEMA_VERSION,
      input.dedupeKey,
      payment.id,
      invoice?.id ?? null,
      customerId,
      observation.id,
      input.decisionId ?? null,
      input.resolutionId ?? null,
      input.reversesEventId ?? null,
      payment.amount,
      payment.asset_id,
      payment.chain_id,
      input.ruleVersion,
      JSON.stringify(data, bigintReplacer),
      occurredAt,
      createdAt
    ]
  );
  log().info("financial_event_created", { organizationId: input.organizationId, eventId: id, type: input.type, paymentId: payment.id, invoiceId: invoice?.id });

  await enqueueWebhooks(client, { organizationId: input.organizationId, environment: input.environment, eventId: id, eventType: webhookEventName(input.type), data, createdAt });
  // The event's accounting is posted in the same transaction (never blocking the event itself).
  await accountForFinancialEvent(client, id);
  return { id, created: true };
}

const maxZero = (v: bigint) => (v > 0n ? v : 0n);

export async function enqueueWebhooks(
  client: Client,
  e: { organizationId: string; environment: "test" | "live"; eventId: string | null; eventType: string; data: unknown; createdAt: Date; endpointId?: string }
): Promise<number> {
  const endpoints = await client.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
      WHERE organization_id = $1 AND environment = $2 AND enabled AND archived_at IS NULL AND $3 = ANY(event_types)
        AND ($4::text IS NULL OR id = $4)`,
    [e.organizationId, e.environment, e.eventType, e.endpointId ?? null]
  );
  for (const endpoint of endpoints.rows) {
    const envelope: WebhookEnvelope = {
      id: e.eventId ?? newId("financialEvent"),
      object: "event",
      type: e.eventType,
      api_version: API_VERSION,
      created_at: e.createdAt.toISOString(),
      livemode: e.environment === "live",
      data: e.data
    };
    await client.query(
      `INSERT INTO webhook_deliveries (id, organization_id, environment, endpoint_id, event_id, event_type, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [newId("webhookDelivery"), e.organizationId, e.environment, endpoint.id, e.eventId, e.eventType, JSON.stringify(envelope, bigintReplacer)]
    );
  }
  return endpoints.rowCount ?? 0;
}
