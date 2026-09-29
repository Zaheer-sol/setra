import type { FastifyInstance } from "fastify";
import { approveBill, createBill, money, payBill, voidBill } from "@setra/engine";
import { accountingListQuery, createBillInput, payBillInput, reasonInput } from "@setra/schemas";
import { idParam, route } from "../../lib/route";
import { requirePermission } from "../../lib/principal";
import { serializeBill, BILL_SELECT, billDetail } from "../../lib/payables-presenters";

type Row = Record<string, any>;

/** Bills: record, approve, pay (onchain or offchain) and void. */
export function billRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/bills",
    summary: "Bills (payables)",
    tags: ["bills"],
    permission: "financials:read",
    query: accountingListQuery,
    handler: ({ tx, query, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment, query.limit + 1, query.offset];
        let where = "b.organization_id = $1 AND b.environment = $2";
        if (query.status === "open") where += " AND b.status IN ('approved','partially_paid')";
        else if (query.status === "overdue") where += " AND b.status IN ('approved','partially_paid') AND b.due_date < current_date";
        else if (query.status && query.status !== "all") {
          params.push(query.status);
          where += ` AND b.status = $${params.length}`;
        }
        if (query.vendor_id) {
          params.push(query.vendor_id);
          where += ` AND b.vendor_id = $${params.length}`;
        }
        if (query.search) {
          params.push(`%${query.search}%`);
          where += ` AND (b.number ILIKE $${params.length} OR b.title ILIKE $${params.length} OR v.name ILIKE $${params.length})`;
        }
        const rows = (await c.query(`${BILL_SELECT} WHERE ${where} ORDER BY b.bill_date DESC, b.id DESC LIMIT $3 OFFSET $4`, params)).rows as Row[];
        const totals = (await c.query<{ open: string; overdue: string; drafts: number }>(
          `SELECT COALESCE(sum(amount - amount_paid) FILTER (WHERE status IN ('approved','partially_paid')), 0)::text AS open,
                  COALESCE(sum(amount - amount_paid) FILTER (WHERE status IN ('approved','partially_paid') AND due_date < current_date), 0)::text AS overdue,
                  count(*) FILTER (WHERE status = 'draft')::int AS drafts
             FROM bills WHERE organization_id = $1 AND environment = $2`,
          [organizationId, environment]
        )).rows[0]!;
        return { object: "list", data: rows.slice(0, query.limit).map(serializeBill), has_more: rows.length > query.limit, summary: { open: money(BigInt(totals.open)), overdue: money(BigInt(totals.overdue)), awaiting_approval: totals.drafts } };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/bills",
    summary: "Record a bill from a vendor (draft, or approved with approval rights)",
    tags: ["bills"],
    permission: "financials:write",
    idempotent: true,
    body: createBillInput,
    handler: async ({ tx, body, principal, organizationId, environment, actor, reply }) => {
      if (body.approve) requirePermission(principal, "financials:approve", "Approving bills needs approval rights. Save it as a draft.");
      const b = await tx(async (c) => billDetail(c, organizationId, environment, (await createBill(c, organizationId, environment, body, actor)).id));
      reply.code(201);
      return b;
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/bills/:id",
    summary: "A bill with its payments and journal entries",
    tags: ["bills"],
    permission: "financials:read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment }) => tx((c) => billDetail(c, organizationId, environment, params.id))
  });

  route(app, {
    method: "POST",
    url: "/v1/bills/:id/approve",
    summary: "Approve a bill (it becomes a payable)",
    tags: ["bills"],
    permission: "financials:approve",
    params: idParam,
    handler: ({ tx, params, organizationId, environment, actor }) =>
      tx(async (c) => {
        await approveBill(c, organizationId, environment, params.id, actor);
        return billDetail(c, organizationId, environment, params.id);
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/bills/:id/pay",
    summary: "Record a payment of a bill (onchain transfer or off-chain account)",
    tags: ["bills"],
    permission: "financials:approve",
    idempotent: true,
    params: idParam,
    body: payBillInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        await payBill(c, organizationId, environment, params.id, body, actor);
        return billDetail(c, organizationId, environment, params.id);
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/bills/:id/void",
    summary: "Void a bill that has no payments",
    tags: ["bills"],
    permission: "financials:approve",
    params: idParam,
    body: reasonInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        await voidBill(c, organizationId, environment, params.id, body.reason, actor);
        return billDetail(c, organizationId, environment, params.id);
      })
  });
}
