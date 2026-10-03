import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appEnv } from "@setra/config";
import type { Client } from "@setra/database";
import { createOrderSource, findOrder, receiveOrderEvent, setOrderSourceStatus, upsertOrder } from "@setra/engine";
import { createOrderSourceInput, orderInput } from "@setra/schemas";
import { notFound } from "../lib/errors";
import { idParam, route } from "../lib/route";
import { presentInvoices } from "./invoices";

type Row = Record<string, any>;

const INVOICE_SELECT = `SELECT i.*, w.address AS wallet_address, c.name AS customer_name, c.email AS customer_email FROM invoices i
  JOIN wallets w ON w.id = i.wallet_id JOIN customers c ON c.id = i.customer_id`;

const externalParam = z.object({ external_id: z.string().trim().min(1).max(120) });

async function presentOne(c: Client, id: string) {
  const row = (await c.query(`${INVOICE_SELECT} WHERE i.id = $1`, [id])).rows[0] as Row;
  return (await presentInvoices(c, [row]))(row);
}

function serializeSource(row: Row) {
  return {
    id: row.id,
    object: "order_source",
    kind: row.kind,
    name: row.name,
    status: row.status,
    secret_hint: row.secret_hint,
    // Where the store, checkout or backend posts its orders (through the console's address).
    inbound_url: `${appEnv().publicAppUrl.replace(/\/$/, "")}/api/v1/inbound/orders/${row.id}`,
    last_event_at: row.last_event_at,
    created_at: row.created_at
  };
}

/**
 * Orders from the merchant's own systems: an API for backends, and order sources that stores,
 * checkouts and payment processors post to. Either way the merchant never creates invoices by hand.
 */
export function orderRoutes(app: FastifyInstance) {
  route(app, {
    method: "POST",
    url: "/v1/orders",
    summary: "Tell Setra about an order from your system (create, update or cancel by your order ID)",
    tags: ["orders"],
    permission: "invoices:write",
    idempotent: true,
    body: orderInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) =>
      tx(async (c) => {
        const result = await upsertOrder(c, organizationId, environment, body, actor);
        reply.code(result.outcome === "created" || result.outcome === "updated" ? 201 : 200);
        return { object: "order", external_id: body.external_id, outcome: result.outcome, detail: result.detail ?? null, invoice: result.invoice ? await presentOne(c, result.invoice.id) : null };
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/orders/:external_id",
    summary: "Look up an order by your own order ID",
    tags: ["orders"],
    permission: "read",
    params: externalParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const live = await findOrder(c, organizationId, environment, params.external_id);
        const row =
          live ??
          ((await c.query("SELECT * FROM invoices WHERE organization_id = $1 AND environment = $2 AND external_id = $3 ORDER BY created_at DESC LIMIT 1", [organizationId, environment, params.external_id])).rows[0] as Row | undefined);
        if (!row) throw notFound("order");
        return { object: "order", external_id: params.external_id, invoice: await presentOne(c, row.id) };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/orders/:external_id/cancel",
    summary: "Cancel an order by your own order ID",
    tags: ["orders"],
    permission: "invoices:write",
    idempotent: true,
    params: externalParam,
    handler: async ({ params, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        const result = await upsertOrder(c, organizationId, environment, { external_id: params.external_id, status: "cancelled", currency: "USD", asset: "USDC", network: "monad" } as never, actor);
        return { object: "order", external_id: params.external_id, outcome: result.outcome, detail: result.detail ?? null, invoice: result.invoice ? await presentOne(c, result.invoice.id) : null };
      })
  });

  // ── order sources ──────────────────────────────────────────────────────────────────────────────

  route(app, {
    method: "GET",
    url: "/v1/order-sources",
    summary: "Connected systems that post their orders to Setra",
    tags: ["orders"],
    permission: "read",
    handler: async ({ tx, organizationId, environment }) =>
      tx(async (c) => {
        const rows = (await c.query("SELECT * FROM order_sources WHERE organization_id = $1 AND environment = $2 ORDER BY created_at DESC", [organizationId, environment])).rows as Row[];
        const counts = rows.length
          ? ((await c.query("SELECT source_id, outcome, count(*)::int AS n FROM order_source_events WHERE source_id = ANY($1) GROUP BY 1, 2", [rows.map((r) => r.id)])).rows as Row[])
          : [];
        return {
          data: rows.map((r) => ({ ...serializeSource(r), counts: Object.fromEntries(counts.filter((x) => x.source_id === r.id).map((x) => [x.outcome, x.n])) }))
        };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/order-sources",
    summary: "Connect a store, checkout, payment processor or backend once; it then posts its orders to Setra",
    tags: ["orders"],
    permission: "webhooks:write",
    body: createOrderSourceInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) =>
      tx(async (c) => {
        const { source, secret } = await createOrderSource(c, organizationId, environment, body, actor);
        reply.code(201);
        // The secret of a generic source is shown once, like an API key.
        return { ...serializeSource(source), secret };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/order-sources/:id/status",
    summary: "Turn an order source off or back on",
    tags: ["orders"],
    permission: "webhooks:write",
    params: idParam,
    body: z.object({ status: z.enum(["active", "disabled"]) }),
    handler: async ({ params, body, tx, organizationId, actor }) => tx(async (c) => serializeSource(await setOrderSourceStatus(c, organizationId, params.id, body.status, actor)))
  });

  route(app, {
    method: "GET",
    url: "/v1/order-sources/:id/events",
    summary: "What a source sent and what Setra did with each delivery",
    tags: ["orders"],
    permission: "read",
    params: idParam,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
    handler: async ({ params, query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const source = (await c.query("SELECT id FROM order_sources WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0];
        if (!source) throw notFound("order source");
        const rows = (
          await c.query(
            `SELECT e.*, i.number AS invoice_number, i.status AS invoice_status FROM order_source_events e LEFT JOIN invoices i ON i.id = e.invoice_id
              WHERE e.source_id = $1 ORDER BY e.received_at DESC LIMIT $2`,
            [params.id, query.limit]
          )
        ).rows as Row[];
        return {
          data: rows.map((e) => ({
            id: e.id,
            delivery_id: e.delivery_id,
            topic: e.topic,
            external_id: e.external_id,
            outcome: e.outcome,
            detail: e.detail,
            invoice: e.invoice_id ? { id: e.invoice_id, number: e.invoice_number, status: e.invoice_status } : null,
            received_at: e.received_at
          }))
        };
      })
  });
}

/**
 * Where order sources post. It isn't behind a session or API key: each delivery is verified by its
 * signature instead, against the raw bytes, so the body is kept exactly as sent.
 */
export async function inboundOrderRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 512 * 1024 }, (_request, body, done) => done(null, body));
  app.post(
    "/v1/inbound/orders/:id",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } }, schema: { tags: ["orders"], summary: "Receive an order from a connected system (signed)", hide: true } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const raw = typeof request.body === "string" ? request.body : "";
      const result = await receiveOrderEvent(id, request.headers as Record<string, string | string[] | undefined>, raw);
      reply.code(result.status);
      return { outcome: result.outcome, detail: result.detail ?? null, invoice_id: result.invoice_id ?? null, duplicate: result.duplicate ?? false };
    }
  );
}
