import type { FastifyInstance } from "fastify";
import { closePeriod, ensureBooks, reopenPeriod } from "@setra/engine";
import { periodInput, reopenPeriodInput } from "@setra/schemas";
import { route } from "../../lib/route";
import { today } from "../../lib/dates";

type Row = Record<string, any>;

/** Accounting periods: which months have activity, and closing or reopening a month. */
export function periodRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/periods",
    summary: "Accounting periods (closed months and months with activity)",
    tags: ["accounting"],
    permission: "financials:read",
    handler: ({ tx, organizationId, environment }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const rows = (
          await c.query(
            `WITH months AS (
               SELECT DISTINCT date_trunc('month', entry_date)::date AS m FROM journal_entries WHERE organization_id = $1 AND environment = $2
               UNION SELECT date_trunc('month', now())::date
               UNION SELECT start_date FROM accounting_periods WHERE organization_id = $1 AND environment = $2)
             SELECT to_char(m.m, 'YYYY-MM') AS month, m.m AS start_date, (m.m + interval '1 month - 1 day')::date AS end_date,
                    p.status, p.closed_at, p.closed_by_label, p.reopened_at, p.reopen_reason,
                    (SELECT count(*)::int FROM journal_entries e WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'posted' AND date_trunc('month', e.entry_date) = m.m) AS posted,
                    (SELECT count(*)::int FROM journal_entries e WHERE e.organization_id = $1 AND e.environment = $2 AND e.status IN ('draft','approved') AND date_trunc('month', e.entry_date) = m.m) AS drafts
               FROM months m LEFT JOIN accounting_periods p ON p.organization_id = $1 AND p.environment = $2 AND p.start_date = m.m
              ORDER BY m.m DESC`,
            [organizationId, environment]
          )
        ).rows as Row[];
        return {
          data: rows.map((r) => ({
            month: r.month,
            start_date: r.start_date,
            end_date: r.end_date,
            status: r.status ?? "open",
            ended: r.end_date < today(),
            closed_at: r.closed_at,
            closed_by: r.closed_by_label,
            reopened_at: r.reopened_at,
            reopen_reason: r.reopen_reason,
            posted_entries: r.posted,
            draft_entries: r.drafts
          }))
        };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/periods/close",
    summary: "Close a month so nothing more can be posted into it",
    tags: ["accounting"],
    permission: "financials:manage",
    sessionOnly: true,
    body: periodInput,
    handler: ({ tx, body, organizationId, environment, actor }) => tx((c) => closePeriod(c, organizationId, environment, body.month, actor))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/periods/reopen",
    summary: "Reopen a closed month for a controlled adjustment",
    tags: ["accounting"],
    permission: "financials:manage",
    sessionOnly: true,
    body: reopenPeriodInput,
    handler: ({ tx, body, organizationId, environment, actor }) => tx((c) => reopenPeriod(c, organizationId, environment, body.month, body.reason, actor))
  });
}
