import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { approveExpense, createExpense, money, rejectExpense } from "@setra/engine";
import { accountingListQuery, createExpenseInput, reasonInput } from "@setra/schemas";
import { notFound } from "../../lib/errors";
import { idParam, route } from "../../lib/route";
import { requirePermission } from "../../lib/principal";
import { serializeEntryRow } from "../../lib/journal-presenters";
import { serializeExpense, EXPENSE_SELECT } from "../../lib/payables-presenters";

type Row = Record<string, any>;

/** Expenses: record, approve or reject. */
export function expenseRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/expenses",
    summary: "Expenses",
    tags: ["expenses"],
    permission: "financials:read",
    query: accountingListQuery,
    handler: ({ tx, query, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment, query.limit + 1, query.offset];
        let where = "x.organization_id = $1 AND x.environment = $2";
        if (query.status && query.status !== "all") {
          params.push(query.status);
          where += ` AND x.status = $${params.length}`;
        }
        if (query.vendor_id) {
          params.push(query.vendor_id);
          where += ` AND x.vendor_id = $${params.length}`;
        }
        if (query.search) {
          params.push(`%${query.search}%`);
          where += ` AND (x.title ILIKE $${params.length} OR v.name ILIKE $${params.length})`;
        }
        const rows = (await c.query(`${EXPENSE_SELECT} WHERE ${where} ORDER BY x.expense_date DESC, x.id DESC LIMIT $3 OFFSET $4`, params)).rows as Row[];
        const s = (await c.query<{ month: string; pending: number }>(
          `SELECT COALESCE(sum(amount) FILTER (WHERE status = 'approved' AND expense_date >= date_trunc('month', now())::date), 0)::text AS month, count(*) FILTER (WHERE status = 'pending')::int AS pending
             FROM expenses WHERE organization_id = $1 AND environment = $2`,
          [organizationId, environment]
        )).rows[0]!;
        return { object: "list", data: rows.slice(0, query.limit).map(serializeExpense), has_more: rows.length > query.limit, summary: { this_month: money(BigInt(s.month)), awaiting_approval: s.pending } };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/expenses",
    summary: "Record an expense (pending, or approved with approval rights)",
    tags: ["expenses"],
    permission: "financials:write",
    idempotent: true,
    body: createExpenseInput,
    handler: async ({ tx, body, principal, organizationId, environment, actor, reply }) => {
      if (body.approve) requirePermission(principal, "financials:approve", "Approving expenses needs approval rights. Save it for approval.");
      const x = await tx(async (c) => {
        const created = await createExpense(c, organizationId, environment, body, actor);
        return (await c.query(`${EXPENSE_SELECT} WHERE x.id = $1`, [created.id])).rows[0] as Row;
      });
      reply.code(201);
      return serializeExpense(x);
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/expenses/:id",
    summary: "An expense with its journal entry",
    tags: ["expenses"],
    permission: "financials:read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment }) =>
      tx(async (c) => {
        const x = (await c.query(`${EXPENSE_SELECT} WHERE x.id = $1 AND x.organization_id = $2 AND x.environment = $3`, [params.id, organizationId, environment])).rows[0] as Row | undefined;
        if (!x) throw notFound("expense");
        const entries = (await c.query("SELECT * FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_id = $3 ORDER BY number", [organizationId, environment, x.id])).rows as Row[];
        return { ...serializeExpense(x), journal_entries: entries.map(serializeEntryRow) };
      })
  });

  for (const action of ["approve", "reject"] as const) {
    route(app, {
      method: "POST",
      url: `/v1/expenses/:id/${action}`,
      summary: action === "approve" ? "Approve an expense (posts it)" : "Reject a pending expense",
      tags: ["expenses"],
      permission: "financials:approve",
      params: idParam,
      body: action === "reject" ? reasonInput : z.object({}).optional(),
      handler: ({ tx, params, body, organizationId, environment, actor }) =>
        tx(async (c) => {
          if (action === "approve") await approveExpense(c, organizationId, environment, params.id, actor);
          else await rejectExpense(c, organizationId, environment, params.id, (body as { reason: string }).reason, actor);
          return serializeExpense((await c.query(`${EXPENSE_SELECT} WHERE x.id = $1`, [params.id])).rows[0] as Row);
        })
    });
  }
}
