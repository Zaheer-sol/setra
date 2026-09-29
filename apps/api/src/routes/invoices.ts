import type { FastifyInstance } from "fastify";
import { appEnv, networks } from "@setra/config";
import type { Client } from "@setra/database";
import { amount, audit, cancelInvoice, createInvoice, decimalsFor, serializeException, serializeInvoice, serializePayment, serializePaymentIntent } from "@setra/engine";
import { cancelInvoiceInput, createInvoiceInput, invoiceListQuery, sendInvoiceInput } from "@setra/schemas";
import { withGlobal } from "@setra/database";
import { ApiError } from "../lib/errors";
import { sendEmail } from "../lib/email";
import { notFound } from "../lib/errors";
import { cursorClause, page } from "../lib/pagination";
import { idParam, route } from "../lib/route";

type Row = Record<string, any>;

const INVOICE_SELECT = `SELECT i.*, w.address AS wallet_address, c.name AS customer_name, c.email AS customer_email FROM invoices i
  JOIN wallets w ON w.id = i.wallet_id JOIN customers c ON c.id = i.customer_id`;

export async function presentInvoices(client: Client, rows: Row[]) {
  const ids = rows.map((r) => r.id);
  const confirming = ids.length
    ? (await client.query<{ invoice_id: string; total: string }>(
        "SELECT provisional_invoice_id AS invoice_id, SUM(amount)::text AS total FROM payments WHERE provisional_invoice_id = ANY($1) AND status = 'confirming' GROUP BY 1",
        [ids]
      )).rows
    : [];
  const lineItems = ids.length ? (await client.query("SELECT * FROM invoice_line_items WHERE invoice_id = ANY($1) ORDER BY invoice_id, position", [ids])).rows : [];
  const publicUrl = appEnv().publicAppUrl;
  return (row: Row) =>
    serializeInvoice(row, publicUrl, {
      customer: { id: row.customer_id, name: row.customer_name, email: row.customer_email },
      confirmingAmount: confirming.find((x) => x.invoice_id === row.id)?.total ?? null,
      lineItems: lineItems.filter((li) => li.invoice_id === row.id)
    });
}

export function invoiceRoutes(app: FastifyInstance) {
  const load = async (c: Client, id: string, organizationId: string, environment: string) => {
    const row = (await c.query(`${INVOICE_SELECT} WHERE i.id = $1 AND i.organization_id = $2 AND i.environment = $3`, [id, organizationId, environment])).rows[0];
    if (!row) throw notFound("invoice");
    return row;
  };

  route(app, {
    method: "POST",
    url: "/v1/invoices",
    summary: "Create an invoice (payment request)",
    tags: ["invoices"],
    permission: "invoices:write",
    idempotent: true,
    body: createInvoiceInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) => {
      reply.code(201);
      return tx(async (c) => {
        const created = await createInvoice(c, organizationId, environment, body, actor);
        const row = await load(c, created.id, organizationId, environment);
        return (await presentInvoices(c, [row]))(row);
      });
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/invoices",
    summary: "List invoices",
    tags: ["invoices"],
    permission: "read",
    query: invoiceListQuery,
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment];
        let where = "i.organization_id = $1 AND i.environment = $2";
        const add = (sql: string, value: unknown) => {
          params.push(value);
          where += ` AND ${sql.replaceAll("?", `$${params.length}`)}`;
        };
        if (query.status) add("i.status = ?", query.status);
        if (query.state) where += query.state === "overdue" ? " AND i.status IN ('open','partially_paid') AND i.due_at < now()" : " AND i.status IN ('open','partially_paid')";
        if (query.customer_id) add("i.customer_id = ?", query.customer_id);
        if (query.created_gte) add("i.created_at >= ?", query.created_gte);
        if (query.created_lte) add("i.created_at <= ?", query.created_lte);
        if (query.search) add("(i.number ILIKE ? OR i.title ILIKE ? OR i.purpose ILIKE ? OR c.name ILIKE ?)", `%${query.search.replace(/[%_\\]/g, "\\$&")}%`);
        where += cursorClause(params, query.starting_after, "i.id");
        params.push(query.limit + 1);
        const rows = (await c.query(`${INVOICE_SELECT} WHERE ${where} ORDER BY i.id DESC LIMIT $${params.length}`, params)).rows;
        return page(rows, query.limit, await presentInvoices(c, rows));
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/invoices/:id",
    summary: "Retrieve an invoice with its payments, exceptions and history",
    tags: ["invoices"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const row = await load(c, params.id, organizationId, environment);
        const invoice = (await presentInvoices(c, [row]))(row);
        const d = decimalsFor(row.asset_id);
        const allocations = (
          await c.query(
            `SELECT a.id, a.amount, a.kind, a.created_at, a.payment_id, a.reverses_allocation_id, p.status AS payment_status, p.transaction_hash, p.from_address, p.block_timestamp, p.source
               FROM allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = $1 ORDER BY a.created_at`,
            [row.id]
          )
        ).rows;
        const payments = (await c.query("SELECT * FROM payments WHERE invoice_id = $1 OR (provisional_invoice_id = $1 AND status = 'confirming') ORDER BY id DESC", [row.id])).rows;
        const exceptions = (await c.query("SELECT * FROM exceptions WHERE invoice_id = $1 ORDER BY id DESC", [row.id])).rows;
        const intents = (await c.query("SELECT * FROM payment_intents WHERE invoice_id = $1 ORDER BY id DESC", [row.id])).rows;
        const events = (await c.query("SELECT id, type, created_at, payment_id, resolution_id FROM financial_events WHERE invoice_id = $1 ORDER BY id", [row.id])).rows;
        const auditRows = (await c.query("SELECT action, actor_type, actor_label, created_at, new_state FROM audit_logs WHERE object_type = 'invoice' AND object_id = $1 ORDER BY id", [row.id])).rows;
        return {
          ...invoice,
          payments: payments.map((p) => serializePayment(p, { invoice: row })),
          allocations: allocations.map((a) => ({
            id: a.id,
            payment_id: a.payment_id,
            amount: amount(a.amount, d),
            kind: a.kind,
            reverses_allocation_id: a.reverses_allocation_id,
            payment_status: a.payment_status,
            transaction_hash: a.transaction_hash,
            sender: a.from_address,
            simulated: a.source === "simulated",
            paid_at: a.block_timestamp,
            created_at: a.created_at
          })),
          exceptions: exceptions.map((e) => serializeException(e)),
          payment_intents: intents.map(serializePaymentIntent),
          timeline: [
            ...auditRows.map((a) => ({ kind: "audit", action: a.action, actor: a.actor_label ?? a.actor_type, at: a.created_at, detail: a.new_state })),
            ...events.map((e) => ({ kind: "event", action: e.type, event_id: e.id, payment_id: e.payment_id, at: e.created_at }))
          ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/invoices/:id/send",
    summary: "Email the payment request to the customer",
    tags: ["invoices"],
    permission: "invoices:write",
    params: idParam,
    body: sendInvoiceInput,
    handler: async ({ params, body, tx, organizationId, environment, actor, request }) =>
      tx(async (c) => {
        const row = await load(c, params.id, organizationId, environment);
        if (!["open", "partially_paid"].includes(row.status)) throw new ApiError(409, "invoice_not_payable", "Only an open invoice can be sent for payment.");
        const to = body?.to ?? row.customer_email;
        if (!to) throw new ApiError(422, "recipient_required", "This customer has no email address. Enter one to send the payment request.");
        const env = appEnv();
        if (env.isProduction && !env.SMTP_URL) throw new ApiError(422, "email_not_configured", "Email isn't configured on this deployment (SMTP_URL). Copy the payment link instead.");
        const org = (await withGlobal((g) => g.query("SELECT name FROM organizations WHERE id = $1", [organizationId]))).rows[0];
        const invoice = (await presentInvoices(c, [row]))(row);
        const network = networks().byChainId(Number(row.chain_id));
        const lines = [
          `${org.name} has sent you a payment request.`,
          "",
          `For: ${invoice.title ?? `Invoice ${invoice.number}`}`,
          ...(invoice.purpose ? [invoice.purpose] : []),
          ...(invoice.line_items.length ? ["", ...invoice.line_items.map((li: any) => `  ${li.description}${li.quantity > 1 ? ` × ${li.quantity}` : ""}: $${li.amount}`)] : []),
          "",
          `Amount due: $${invoice.amount_remaining} (${invoice.asset?.symbol} on ${network?.name ?? "Monad"})`,
          ...(invoice.due_at ? [`Due: ${new Date(invoice.due_at).toDateString()}`] : []),
          ...(body?.message ? ["", body.message] : []),
          "",
          `Pay here: ${invoice.payment_url}`,
          "",
          `Invoice ${invoice.number}. Payments go directly to ${org.name}'s wallet.`
        ];
        const result = await sendEmail({ to, subject: `Payment request from ${org.name}: ${invoice.title ?? invoice.number}`, text: lines.join("\n") }, request.log);
        await c.query("UPDATE invoices SET last_sent_at = now(), last_sent_to = $1, updated_at = now() WHERE id = $2", [to, row.id]);
        await audit(c, actor, { organizationId, environment, action: "invoice_sent", objectType: "invoice", objectId: row.id, next: { to, delivered: result.delivered } });
        return {
          sent: true,
          to,
          delivered: result.delivered,
          note: result.delivered ? null : "Email isn't configured in this environment. The message was written to the API log instead."
        };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/invoices/:id/cancel",
    summary: "Cancel an open invoice",
    tags: ["invoices"],
    permission: "invoices:write",
    params: idParam,
    body: cancelInvoiceInput,
    handler: async ({ params, body, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        await load(c, params.id, organizationId, environment);
        await cancelInvoice(c, organizationId, params.id, body?.reason, actor);
        const row = await load(c, params.id, organizationId, environment);
        return (await presentInvoices(c, [row]))(row);
      })
  });
}
