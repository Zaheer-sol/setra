import { networks } from "@setra/config";
import { fromBaseUnits } from "@setra/schemas";

/**
 * Public API representations. The same functions produce REST responses and webhook payloads,
 * so both surfaces always agree. Money is always a decimal string.
 */

type Row = Record<string, any>;

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export function assetInfo(assetId: string | null | undefined) {
  if (!assetId) return null;
  const found = networks().asset(assetId);
  if (!found) return null;
  return { id: assetId, symbol: found.asset.symbol, decimals: found.asset.decimals, address: found.asset.address };
}

export function networkInfo(chainId: number) {
  const n = networks().byChainId(chainId);
  return n
    ? { network: n.family, network_name: n.name, chain_id: n.chainId, testnet: n.environment === "test" }
    : { network: "unknown", network_name: `Chain ${chainId}`, chain_id: chainId, testnet: false };
}

export function decimalsFor(assetId: string | null | undefined): number {
  return assetInfo(assetId)?.decimals ?? 6;
}

export const amount = (value: string | bigint | null | undefined, decimals: number) =>
  value === null || value === undefined ? null : fromBaseUnits(BigInt(value), decimals, 2);

/**
 * Normalize an exact decimal string produced by SQL aggregation (e.g. SUM(amount / 10^decimals))
 * to at least two fraction digits. Aggregates across assets are computed in PostgreSQL numeric,
 * which is exact, so no base-unit mixing ever happens in JavaScript.
 */
export function decimalString(value: string | null | undefined): string {
  const v = (value ?? "0").toString();
  const [whole, fraction = ""] = v.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed.padEnd(2, "0")}`;
}

export function explorerTx(chainId: number, hash: string, simulated = false) {
  return simulated ? null : (networks().explorerTxUrl(chainId, hash) ?? null);
}

export function serializeCustomer(row: Row, extra: { addresses?: Row[]; stats?: Row } = {}) {
  return {
    id: row.id,
    object: "customer",
    livemode: row.environment === "live",
    name: row.name,
    email: row.email ?? null,
    external_ref: row.external_ref ?? null,
    metadata: row.metadata ?? {},
    wallet_addresses: (extra.addresses ?? []).map((a) => ({
      id: a.id,
      address: a.address,
      label: a.label ?? null,
      source: a.source,
      ...networkInfo(Number(a.chain_id))
    })),
    ...(extra.stats
      ? {
          stats: {
            open_invoices: Number(extra.stats.open_invoices ?? 0),
            paid_invoices: Number(extra.stats.paid_invoices ?? 0),
            open_exceptions: Number(extra.stats.open_exceptions ?? 0),
            total_received: decimalString(extra.stats.total_received),
            outstanding: decimalString(extra.stats.outstanding)
          }
        }
      : {}),
    created_at: iso(row.created_at)
  };
}

export function serializeWallet(row: Row, extra: { assets?: string[]; stats?: Row; sync?: Row | null } = {}) {
  return {
    id: row.id,
    object: "wallet",
    livemode: row.environment === "live",
    name: row.name,
    address: row.address,
    ...networkInfo(Number(row.chain_id)),
    assets: (extra.assets ?? []).map((id) => assetInfo(id)).filter(Boolean),
    monitoring_enabled: row.monitoring_enabled,
    monitor_from_block: row.monitor_from_block ?? null,
    ...(extra.stats
      ? { stats: { payments: Number(extra.stats.payments ?? 0), total_received: decimalString(extra.stats.total_received), last_payment_at: iso(extra.stats.last_payment_at) } }
      : {}),
    ...(extra.sync !== undefined ? { sync: extra.sync } : {}),
    explorer_url: networks().explorerAddressUrl(Number(row.chain_id), row.address) ?? null,
    created_at: iso(row.created_at)
  };
}

export function serializeLineItems(items: Row[] | undefined, decimals: number) {
  return (items ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((li) => ({ description: li.description, quantity: Number(li.quantity), unit_amount: amount(li.unit_amount, decimals), amount: amount(li.amount, decimals) }));
}

export function serializeInvoice(row: Row, publicAppUrl: string, extra: { customer?: Row | null; confirmingAmount?: string | null; lineItems?: Row[] } = {}) {
  const d = decimalsFor(row.asset_id);
  const remaining = BigInt(row.amount_due) - BigInt(row.amount_paid) - BigInt(row.amount_written_off ?? 0);
  return {
    id: row.id,
    object: "invoice",
    livemode: row.environment === "live",
    number: row.number,
    title: row.title ?? null,
    purpose: row.purpose ?? null,
    line_items: serializeLineItems(extra.lineItems, d),
    status: row.status,
    customer: extra.customer ? { id: extra.customer.id, name: extra.customer.name, email: extra.customer.email ?? null } : { id: row.customer_id },
    currency: row.currency,
    amount_due: amount(row.amount_due, d),
    amount_paid: amount(row.amount_paid, d),
    amount_written_off: amount(row.amount_written_off ?? "0", d),
    amount_credited: amount(row.amount_credited ?? "0", d),
    original_amount: amount(BigInt(row.amount_due) + BigInt(row.amount_credited ?? 0), d),
    amount_remaining: amount(remaining > 0n ? remaining : 0n, d),
    amount_overpaid: amount(remaining < 0n ? -remaining : 0n, d),
    amount_confirming: extra.confirmingAmount ? amount(extra.confirmingAmount, d) : "0.00",
    asset: assetInfo(row.asset_id),
    ...networkInfo(Number(row.chain_id)),
    wallet_id: row.wallet_id,
    receiving_address: row.wallet_address ?? null,
    payment_url: `${publicAppUrl.replace(/\/$/, "")}/pay/${row.public_token}`,
    issued_at: iso(row.issued_at),
    due_at: iso(row.due_at),
    expires_at: iso(row.expires_at),
    paid_at: iso(row.paid_at),
    cancelled_at: iso(row.cancelled_at),
    cancel_reason: row.cancel_reason ?? null,
    last_sent_at: iso(row.last_sent_at),
    last_sent_to: row.last_sent_to ?? null,
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  };
}

/**
 * What a payment is for, taken only from authoritative records: the invoice it was applied to, or,
 * while it is still confirming, the invoice it provisionally matched. A payment with neither has no
 * business object and its purpose is "unknown"; nothing is inferred.
 */
export function paymentPurpose(row: Row, invoice?: Row | null) {
  const applied = row.invoice_id && invoice && invoice.id === row.invoice_id;
  const provisional = !row.invoice_id && row.status === "confirming" && row.provisional_invoice_id && invoice && invoice.id === row.provisional_invoice_id;
  const object =
    applied || provisional
      ? { type: "invoice" as const, id: invoice!.id, number: invoice!.number ?? null, title: invoice!.title ?? null, purpose: invoice!.purpose ?? null }
      : null;
  return {
    business_object: object,
    purpose_status: applied ? ("known" as const) : provisional ? ("provisional" as const) : ("unknown" as const),
    context_source: applied ? ((row.context_source as string | null) ?? null) : null
  };
}

export function serializePayment(row: Row, extra: { invoice?: Row | null; customer?: Row | null; wallet?: Row | null } = {}) {
  const d = decimalsFor(row.asset_id);
  const simulated = row.source === "simulated";
  return {
    id: row.id,
    object: "payment",
    livemode: row.environment === "live",
    status: row.status,
    amount: amount(row.amount, d),
    amount_base_units: String(row.amount),
    asset: assetInfo(row.asset_id) ?? { id: null, symbol: "Unknown token", decimals: null, address: row.token_address },
    ...networkInfo(Number(row.chain_id)),
    sender: row.from_address,
    recipient: row.to_address,
    wallet: extra.wallet ? { id: extra.wallet.id, name: extra.wallet.name } : { id: row.wallet_id },
    customer: extra.customer ? { id: extra.customer.id, name: extra.customer.name } : row.customer_id ? { id: row.customer_id } : null,
    invoice: extra.invoice && extra.invoice.id === row.invoice_id ? { id: extra.invoice.id, number: extra.invoice.number, status: extra.invoice.status } : row.invoice_id ? { id: row.invoice_id } : null,
    provisional_invoice_id: row.status === "confirming" ? (row.provisional_invoice_id ?? null) : null,
    ...paymentPurpose(row, extra.invoice),
    payment_intent_id: row.payment_intent_id ?? null,
    transaction_hash: row.transaction_hash,
    block_number: String(row.block_number),
    explorer_url: explorerTx(Number(row.chain_id), row.transaction_hash, simulated),
    source: row.source,
    simulated,
    paid_at: iso(row.block_timestamp),
    finalized_at: iso(row.finalized_at),
    created_at: iso(row.created_at)
  };
}

export function serializeException(row: Row, extra: { payment?: Row | null; invoice?: Row | null; customer?: Row | null; resolution?: Row | null } = {}) {
  const d = decimalsFor(row.asset_id);
  return {
    id: row.id,
    object: "exception",
    livemode: row.environment === "live",
    type: row.type,
    status: row.status,
    summary: row.summary,
    detail: row.detail,
    recommended_action: row.recommended_action ?? null,
    amount: amount(row.amount, d),
    asset: assetInfo(row.asset_id),
    payment_id: row.payment_id,
    invoice: extra.invoice ? { id: extra.invoice.id, number: extra.invoice.number, title: extra.invoice.title ?? null } : row.invoice_id ? { id: row.invoice_id } : null,
    customer: extra.customer ? { id: extra.customer.id, name: extra.customer.name } : row.customer_id ? { id: row.customer_id } : null,
    candidates: (row.candidates ?? []).map((c: Row) => ({
      invoice_id: c.invoiceId,
      number: c.number,
      customer_id: c.customerId,
      customer_name: c.customerName,
      amount_remaining: amount(c.amountRemaining, d),
      reasons: c.reasons
    })),
    resolution: extra.resolution ? serializeResolution(extra.resolution) : null,
    created_at: iso(row.created_at),
    resolved_at: iso(row.resolved_at)
  };
}

export function serializeResolution(row: Row) {
  return {
    id: row.id,
    action: row.action,
    reason: row.reason,
    invoice_id: row.invoice_id ?? null,
    actor: { type: row.actor_type, id: row.actor_id ?? null, label: row.actor_label ?? null },
    previous_state: row.previous_state,
    new_state: row.new_state,
    rule_version: row.rule_version,
    created_at: iso(row.created_at)
  };
}

export function serializeDecision(row: Row | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    stage: row.stage,
    rule_version: row.rule_version,
    outcome: row.outcome,
    exception_type: row.exception_type ?? null,
    invoice_id: row.invoice_id ?? null,
    customer_id: row.customer_id ?? null,
    explanation: row.explanation,
    checks: row.checks,
    candidates: row.candidates,
    created_at: iso(row.created_at)
  };
}

export function serializeObservation(row: Row) {
  return {
    id: row.id,
    source_type: row.source_type,
    ...networkInfo(Number(row.chain_id)),
    block_number: String(row.block_number),
    block_hash: row.block_hash,
    block_timestamp: iso(row.block_timestamp),
    transaction_hash: row.transaction_hash,
    transaction_index: row.transaction_index,
    log_index: row.log_index,
    token_address: row.token_address,
    from_address: row.from_address,
    to_address: row.to_address,
    amount_base_units: String(row.amount),
    intent_id: row.intent_hash ?? null,
    confirmation_state: row.confirmation_state,
    canonical: row.canonical,
    detection_source: row.detection_source ?? (row.source_type === "simulated" ? "simulated" : "rpc"),
    executed_at: iso(row.executed_at),
    finalized_at: iso(row.finalized_at),
    recorded_at: iso(row.created_at)
  };
}

export function serializeWebhookEndpoint(row: Row) {
  return {
    id: row.id,
    object: "webhook_endpoint",
    livemode: row.environment === "live",
    url: row.url,
    description: row.description ?? null,
    event_types: row.event_types,
    enabled: row.enabled,
    secret_hint: row.secret_hint,
    rotating_until: iso(row.previous_secret_expires_at),
    created_at: iso(row.created_at)
  };
}

export function serializeDelivery(row: Row, attempts?: Row[]) {
  return {
    id: row.id,
    object: "webhook_delivery",
    livemode: row.environment === "live",
    endpoint_id: row.endpoint_id,
    endpoint_url: row.endpoint_url ?? null,
    event_id: row.event_id ?? null,
    event_type: row.event_type,
    status: row.status,
    attempt_count: row.attempt_count,
    next_attempt_at: row.status === "retrying" || row.status === "pending" ? iso(row.next_attempt_at) : null,
    last_response_status: row.last_response_status ?? null,
    last_error: row.last_error ?? null,
    delivered_at: iso(row.delivered_at),
    replay_of: row.replay_of ?? null,
    payload: row.payload,
    created_at: iso(row.created_at),
    ...(attempts
      ? {
          attempts: attempts.map((a) => ({
            id: a.id,
            attempt_number: a.attempt_number,
            request_url: a.request_url,
            request_headers: a.request_headers,
            response_status: a.response_status ?? null,
            response_body_excerpt: a.response_body_excerpt ?? null,
            error: a.error ?? null,
            duration_ms: a.duration_ms,
            created_at: iso(a.created_at)
          }))
        }
      : {})
  };
}

export function serializePaymentIntent(row: Row) {
  const d = decimalsFor(row.asset_id);
  return {
    id: row.id,
    object: "payment_intent",
    livemode: row.environment === "live",
    invoice_id: row.invoice_id,
    status: row.status,
    ...networkInfo(Number(row.chain_id)),
    contract_address: row.contract_address,
    intent_id: row.intent_hash,
    reference: row.reference,
    terms: {
      merchant: row.merchant_address,
      token: row.token_address,
      amount: String(row.amount),
      expires_at: Math.floor(new Date(row.expires_at).getTime() / 1000),
      ref: row.reference
    },
    amount: amount(row.amount, d),
    asset: assetInfo(row.asset_id),
    payer: row.payer_address ?? null,
    paid_transaction_hash: row.paid_transaction_hash ?? null,
    expires_at: iso(row.expires_at),
    paid_at: iso(row.paid_at),
    created_at: iso(row.created_at)
  };
}
