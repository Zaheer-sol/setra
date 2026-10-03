import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appEnv } from "@setra/config";
import { withSystem, withTenant, type Client } from "@setra/database";
import { verifySignature } from "@setra/events";
import { newId, orderInput, type Environment, type OrderInput } from "@setra/schemas";
import { decryptSecret, encryptSecret, randomToken } from "@setra/security";
import { audit, EngineError, log, type Actor } from "./context";
import { upsertOrder, type OrderOutcome } from "./orders";

/**
 * Order sources: a store, checkout, payment processor or backend connected once, which then posts its
 * orders to Setra by itself. Two formats:
 *
 *   generic  Setra's order JSON, signed like Setra's own webhooks (X-Setra-Timestamp, X-Setra-Signature).
 *   shopify  Shopify's order webhooks as they are, signed by Shopify (X-Shopify-Hmac-Sha256).
 *
 * Every delivery is recorded once by the sender's delivery ID, so retries never create a second order,
 * and each one says what Setra did with it.
 */

type Row = Record<string, any>;

export type SourceOutcome = OrderOutcome | "failed";

export async function createOrderSource(
  client: Client,
  organizationId: string,
  environment: Environment,
  input: { kind: "generic"; name: string } | { kind: "shopify"; name: string; secret: string },
  actor: Actor
): Promise<{ source: Row; secret: string | null }> {
  // A generic source gets a secret from Setra, shown once. Shopify signs with the store's own secret.
  const secret = input.kind === "generic" ? `osec_${randomToken(24)}` : input.secret;
  const id = newId("orderSource");
  await client.query(
    "INSERT INTO order_sources (id, organization_id, environment, kind, name, secret_ciphertext, secret_hint, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, organizationId, environment, input.kind, input.name, encryptSecret(secret, appEnv().encryptionKey), `…${secret.slice(-4)}`, actor.id ?? null]
  );
  await audit(client, actor, { organizationId, environment, action: "order_source_created", objectType: "order_source", objectId: id, next: { kind: input.kind, name: input.name } });
  const source = (await client.query("SELECT * FROM order_sources WHERE id = $1", [id])).rows[0] as Row;
  return { source, secret: input.kind === "generic" ? secret : null };
}

export async function setOrderSourceStatus(client: Client, organizationId: string, sourceId: string, status: "active" | "disabled", actor: Actor): Promise<Row> {
  const before = (await client.query("SELECT * FROM order_sources WHERE id = $1 AND organization_id = $2", [sourceId, organizationId])).rows[0] as Row | undefined;
  if (!before) throw new EngineError("not_found", "No such order source.", 404);
  await client.query("UPDATE order_sources SET status = $1, updated_at = now() WHERE id = $2", [status, sourceId]);
  await audit(client, actor, { organizationId, environment: before.environment, action: `order_source_${status}`, objectType: "order_source", objectId: sourceId, previous: { status: before.status }, next: { status } });
  return (await client.query("SELECT * FROM order_sources WHERE id = $1", [sourceId])).rows[0] as Row;
}

// ── Shopify ──────────────────────────────────────────────────────────────────────────────────────

/** Shopify's signature: base64 HMAC-SHA256 of the raw body with the store's signing secret. */
export function verifyShopifySignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Statuses meaning the order was paid (or settled) through Shopify itself, not in stablecoins. */
const SETTLED_ELSEWHERE = new Set(["paid", "partially_refunded", "refunded", "voided", "partially_paid", "authorized"]);

/**
 * A Shopify order as a Setra order, or the reason to leave it alone. Only orders still waiting for
 * payment in US dollars become expected stablecoin payments; card orders Shopify already collected are
 * not Setra's to reconcile.
 */
export function shopifyOrder(topic: string, body: Row): { order: OrderInput } | { ignore: string } {
  const id = body?.id;
  if (id === undefined || id === null) return { ignore: "This isn't a Shopify order." };
  const externalId = `shopify:${id}`;
  const cancelled = topic === "orders/cancelled" || !!body.cancelled_at;
  const number = typeof body.name === "string" ? body.name.replace(/^#/, "").replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 32) : undefined;
  if (cancelled) return { order: orderInput.parse({ external_id: externalId, status: "cancelled" }) };
  const currency = String(body.currency ?? body.presentment_currency ?? "").toUpperCase();
  if (currency !== "USD") return { ignore: `The order is in ${currency || "an unknown currency"}. Setra reconciles USD stablecoin payments.` };
  const financial = String(body.financial_status ?? "pending");
  if (SETTLED_ELSEWHERE.has(financial)) return { ignore: `Shopify reports this order as ${financial.replace(/_/g, " ")}, so it wasn't paid in stablecoins.` };
  const c = body.customer ?? {};
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || undefined;
  const email = (c.email ?? body.email ?? body.contact_email) || undefined;
  const items: Array<{ title?: string; quantity?: number }> = Array.isArray(body.line_items) ? body.line_items : [];
  const summary = items
    .slice(0, 8)
    .map((li) => `${li.quantity ?? 1} × ${String(li.title ?? "item").slice(0, 60)}`)
    .join(", ");
  const parsed = orderInput.safeParse({
    external_id: externalId,
    number: number ? `SHOP-${number}` : undefined,
    title: `Shopify order ${body.name ?? id}`.slice(0, 140),
    purpose: summary ? summary.slice(0, 500) : undefined,
    // Shopify's total already includes tax, shipping and discounts, so it is the amount to collect.
    amount: String(body.current_total_price ?? body.total_price ?? ""),
    currency: "USD",
    customer: { external_ref: c.id ? `shopify:${c.id}` : undefined, name, email: email ? String(email).toLowerCase() : undefined },
    metadata: { shopify_order_id: String(id), ...(body.name ? { shopify_order_name: String(body.name).slice(0, 60) } : {}) }
  });
  if (!parsed.success) return { ignore: `Shopify sent an order Setra can't use: ${parsed.error.issues[0]?.message ?? "invalid order"}.` };
  return { order: parsed.data };
}

// ── receiving ────────────────────────────────────────────────────────────────────────────────────

export interface InboundResult {
  status: number;
  outcome: SourceOutcome | "rejected";
  detail?: string;
  invoice_id?: string | null;
  duplicate?: boolean;
}

const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Handle one delivery from an order source. Signature failures are refused (401). Anything else is
 * answered 200 with what Setra did, including orders it chose to ignore, so a sender never disables the
 * connection over an order that wasn't Setra's business.
 */
export async function receiveOrderEvent(sourceId: string, headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<InboundResult> {
  const source = (await withSystem((c) => c.query("SELECT * FROM order_sources WHERE id = $1", [sourceId]))).rows[0] as Row | undefined;
  if (!source) return { status: 404, outcome: "rejected", detail: "No such order source." };
  if (source.status !== "active") return { status: 410, outcome: "rejected", detail: "This order source is turned off." };
  const secret = decryptSecret(source.secret_ciphertext, appEnv().encryptionKey);

  let topic: string;
  let deliveryId: string;
  if (source.kind === "shopify") {
    if (!verifyShopifySignature(secret, rawBody, header(headers, "x-shopify-hmac-sha256"))) return { status: 401, outcome: "rejected", detail: "The Shopify signature doesn't match this source's secret." };
    topic = header(headers, "x-shopify-topic") ?? "orders/updated";
    deliveryId = header(headers, "x-shopify-webhook-id") ?? createHash("sha256").update(rawBody).digest("hex");
  } else {
    if (!verifySignature(secret, rawBody, header(headers, "x-setra-timestamp"), header(headers, "x-setra-signature"))) {
      return { status: 401, outcome: "rejected", detail: "The signature or timestamp doesn't match this source's secret." };
    }
    topic = "order";
    deliveryId = header(headers, "x-setra-delivery-id") ?? createHash("sha256").update(rawBody).digest("hex");
  }
  deliveryId = deliveryId.slice(0, 200);

  return withTenant(source.organization_id, async (c) => {
    const seen = (await c.query("SELECT * FROM order_source_events WHERE source_id = $1 AND delivery_id = $2", [sourceId, deliveryId])).rows[0] as Row | undefined;
    if (seen) return { status: 200, outcome: seen.outcome, detail: seen.detail ?? undefined, invoice_id: seen.invoice_id, duplicate: true };

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return record(c, source, deliveryId, topic, null, "failed", "The body isn't valid JSON.", null);
    }
    let order: OrderInput;
    if (source.kind === "shopify") {
      const mapped = shopifyOrder(topic, body as Row);
      if ("ignore" in mapped) return record(c, source, deliveryId, topic, `shopify:${(body as Row)?.id ?? "?"}`, "ignored", mapped.ignore, null);
      order = mapped.order;
    } else {
      const parsed = orderInput.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return record(c, source, deliveryId, topic, (body as Row)?.external_id ?? null, "failed", `${issue?.path.join(".") || "order"}: ${issue?.message ?? "invalid"}`, null);
      }
      order = parsed.data;
    }
    const actor: Actor = { type: "system", id: source.id, label: `Order source · ${source.name}` };
    try {
      // A savepoint keeps the delivery record even when the order itself is refused.
      await c.query("SAVEPOINT order_upsert");
      const result = await upsertOrder(c, source.organization_id, source.environment, order, actor, { id: source.id });
      await c.query("RELEASE SAVEPOINT order_upsert");
      return record(c, source, deliveryId, topic, order.external_id, result.outcome, result.detail ?? null, result.invoice?.id ?? null);
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT order_upsert");
      if (!(error instanceof EngineError)) throw error;
      return record(c, source, deliveryId, topic, order.external_id, "failed", error.message, null);
    }
  });
}

async function record(c: Client, source: Row, deliveryId: string, topic: string, externalId: string | null, outcome: SourceOutcome, detail: string | null, invoiceId: string | null): Promise<InboundResult> {
  await c.query(
    "INSERT INTO order_source_events (id, organization_id, environment, source_id, delivery_id, topic, external_id, outcome, detail, invoice_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [newId("orderSourceEvent"), source.organization_id, source.environment, source.id, deliveryId, topic.slice(0, 60), externalId ? String(externalId).slice(0, 120) : null, outcome, detail ? detail.slice(0, 500) : null, invoiceId]
  );
  await c.query("UPDATE order_sources SET last_event_at = now() WHERE id = $1", [source.id]);
  log().info("order_source_event", { organizationId: source.organization_id, sourceId: source.id, outcome, externalId });
  return { status: 200, outcome, detail: detail ?? undefined, invoice_id: invoiceId };
}
