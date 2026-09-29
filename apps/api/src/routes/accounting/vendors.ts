import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addVendorAddress, audit, createVendor, EngineError, money } from "@setra/engine";
import { accountingListQuery, createVendorInput, updateVendorInput } from "@setra/schemas";
import { notFound } from "../../lib/errors";
import { idParam, route } from "../../lib/route";
import { serializeBill, serializeExpense, BILL_SELECT, EXPENSE_SELECT } from "../../lib/payables-presenters";

type Row = Record<string, any>;

/** Vendors and their known wallet addresses. */
export function vendorRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/vendors",
    summary: "Vendors, with what you owe and have paid each",
    tags: ["vendors"],
    permission: "financials:read",
    query: accountingListQuery,
    handler: ({ tx, query, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment, query.limit + 1, query.offset];
        let where = "v.organization_id = $1 AND v.environment = $2 AND v.archived_at IS NULL";
        if (query.search) {
          params.push(`%${query.search}%`);
          where += ` AND (v.name ILIKE $${params.length} OR v.email ILIKE $${params.length})`;
        }
        const rows = (
          await c.query(
            `SELECT v.*,
                    (SELECT COALESCE(sum(amount - amount_paid), 0)::text FROM bills b WHERE b.vendor_id = v.id AND b.status IN ('approved','partially_paid')) AS owed,
                    ((SELECT COALESCE(sum(bp.amount), 0) FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id WHERE b.vendor_id = v.id) +
                     (SELECT COALESCE(sum(x.amount), 0) FROM expenses x WHERE x.vendor_id = v.id AND x.status = 'approved'))::text AS paid,
                    (SELECT count(*)::int FROM vendor_addresses va WHERE va.vendor_id = v.id) AS addresses
               FROM vendors v WHERE ${where} ORDER BY v.name LIMIT $3 OFFSET $4`,
            params
          )
        ).rows as Row[];
        return { object: "list", data: rows.slice(0, query.limit).map((v) => ({ id: v.id, object: "vendor", name: v.name, email: v.email, owed: money(BigInt(v.owed)), paid: money(BigInt(v.paid)), wallet_addresses: v.addresses, created_at: v.created_at })), has_more: rows.length > query.limit };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/vendors",
    summary: "Add a vendor",
    tags: ["vendors"],
    permission: "financials:write",
    idempotent: true,
    body: createVendorInput,
    handler: async ({ tx, body, organizationId, environment, actor, reply }) => {
      const v = await tx((c) => createVendor(c, organizationId, environment, body, actor));
      reply.code(201);
      return { id: v.id, object: "vendor", name: v.name, email: v.email };
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/vendors/:id",
    summary: "A vendor with bills, expenses and wallet addresses",
    tags: ["vendors"],
    permission: "financials:read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment }) =>
      tx(async (c) => {
        const v = (await c.query("SELECT v.*, a.code AS account_code, a.name AS account_name FROM vendors v LEFT JOIN ledger_accounts a ON a.id = v.default_account_id WHERE v.id = $1 AND v.organization_id = $2 AND v.environment = $3", [params.id, organizationId, environment])).rows[0] as Row | undefined;
        if (!v) throw notFound("vendor");
        const addresses = (await c.query("SELECT id, chain_id, address, label FROM vendor_addresses WHERE vendor_id = $1 ORDER BY created_at", [v.id])).rows;
        const bills = (await c.query(`${BILL_SELECT} WHERE b.vendor_id = $1 ORDER BY b.bill_date DESC LIMIT 100`, [v.id])).rows as Row[];
        const expenses = (await c.query(`${EXPENSE_SELECT} WHERE x.vendor_id = $1 ORDER BY x.expense_date DESC LIMIT 100`, [v.id])).rows as Row[];
        const owed = bills.filter((b) => ["approved", "partially_paid"].includes(b.status)).reduce((s, b) => s + BigInt(b.amount) - BigInt(b.amount_paid), 0n);
        return {
          id: v.id,
          object: "vendor",
          name: v.name,
          email: v.email,
          external_ref: v.external_ref,
          notes: v.notes,
          default_account: v.default_account_id ? { id: v.default_account_id, code: v.account_code, name: v.account_name } : null,
          archived: v.archived_at !== null,
          owed: money(owed),
          wallet_addresses: addresses,
          bills: bills.map(serializeBill),
          expenses: expenses.map(serializeExpense),
          created_at: v.created_at
        };
      })
  });

  route(app, {
    method: "PATCH",
    url: "/v1/vendors/:id",
    summary: "Update a vendor",
    tags: ["vendors"],
    permission: "financials:write",
    params: idParam,
    body: updateVendorInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        const v = (await c.query("SELECT * FROM vendors WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0] as Row | undefined;
        if (!v) throw notFound("vendor");
        if (body.archived) {
          const open = (await c.query("SELECT 1 FROM bills WHERE vendor_id = $1 AND status IN ('draft','approved','partially_paid') LIMIT 1", [v.id])).rows[0];
          if (open) throw new EngineError("vendor_has_open_bills", "Pay or void this vendor's open bills before archiving it.", 409);
        }
        await c.query(
          `UPDATE vendors SET name = COALESCE($2, name), email = CASE WHEN $3 THEN $4 ELSE email END, default_account_id = CASE WHEN $5 THEN $6 ELSE default_account_id END,
             notes = CASE WHEN $7 THEN $8 ELSE notes END, archived_at = CASE WHEN $9::boolean IS NULL THEN archived_at WHEN $9 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`,
          [v.id, body.name ?? null, body.email !== undefined, body.email ?? null, body.default_account_id !== undefined, body.default_account_id ?? null, body.notes !== undefined, body.notes ?? null, body.archived ?? null]
        );
        await audit(c, actor, { organizationId, environment, action: "vendor_updated", objectType: "vendor", objectId: v.id, previous: { name: v.name }, next: body });
        return { id: v.id, object: "vendor" };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/vendors/:id/addresses",
    summary: "Link a wallet address to a vendor",
    tags: ["vendors"],
    permission: "financials:write",
    params: idParam,
    body: z.object({ address: z.string(), network: z.enum(["monad", "base", "local"]).default("monad"), label: z.string().max(80).optional() }),
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx((c) => addVendorAddress(c, organizationId, environment, params.id, body, actor))
  });
}
