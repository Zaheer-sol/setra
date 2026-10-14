import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appEnv } from "@setra/config";
import {
  assertDeliverableUrl,
  audit,
  confirmSimulatedPayment,
  createPaymentIntent,
  newWebhookSecret,
  replayDelivery,
  rotateWebhookSecret,
  sendTestEvent,
  serializeDelivery,
  serializePaymentIntent,
  serializeWebhookEndpoint,
  simulatePayment,
  simulateReorg
} from "@setra/engine";
import {
  createApiKeyInput,
  createPaymentIntentInput,
  createWebhookEndpointInput,
  financialEventListQuery,
  listQuery,
  newId,
  simulatePaymentInput,
  updateWebhookEndpointInput,
  webhookDeliveryListQuery,
  WEBHOOK_EVENT_NAMES,
  BUSINESS_EVENT_NAMES
} from "@setra/schemas";
import { generateApiKey } from "../lib/auth";
import { ApiError, forbidden, notFound } from "../lib/errors";
import { cursorClause, page } from "../lib/pagination";
import { can } from "../lib/principal";
import { idParam, route } from "../lib/route";
import { paymentDetail } from "./payments";

export function developerRoutes(app: FastifyInstance) {
  // ── financial events ───────────────────────────────────────────────────────────────────────

  route(app, {
    method: "GET",
    url: "/v1/financial-events",
    summary: "List financial events (newest first)",
    tags: ["financial-events"],
    permission: "read",
    query: financialEventListQuery,
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment];
        let where = "organization_id = $1 AND environment = $2";
        const add = (sql: string, v: unknown) => {
          params.push(v);
          where += ` AND ${sql.replace("?", `$${params.length}`)}`;
        };
        if (query.type) {
          // Accept either the internal name (PAYMENT_MATCHED) or the webhook name (payment.matched).
          const internal = Object.entries({ ...WEBHOOK_EVENT_NAMES, ...BUSINESS_EVENT_NAMES }).find(([, name]) => name === query.type)?.[0] ?? query.type.toUpperCase();
          add("type = ?", internal);
        }
        if (query.invoice_id) add("invoice_id = ?", query.invoice_id);
        if (query.payment_id) add("payment_id = ?", query.payment_id);
        where += cursorClause(params, query.starting_after);
        params.push(query.limit + 1);
        const rows = (await c.query(`SELECT id, data FROM financial_events WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params)).rows;
        return page(rows, query.limit, (r) => r.data);
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/financial-events/:id",
    summary: "Retrieve a financial event",
    tags: ["financial-events"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const row = (await c.query("SELECT data, event_version, schema_version FROM financial_events WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0];
        if (!row) throw notFound("financial event");
        const deliveries = (
          await c.query(
            "SELECT d.*, e.url AS endpoint_url FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.event_id = $1 ORDER BY d.id DESC",
            [params.id]
          )
        ).rows;
        // Accounting events keep their versions in the columns only.
        return { event_version: row.event_version, schema_version: row.schema_version, ...row.data, webhook_deliveries: deliveries.map((d) => serializeDelivery({ ...d, payload: undefined })) };
      })
  });

  // ── payment intents ────────────────────────────────────────────────────────────────────────

  route(app, {
    method: "POST",
    url: "/v1/payment-intents",
    summary: "Prepare a structured payment intent for an invoice",
    tags: ["payment-intents"],
    permission: "invoices:write",
    idempotent: true,
    body: createPaymentIntentInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) =>
      tx(async (c) => {
        const inv = (await c.query("SELECT id FROM invoices WHERE id = $1 AND organization_id = $2 AND environment = $3", [body.invoice_id, organizationId, environment])).rows[0];
        if (!inv) throw notFound("invoice");
        const intent = await createPaymentIntent(c, organizationId, body.invoice_id, { ttlSeconds: body.expires_in_seconds }, actor);
        reply.code(201);
        return serializePaymentIntent(intent);
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/payment-intents",
    summary: "List payment intents",
    tags: ["payment-intents"],
    permission: "read",
    query: listQuery.extend({ invoice_id: z.string().max(64).optional() }),
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment];
        let where = "organization_id = $1 AND environment = $2";
        if (query.invoice_id) {
          params.push(query.invoice_id);
          where += ` AND invoice_id = $${params.length}`;
        }
        where += cursorClause(params, query.starting_after);
        params.push(query.limit + 1);
        const rows = (await c.query(`SELECT * FROM payment_intents WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params)).rows;
        return page(rows, query.limit, serializePaymentIntent);
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/payment-intents/:id",
    summary: "Retrieve a payment intent",
    tags: ["payment-intents"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const row = (await c.query("SELECT * FROM payment_intents WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0];
        if (!row) throw notFound("payment intent");
        return serializePaymentIntent(row);
      })
  });

  // ── webhooks ───────────────────────────────────────────────────────────────────────────────

  route(app, {
    method: "POST",
    url: "/v1/webhook-endpoints",
    summary: "Create a webhook endpoint (the signing secret is returned once)",
    tags: ["webhooks"],
    permission: "webhooks:write",
    idempotent: true,
    body: createWebhookEndpointInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) => {
      await validateWebhookUrl(body.url, environment);
      const secret = newWebhookSecret();
      const id = newId("webhookEndpoint");
      const row = await tx(async (c) => {
        await c.query(
          `INSERT INTO webhook_endpoints (id, organization_id, environment, url, description, event_types, secret_ciphertext, secret_hint, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, organizationId, environment, body.url, body.description ?? null, body.event_types, secret.ciphertext, secret.hint, actor.id]
        );
        await audit(c, actor, { organizationId, environment, action: "webhook_endpoint_created", objectType: "webhook_endpoint", objectId: id, next: { url: body.url, event_types: body.event_types } });
        return (await c.query("SELECT * FROM webhook_endpoints WHERE id = $1", [id])).rows[0];
      });
      reply.code(201);
      return { ...serializeWebhookEndpoint(row), secret: secret.secret };
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/webhook-endpoints",
    summary: "List webhook endpoints",
    tags: ["webhooks"],
    permission: "read",
    handler: async ({ tx, organizationId, environment }) =>
      tx(async (c) => {
        const rows = (
          await c.query(
            `SELECT e.*, (SELECT count(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'failed')::int AS failed_count,
                    (SELECT max(delivered_at) FROM webhook_deliveries d WHERE d.endpoint_id = e.id) AS last_delivered_at
               FROM webhook_endpoints e WHERE e.organization_id = $1 AND e.environment = $2 AND e.archived_at IS NULL ORDER BY e.id DESC`,
            [organizationId, environment]
          )
        ).rows;
        return { object: "list", data: rows.map((r) => ({ ...serializeWebhookEndpoint(r), failed_deliveries: r.failed_count, last_delivered_at: r.last_delivered_at })), has_more: false, next_cursor: null };
      })
  });

  route(app, {
    method: "PATCH",
    url: "/v1/webhook-endpoints/:id",
    summary: "Update a webhook endpoint",
    tags: ["webhooks"],
    permission: "webhooks:write",
    params: idParam,
    body: updateWebhookEndpointInput,
    handler: async ({ params, body, tx, organizationId, environment, actor }) => {
      if (body.url) await validateWebhookUrl(body.url, environment);
      return tx(async (c) => {
        const before = (await c.query("SELECT * FROM webhook_endpoints WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL", [params.id, organizationId, environment])).rows[0];
        if (!before) throw notFound("webhook endpoint");
        const row = (
          await c.query(
            `UPDATE webhook_endpoints SET url = COALESCE($2, url), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
               event_types = COALESCE($5, event_types), enabled = COALESCE($6, enabled), updated_at = now() WHERE id = $1 RETURNING *`,
            [params.id, body.url ?? null, body.description !== undefined, body.description ?? null, body.event_types ?? null, body.enabled ?? null]
          )
        ).rows[0];
        await audit(c, actor, { organizationId, environment, action: "webhook_endpoint_updated", objectType: "webhook_endpoint", objectId: params.id, previous: { url: before.url, enabled: before.enabled, event_types: before.event_types }, next: body });
        return serializeWebhookEndpoint(row);
      });
    }
  });

  route(app, {
    method: "DELETE",
    url: "/v1/webhook-endpoints/:id",
    summary: "Delete a webhook endpoint (delivery history is kept)",
    tags: ["webhooks"],
    permission: "webhooks:write",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        const r = await c.query("UPDATE webhook_endpoints SET archived_at = now(), enabled = false WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL RETURNING id", [
          params.id,
          organizationId,
          environment
        ]);
        if (!r.rows[0]) throw notFound("webhook endpoint");
        await audit(c, actor, { organizationId, environment, action: "webhook_endpoint_deleted", objectType: "webhook_endpoint", objectId: params.id });
        return { id: params.id, deleted: true };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/webhook-endpoints/:id/rotate-secret",
    summary: "Rotate the signing secret (the previous secret keeps working for 24 hours)",
    tags: ["webhooks"],
    permission: "webhooks:write",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        const e = (await c.query("SELECT id FROM webhook_endpoints WHERE id = $1 AND environment = $2", [params.id, environment])).rows[0];
        if (!e) throw notFound("webhook endpoint");
        return rotateWebhookSecret(c, organizationId, params.id, actor);
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/webhook-endpoints/:id/test",
    summary: "Send a signed webhook.test event",
    tags: ["webhooks"],
    permission: "webhooks:write",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment, actor, reply }) =>
      tx(async (c) => {
        const e = (await c.query("SELECT id FROM webhook_endpoints WHERE id = $1 AND environment = $2", [params.id, environment])).rows[0];
        if (!e) throw notFound("webhook endpoint");
        const deliveryId = await sendTestEvent(c, organizationId, params.id, actor);
        reply.code(202);
        return { delivery_id: deliveryId, message: "Queued. It will be delivered within a few seconds." };
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/webhook-deliveries",
    summary: "List webhook deliveries",
    tags: ["webhooks"],
    permission: "read",
    query: webhookDeliveryListQuery,
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment];
        let where = "d.organization_id = $1 AND d.environment = $2";
        const add = (sql: string, v: unknown) => {
          params.push(v);
          where += ` AND ${sql.replace("?", `$${params.length}`)}`;
        };
        if (query.endpoint_id) add("d.endpoint_id = ?", query.endpoint_id);
        if (query.status) add("d.status = ?", query.status);
        if (query.event_id) add("d.event_id = ?", query.event_id);
        where += cursorClause(params, query.starting_after, "d.id");
        params.push(query.limit + 1);
        const rows = (
          await c.query(
            `SELECT d.*, e.url AS endpoint_url, (SELECT duration_ms FROM webhook_attempts a WHERE a.delivery_id = d.id ORDER BY attempt_number DESC LIMIT 1) AS last_duration_ms
               FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE ${where} ORDER BY d.id DESC LIMIT $${params.length}`,
            params
          )
        ).rows;
        return page(rows, query.limit, (r) => ({ ...serializeDelivery({ ...r, payload: undefined }), last_duration_ms: r.last_duration_ms }));
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/webhook-deliveries/:id",
    summary: "Retrieve a delivery with payload and every attempt",
    tags: ["webhooks"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const d = (
          await c.query("SELECT d.*, e.url AS endpoint_url FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = $1 AND d.organization_id = $2 AND d.environment = $3", [
            params.id,
            organizationId,
            environment
          ])
        ).rows[0];
        if (!d) throw notFound("webhook delivery");
        const attempts = (await c.query("SELECT * FROM webhook_attempts WHERE delivery_id = $1 ORDER BY attempt_number", [params.id])).rows;
        return serializeDelivery(d, attempts);
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/webhook-deliveries/:id/replay",
    summary: "Replay a delivery (sends the identical payload as a new delivery)",
    tags: ["webhooks"],
    permission: "webhooks:write",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment, actor, reply }) =>
      tx(async (c) => {
        const d = (await c.query("SELECT id FROM webhook_deliveries WHERE id = $1 AND environment = $2", [params.id, environment])).rows[0];
        if (!d) throw notFound("webhook delivery");
        const id = await replayDelivery(c, organizationId, params.id, actor);
        reply.code(202);
        return { delivery_id: id, replay_of: params.id };
      })
  });

  // ── API keys ───────────────────────────────────────────────────────────────────────────────

  route(app, {
    method: "GET",
    url: "/v1/api-keys",
    summary: "List API keys (secrets are never returned)",
    tags: ["api-keys"],
    permission: "read",
    sessionOnly: true,
    handler: async ({ tx, organizationId }) =>
      tx(async (c) => {
        const rows = (await c.query("SELECT * FROM api_keys WHERE organization_id = $1 ORDER BY revoked_at IS NOT NULL, id DESC", [organizationId])).rows;
        return { object: "list", data: rows.map(serializeKey), has_more: false, next_cursor: null };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/api-keys",
    summary: "Create an API key (the secret is shown once)",
    tags: ["api-keys"],
    permission: "api_keys:write",
    sessionOnly: true,
    body: createApiKeyInput,
    handler: async ({ body, tx, organizationId, environment, actor, principal, reply }) => {
      const mode = body.mode ?? environment;
      if (mode === "live" && !can(principal, "api_keys:write_live")) throw forbidden("Only owners and admins can create live keys.");
      const key = generateApiKey(mode);
      const id = newId("apiKey");
      const row = await tx(async (c) => {
        await c.query("INSERT INTO api_keys (id, organization_id, environment, name, prefix, secret_hash, scope, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
          id,
          organizationId,
          mode,
          body.name,
          key.prefix,
          key.hash,
          body.scope,
          actor.id
        ]);
        await audit(c, actor, { organizationId, environment: mode, action: "api_key_created", objectType: "api_key", objectId: id, next: { name: body.name, scope: body.scope, prefix: key.prefix } });
        return (await c.query("SELECT * FROM api_keys WHERE id = $1", [id])).rows[0];
      });
      reply.code(201);
      return { ...serializeKey(row), secret: key.secret };
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/api-keys/:id/revoke",
    summary: "Revoke an API key immediately",
    tags: ["api-keys"],
    permission: "api_keys:write",
    sessionOnly: true,
    params: idParam,
    handler: async ({ params, tx, organizationId, actor, principal }) =>
      tx(async (c) => {
        const k = (await c.query("SELECT * FROM api_keys WHERE id = $1 AND organization_id = $2 FOR UPDATE", [params.id, organizationId])).rows[0];
        if (!k) throw notFound("API key");
        if (k.environment === "live" && !can(principal, "api_keys:write_live")) throw forbidden("Only owners and admins can revoke live keys.");
        if (k.revoked_at) return serializeKey(k);
        const row = (await c.query("UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *", [params.id, actor.id])).rows[0];
        await audit(c, actor, { organizationId, environment: k.environment, action: "api_key_revoked", objectType: "api_key", objectId: params.id, previous: { prefix: k.prefix } });
        return serializeKey(row);
      })
  });

  // ── test mode simulator ────────────────────────────────────────────────────────────────────

  route(app, {
    method: "POST",
    url: "/v1/test/payments",
    summary: "Test mode: simulate a payment through the real pipeline",
    tags: ["test-mode"],
    permission: "simulate",
    body: simulatePaymentInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) => {
      if (environment !== "test") throw new ApiError(403, "test_mode_only", "Simulations run only in test mode. Switch to test mode or use a sk_test_ key.");
      return tx(async (c) => {
        const result = await simulatePayment(c, organizationId, environment, body, actor);
        reply.code(201);
        return result.paymentId ? paymentDetail(c, result.paymentId, organizationId, environment) : { ok: true };
      });
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/test/payments/:id/confirm",
    summary: "Test mode: finalize a simulated confirming payment",
    tags: ["test-mode"],
    permission: "simulate",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) => {
      if (environment !== "test") throw new ApiError(403, "test_mode_only", "Only available in test mode.");
      return tx(async (c) => {
        await confirmSimulatedPayment(c, organizationId, params.id);
        return paymentDetail(c, params.id, organizationId, environment);
      });
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/test/payments/:id/reorg",
    summary: "Test mode: invalidate a simulated payment's block (controlled reorg)",
    tags: ["test-mode"],
    permission: "simulate",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment, actor }) => {
      if (environment !== "test") throw new ApiError(403, "test_mode_only", "Only available in test mode.");
      return tx(async (c) => {
        await simulateReorg(c, organizationId, params.id, actor);
        return paymentDetail(c, params.id, organizationId, environment);
      });
    }
  });
}

async function validateWebhookUrl(url: string, _environment: string) {
  try {
    // SSRF protection applies in both modes: test-mode deliveries originate from the same servers.
    await assertDeliverableUrl(url, appEnv().allowPrivateWebhookUrls);
  } catch (error) {
    throw new ApiError(422, "invalid_webhook_url", (error as Error).message);
  }
}

function serializeKey(row: Record<string, any>) {
  return {
    id: row.id,
    object: "api_key",
    name: row.name,
    mode: row.environment,
    scope: row.scope,
    prefix: row.prefix,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at
  };
}
