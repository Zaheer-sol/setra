import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Client } from "@setra/database";
import { addCustomerAddress, audit, createCustomer, serializeCustomer } from "@setra/engine";
import { addCustomerAddressInput, createCustomerInput, customerListQuery, updateCustomerInput } from "@setra/schemas";
import { notFound } from "../lib/errors";
import { cursorClause, page } from "../lib/pagination";
import { idParam, route } from "../lib/route";

type Row = Record<string, any>;

async function customerStats(client: Client, ids: string[]) {
  if (!ids.length) return new Map<string, Row>();
  const r = await client.query(
    `SELECT c.id,
       (SELECT count(*) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('open','partially_paid'))::int AS open_invoices,
       (SELECT count(*) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('paid','overpaid'))::int AS paid_invoices,
       (SELECT count(*) FROM exceptions e WHERE e.customer_id = c.id AND e.status = 'open')::int AS open_exceptions,
       (SELECT COALESCE(SUM(p.amount / power(10::numeric, a.decimals)), 0) FROM payments p JOIN assets a ON a.id = p.asset_id
         WHERE a.peg_currency = 'USD' AND p.customer_id = c.id AND p.status IN ('matched','partial','overpaid'))::text AS total_received,
       (SELECT COALESCE(SUM(GREATEST(i.amount_due - i.amount_paid - i.amount_written_off, 0) / power(10::numeric, a.decimals)), 0) FROM invoices i JOIN assets a ON a.id = i.asset_id
         WHERE a.peg_currency = 'USD' AND i.customer_id = c.id AND i.status IN ('open','partially_paid'))::text AS outstanding
     FROM customers c WHERE c.id = ANY($1)`,
    [ids]
  );
  return new Map(r.rows.map((row) => [row.id, row]));
}

async function customerAddresses(client: Client, ids: string[]) {
  if (!ids.length) return new Map<string, Row[]>();
  const r = await client.query("SELECT * FROM customer_addresses WHERE customer_id = ANY($1) ORDER BY created_at", [ids]);
  const map = new Map<string, Row[]>();
  for (const row of r.rows) map.set(row.customer_id, [...(map.get(row.customer_id) ?? []), row]);
  return map;
}

export function customerRoutes(app: FastifyInstance) {
  const present = async (c: Client, rows: Row[]) => {
    const ids = rows.map((r) => r.id);
    const [stats, addresses] = await Promise.all([customerStats(c, ids), customerAddresses(c, ids)]);
    return (row: Row) => serializeCustomer(row, { stats: stats.get(row.id), addresses: addresses.get(row.id) ?? [] });
  };
  const load = async (c: Client, id: string, organizationId: string, environment: string) => {
    const row = (await c.query("SELECT * FROM customers WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL", [id, organizationId, environment])).rows[0];
    if (!row) throw notFound("customer");
    return row;
  };

  route(app, {
    method: "POST",
    url: "/v1/customers",
    summary: "Create a customer",
    tags: ["customers"],
    permission: "customers:write",
    idempotent: true,
    body: createCustomerInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) => {
      reply.code(201);
      return tx(async (c) => {
        const row = await createCustomer(c, organizationId, environment, body, actor);
        return (await present(c, [row]))(row);
      });
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/customers",
    summary: "List customers",
    tags: ["customers"],
    permission: "read",
    query: customerListQuery,
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment];
        let where = "organization_id = $1 AND environment = $2 AND archived_at IS NULL";
        if (query.search) {
          params.push(`%${query.search.replace(/[%_\\]/g, "\\$&")}%`);
          where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR external_ref ILIKE $${params.length}
                    OR id IN (SELECT customer_id FROM customer_addresses WHERE address ILIKE $${params.length}))`;
        }
        where += cursorClause(params, query.starting_after);
        params.push(query.limit + 1);
        const rows = (await c.query(`SELECT * FROM customers WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params)).rows;
        return page(rows, query.limit, await present(c, rows));
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/customers/:id",
    summary: "Retrieve a customer with balances",
    tags: ["customers"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const row = await load(c, params.id, organizationId, environment);
        return (await present(c, [row]))(row);
      })
  });

  route(app, {
    method: "PATCH",
    url: "/v1/customers/:id",
    summary: "Update a customer",
    tags: ["customers"],
    permission: "customers:write",
    params: idParam,
    body: updateCustomerInput,
    handler: async ({ params, body, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        const before = await load(c, params.id, organizationId, environment);
        const row = (
          await c.query(
            `UPDATE customers SET name = COALESCE($2, name),
               email = CASE WHEN $3::boolean THEN $4 ELSE email END,
               external_ref = CASE WHEN $5::boolean THEN $6 ELSE external_ref END,
               metadata = COALESCE($7, metadata), updated_at = now() WHERE id = $1 RETURNING *`,
            [params.id, body.name ?? null, body.email !== undefined, body.email ?? null, body.external_ref !== undefined, body.external_ref ?? null, body.metadata ? JSON.stringify(body.metadata) : null]
          )
        ).rows[0];
        await audit(c, actor, { organizationId, environment, action: "customer_updated", objectType: "customer", objectId: params.id, previous: { name: before.name, email: before.email }, next: body });
        return (await present(c, [row]))(row);
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/customers/:id/wallet-addresses",
    summary: "Link a customer wallet address (used for matching)",
    tags: ["customers"],
    permission: "customers:write",
    params: idParam,
    body: addCustomerAddressInput,
    handler: async ({ params, body, tx, organizationId, environment, actor, reply }) =>
      tx(async (c) => {
        await load(c, params.id, organizationId, environment);
        await addCustomerAddress(c, organizationId, environment, params.id, body, actor);
        reply.code(201);
        const row = await load(c, params.id, organizationId, environment);
        return (await present(c, [row]))(row);
      })
  });

  route(app, {
    method: "DELETE",
    url: "/v1/customers/:id/wallet-addresses/:addressId",
    summary: "Unlink a customer wallet address",
    tags: ["customers"],
    permission: "customers:write",
    params: z.object({ id: z.string().max(64), addressId: z.string().max(64) }),
    handler: async ({ params, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        await load(c, params.id, organizationId, environment);
        const r = await c.query("DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2 RETURNING address", [params.addressId, params.id]);
        if (!r.rows[0]) throw notFound("wallet address");
        await audit(c, actor, { organizationId, environment, action: "customer_address_removed", objectType: "customer", objectId: params.id, previous: { address: r.rows[0].address } });
        const row = await load(c, params.id, organizationId, environment);
        return (await present(c, [row]))(row);
      })
  });
}
