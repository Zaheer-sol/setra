import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  autoMatchStatement,
  completeReconciliation,
  createEntryForStatementLine,
  excludeStatementLine,
  importStatement,
  matchStatementLine,
  reconciliationStatus,
  statementLines,
  unmatchStatementLine
} from "@setra/engine";
import {
  reasonInput,
  bankCreateEntryInput,
  bankImportInput,
  bankLinesQuery,
  bankMatchInput,
  bankReconcileInput,
  bankReconcileQuery
} from "@setra/schemas";
import { idParam, route } from "../../lib/route";

const accountParam = z.object({ account_id: z.string().min(3).max(64) });

/** Bank reconciliation: import statements, match lines to the books, and reconcile. */
export function bankReconciliationRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/bank/:account_id/lines",
    summary: "Imported statement lines, with match suggestions",
    tags: ["accounting"],
    permission: "financials:read",
    params: accountParam,
    query: bankLinesQuery,
    handler: ({ tx, params, query, organizationId, environment }) => tx(async (c) => ({ data: await statementLines(c, organizationId, environment, params.account_id, { status: query.status }) }))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/bank/:account_id/import",
    summary: "Import a bank statement (CSV). Re-importing never duplicates lines",
    tags: ["accounting"],
    permission: "financials:write",
    params: accountParam,
    body: bankImportInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx((c) => importStatement(c, organizationId, environment, { ...body, account_id: params.account_id }, actor))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/bank/:account_id/auto-match",
    summary: "Match statement lines that have exactly one ledger candidate",
    tags: ["accounting"],
    permission: "financials:write",
    params: accountParam,
    handler: ({ tx, params, organizationId, environment, actor }) => tx((c) => autoMatchStatement(c, organizationId, environment, params.account_id, actor))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/bank/lines/:id/match",
    summary: "Match a statement line to a ledger line",
    tags: ["accounting"],
    permission: "financials:write",
    params: idParam,
    body: bankMatchInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx(async (c) => (await matchStatementLine(c, organizationId, environment, params.id, body.journal_line_id, actor), { ok: true }))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/bank/lines/:id/create-entry",
    summary: "Post the entry the ledger is missing for a statement line (fee, interest…) and match it",
    tags: ["accounting"],
    permission: "financials:approve",
    params: idParam,
    body: bankCreateEntryInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx(async (c) => ({ journal_entry_id: (await createEntryForStatementLine(c, organizationId, environment, params.id, body, actor)).id }))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/bank/lines/:id/exclude",
    summary: "Exclude a statement line from reconciliation (with a reason)",
    tags: ["accounting"],
    permission: "financials:write",
    params: idParam,
    body: reasonInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx(async (c) => (await excludeStatementLine(c, organizationId, environment, params.id, body.reason, actor), { ok: true }))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/bank/lines/:id/unmatch",
    summary: "Undo a match or exclusion (not for reconciled lines)",
    tags: ["accounting"],
    permission: "financials:write",
    params: idParam,
    handler: ({ tx, params, organizationId, environment, actor }) => tx(async (c) => (await unmatchStatementLine(c, organizationId, environment, params.id, actor), { ok: true }))
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/bank/:account_id/reconciliation",
    summary: "Reconciliation status on a statement date",
    tags: ["accounting"],
    permission: "financials:read",
    params: accountParam,
    query: bankReconcileQuery,
    handler: ({ tx, params, query, organizationId, environment }) => tx((c) => reconciliationStatus(c, organizationId, environment, params.account_id, query.date, query.statement_balance))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/bank/:account_id/reconciliation",
    summary: "Complete a reconciliation (ledger less uncleared items equals the statement balance)",
    tags: ["accounting"],
    permission: "financials:approve",
    params: accountParam,
    body: bankReconcileInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx((c) => completeReconciliation(c, organizationId, environment, params.account_id, body.statement_date, body.statement_balance, actor))
  });
}
