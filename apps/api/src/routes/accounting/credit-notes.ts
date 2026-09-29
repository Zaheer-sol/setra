import type { FastifyInstance } from "fastify";
import { createCreditNote, decimalsFor, amount as formatBase } from "@setra/engine";
import { creditNoteInput } from "@setra/schemas";
import { idParam, route } from "../../lib/route";

type Row = Record<string, any>;

/** Credit notes: lowering what a customer owes on an invoice. */
export function creditNoteRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/invoices/:id/credit-notes",
    summary: "Credit notes on an invoice",
    tags: ["invoices"],
    permission: "read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment }) =>
      tx(async (c) => {
        const rows = (await c.query("SELECT * FROM credit_notes WHERE invoice_id = $1 AND organization_id = $2 AND environment = $3 ORDER BY created_at", [params.id, organizationId, environment])).rows as Row[];
        const inv = (await c.query("SELECT asset_id FROM invoices WHERE id = $1", [params.id])).rows[0] as Row | undefined;
        const d = decimalsFor(inv?.asset_id);
        return { data: rows.map((n) => ({ id: n.id, number: n.number, amount: formatBase(BigInt(n.amount), d), reason: n.reason, by: n.actor_label, created_at: n.created_at })) };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/invoices/:id/credit-notes",
    summary: "Issue a credit note that lowers what the customer owes",
    tags: ["invoices"],
    permission: "invoices:write",
    idempotent: true,
    params: idParam,
    body: creditNoteInput,
    handler: async ({ tx, params, body, organizationId, environment, actor, reply }) => {
      const n = await tx((c) => createCreditNote(c, organizationId, environment, { invoice_id: params.id, ...body }, actor));
      reply.code(201);
      return { id: n.id, number: n.number };
    }
  });
}
