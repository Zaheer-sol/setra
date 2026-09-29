import type { FastifyInstance } from "fastify";
import { activeCreditApplications, applyCustomerCredit, availableCredit, decimalsFor, amount as formatBase, undoCustomerCredit } from "@setra/engine";
import { reasonInput, applyCreditInput } from "@setra/schemas";
import { notFound } from "../../lib/errors";
import { idParam, route } from "../../lib/route";

type Row = Record<string, any>;

/** Customer credits: overpayments kept as credit and applied to later invoices. */
export function customerCreditRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/payments/:id/credit",
    summary: "Unused overpayment on a payment, and where its credit was applied",
    tags: ["payments"],
    permission: "read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment }) =>
      tx(async (c) => {
        const p = (await c.query("SELECT * FROM payments WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0] as Row | undefined;
        if (!p) throw notFound("payment");
        const { invoice, amount } = await availableCredit(c, p);
        const d = decimalsFor(p.asset_id);
        const open = invoice
          ? ((await c.query("SELECT id, number, title, amount_due, amount_paid, amount_written_off FROM invoices WHERE customer_id = $1 AND asset_id = $2 AND id <> $3 AND status IN ('open','partially_paid','expired') ORDER BY created_at", [invoice.customer_id, invoice.asset_id, invoice.id])).rows as Row[])
          : [];
        return {
          available: formatBase(amount, d),
          from_invoice: invoice ? { id: invoice.id, number: invoice.number } : null,
          applications: (await activeCreditApplications(c, p.id)).map((a) => ({ id: a.id, invoice: { id: a.to_invoice_id, number: a.to_number }, amount: formatBase(BigInt(a.amount), d), by: a.actor_label, created_at: a.created_at })),
          eligible_invoices: open.map((i) => ({ id: i.id, number: i.number, title: i.title, owed: formatBase(BigInt(i.amount_due) - BigInt(i.amount_paid) - BigInt(i.amount_written_off), d) }))
        };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/payments/:id/apply-credit",
    summary: "Apply a payment's unused overpayment to another open invoice of the same customer",
    tags: ["payments"],
    permission: "exceptions:resolve",
    idempotent: true,
    params: idParam,
    body: applyCreditInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        const a = await applyCustomerCredit(c, organizationId, environment, { payment_id: params.id, invoice_id: body.invoice_id, amount: body.amount, reason: body.reason }, actor);
        return { id: a.id, amount: formatBase(BigInt(a.amount), decimalsFor(a.asset_id)) };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/credit-applications/:id/undo",
    summary: "Undo a customer credit application",
    tags: ["payments"],
    permission: "exceptions:resolve",
    params: idParam,
    body: reasonInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx(async (c) => (await undoCustomerCredit(c, organizationId, environment, params.id, body.reason, actor), { ok: true }))
  });
}
