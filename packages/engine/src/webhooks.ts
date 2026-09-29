import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { appEnv } from "@setra/config";
import { withSystem, withTenant, type Client } from "@setra/database";
import { API_VERSION, isRetryableStatus, retryDelayMs, signatureHeader } from "@setra/events";
import { newId } from "@setra/schemas";
import { decryptSecret, encryptSecret } from "@setra/security";
import { audit, EngineError, log, type Actor } from "./context";
import { enqueueWebhooks } from "./financial-events";

const randomBytesHex = (bytes: number) => randomBytes(bytes).toString("hex");

type Row = Record<string, any>;

/** Webhook signing secrets: shown once at creation/rotation, stored encrypted (they must be readable to sign). */
export function newWebhookSecret(): { secret: string; ciphertext: string; hint: string } {
  const secret = `whsec_${randomBytesHex(24)}`;
  return { secret, ciphertext: encryptSecret(secret, appEnv().encryptionKey), hint: `whsec_…${secret.slice(-4)}` };
}

/** Rotation keeps the previous secret valid for 24 hours; deliveries are signed with both during the overlap. */
export async function rotateWebhookSecret(client: Client, organizationId: string, endpointId: string, actor: Actor): Promise<{ secret: string }> {
  const endpoint = (await client.query("SELECT * FROM webhook_endpoints WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL FOR UPDATE", [endpointId, organizationId])).rows[0] as Row | undefined;
  if (!endpoint) throw new EngineError("not_found", "No such webhook endpoint.", 404);
  const next = newWebhookSecret();
  await client.query(
    `UPDATE webhook_endpoints SET previous_secret_ciphertext = secret_ciphertext, previous_secret_expires_at = now() + interval '24 hours',
       secret_ciphertext = $1, secret_hint = $2, updated_at = now() WHERE id = $3`,
    [next.ciphertext, next.hint, endpointId]
  );
  await audit(client, actor, { organizationId, environment: endpoint.environment, action: "webhook_secret_rotated", objectType: "webhook_endpoint", objectId: endpointId, next: { hint: next.hint } });
  return { secret: next.secret };
}

export async function sendTestEvent(client: Client, organizationId: string, endpointId: string, actor: Actor): Promise<string | null> {
  const endpoint = (await client.query("SELECT * FROM webhook_endpoints WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL", [endpointId, organizationId])).rows[0] as Row | undefined;
  if (!endpoint) throw new EngineError("not_found", "No such webhook endpoint.", 404);
  const id = newId("webhookDelivery");
  const envelope = {
    id: `evt_test_${randomBytesHex(8)}`,
    object: "event",
    type: "webhook.test",
    api_version: API_VERSION,
    created_at: new Date().toISOString(),
    livemode: endpoint.environment === "live",
    data: { message: "This is a test event from Setra. Verify the signature, then return any 2xx status." }
  };
  await client.query(`INSERT INTO webhook_deliveries (id, organization_id, environment, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,$4,NULL,'webhook.test',$5)`, [
    id,
    organizationId,
    endpoint.environment,
    endpointId,
    JSON.stringify(envelope)
  ]);
  await audit(client, actor, { organizationId, environment: endpoint.environment, action: "webhook_test_sent", objectType: "webhook_endpoint", objectId: endpointId });
  return id;
}

/** Replay creates a new delivery of the identical payload. The original delivery and its attempts are untouched. */
export async function replayDelivery(client: Client, organizationId: string, deliveryId: string, actor: Actor): Promise<string> {
  const original = (await client.query("SELECT * FROM webhook_deliveries WHERE id = $1 AND organization_id = $2", [deliveryId, organizationId])).rows[0] as Row | undefined;
  if (!original) throw new EngineError("not_found", "No such webhook delivery.", 404);
  const endpoint = (await client.query("SELECT archived_at FROM webhook_endpoints WHERE id = $1", [original.endpoint_id])).rows[0] as Row;
  if (endpoint.archived_at) throw new EngineError("endpoint_deleted", "The endpoint for this delivery was deleted.", 409);
  const id = newId("webhookDelivery");
  await client.query(
    `INSERT INTO webhook_deliveries (id, organization_id, environment, endpoint_id, event_id, event_type, payload, replay_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, organizationId, original.environment, original.endpoint_id, original.event_id, original.event_type, JSON.stringify(original.payload), original.id]
  );
  await audit(client, actor, { organizationId, environment: original.environment, action: "webhook_replayed", objectType: "webhook_delivery", objectId: id, previous: { replay_of: original.id } });
  log().info("webhook_replayed", { organizationId, deliveryId: id, replayOf: original.id });
  return id;
}

export { enqueueWebhooks };

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Delivery worker
// ────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeliveryOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

/** Claim due deliveries across all tenants and send them. Returns the number attempted. */
export async function deliverDueWebhooks(options: DeliveryOptions = {}): Promise<number> {
  const env = appEnv();
  const claimed = await withSystem(async (client) => {
    const r = await client.query(
      `UPDATE webhook_deliveries d SET status = 'delivering', locked_until = now() + interval '90 seconds', updated_at = now()
        WHERE d.id IN (
          SELECT id FROM webhook_deliveries
           WHERE (status IN ('pending','retrying') AND next_attempt_at <= now()) OR (status = 'delivering' AND locked_until < now())
           ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.organization_id`,
      [options.batchSize ?? 25]
    );
    return r.rows as { id: string; organization_id: string }[];
  });
  await Promise.all(claimed.map((row) => deliverOne(row.organization_id, row.id, { maxAttempts: env.WEBHOOK_MAX_ATTEMPTS, timeoutMs: env.WEBHOOK_TIMEOUT_MS, ...options })));
  return claimed.length;
}

async function deliverOne(organizationId: string, deliveryId: string, options: DeliveryOptions): Promise<void> {
  const env = appEnv();
  const { delivery, endpoint } = await withTenant(organizationId, async (client) => {
    const d = (await client.query("SELECT * FROM webhook_deliveries WHERE id = $1", [deliveryId])).rows[0] as Row;
    const e = (await client.query("SELECT * FROM webhook_endpoints WHERE id = $1", [d.endpoint_id])).rows[0] as Row;
    return { delivery: d, endpoint: e };
  });

  const attemptNumber = Number(delivery.attempt_count) + 1;
  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  let status: number | null = null;
  let responseBody = "";
  let responseHeaders: Record<string, string> = {};
  let error: string | null = null;
  const started = Date.now();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Setra-Webhooks/1.0 (+https://setra.dev/docs/webhooks)",
    "x-setra-event-id": String(delivery.payload?.id ?? ""),
    "x-setra-event-type": delivery.event_type,
    "x-setra-delivery-id": delivery.id,
    "x-setra-timestamp": String(timestamp)
  };

  if (!endpoint.enabled || endpoint.archived_at) {
    error = "Endpoint disabled";
  } else {
    try {
      const secrets = [decryptSecret(endpoint.secret_ciphertext, env.encryptionKey)];
      if (endpoint.previous_secret_ciphertext && endpoint.previous_secret_expires_at && new Date(endpoint.previous_secret_expires_at) > new Date()) {
        secrets.push(decryptSecret(endpoint.previous_secret_ciphertext, env.encryptionKey));
      }
      headers["x-setra-signature"] = signatureHeader(secrets, timestamp, rawBody);
      await assertDeliverableUrl(endpoint.url, env.allowPrivateWebhookUrls);
      const response = await (options.fetchImpl ?? fetch)(endpoint.url, {
        method: "POST",
        headers,
        body: rawBody,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
      });
      status = response.status;
      responseHeaders = Object.fromEntries([...response.headers.entries()].filter(([k]) => ["content-type", "x-request-id", "retry-after"].includes(k)));
      responseBody = (await response.text().catch(() => "")).slice(0, 2000);
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e) {
      error = (e as Error).name === "TimeoutError" ? `Timed out after ${options.timeoutMs ?? 10_000}ms` : (e as Error).message.slice(0, 500);
    }
  }
  const duration = Date.now() - started;
  const delivered = status !== null && status >= 200 && status < 300;
  const permanent = !delivered && (!isRetryableStatus(status) || !endpoint.enabled || !!endpoint.archived_at);
  const exhausted = attemptNumber >= (options.maxAttempts ?? 10);
  const nextStatus = delivered ? "delivered" : permanent || exhausted ? "failed" : "retrying";

  await withTenant(organizationId, async (client) => {
    await client.query(
      `INSERT INTO webhook_attempts (id, organization_id, delivery_id, attempt_number, request_url, request_headers, response_status, response_headers, response_body_excerpt, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId("webhookAttempt"), organizationId, delivery.id, attemptNumber, endpoint.url, JSON.stringify(headers), status, JSON.stringify(responseHeaders), responseBody || null, error, duration]
    );
    await client.query(
      `UPDATE webhook_deliveries SET status = $1::webhook_delivery_status, attempt_count = $2, next_attempt_at = $3, locked_until = NULL, last_response_status = $4, last_error = $5,
         delivered_at = CASE WHEN $7::boolean THEN now() ELSE delivered_at END, updated_at = now() WHERE id = $6`,
      [nextStatus, attemptNumber, new Date(Date.now() + retryDelayMs(attemptNumber)), status, error, delivery.id, delivered]
    );
  });
  const logFields = { organizationId, deliveryId: delivery.id, endpointId: endpoint.id, eventType: delivery.event_type, status, attempt: attemptNumber, durationMs: duration };
  if (delivered) log().info("webhook_sent", logFields);
  else log().warn("webhook_failed", { ...logFields, error, next: nextStatus });
}

/**
 * SSRF protection for live endpoints: resolve the host and refuse loopback, private, link-local and
 * metadata addresses. Development allows localhost so merchants can test against local servers.
 */
export async function assertDeliverableUrl(url: string, allowPrivate: boolean): Promise<void> {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Webhook URLs must use http or https");
  if (allowPrivate) return;
  if (parsed.protocol !== "https:") throw new Error("Live webhook URLs must use https");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error("Webhook URL resolves to a private or reserved address");
  }
}

export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const a = address.toLowerCase();
    if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7));
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
  }
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
