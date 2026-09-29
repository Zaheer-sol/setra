import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  approveManualEntry,
  createManualEntry,
  ensureBooks,
  ledgerAmount,
  postManualEntry,
  reverseEntry,
  updateManualEntry,
  voidManualEntry,
  type LineInput
} from "@setra/engine";
import { createJournalEntryInput, journalListQuery, reverseJournalEntryInput, updateJournalEntryInput, voidJournalEntryInput } from "@setra/schemas";
import { idParam, route } from "../../lib/route";
import { requirePermission } from "../../lib/principal";
import { serializeEntryRow, journalEntryDetail } from "../../lib/journal-presenters";

type Row = Record<string, any>;

function toLines(lines: z.infer<typeof createJournalEntryInput>["lines"]): LineInput[] {
  return lines.map((l) => ({
    accountId: l.account_id,
    debit: l.debit ? ledgerAmount(l.debit, "Debit") : undefined,
    credit: l.credit ? ledgerAmount(l.credit, "Credit") : undefined,
    memo: l.memo ?? null,
    customerId: l.customer_id ?? null,
    vendorId: l.vendor_id ?? null
  }));
}

/** Manual journal entries: draft, approve, post, void and reverse. */
export function journalEntryRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/journal-entries",
    summary: "Journal entries (newest first)",
    tags: ["accounting"],
    permission: "financials:read",
    query: journalListQuery,
    handler: ({ tx, query, organizationId, environment }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const params: unknown[] = [organizationId, environment];
        let where = "e.organization_id = $1 AND e.environment = $2";
        const add = (sql: string, v: unknown) => {
          params.push(v);
          where += ` AND ${sql.replaceAll("?", `$${params.length}`)}`;
        };
        if (query.status) add("e.status = ?", query.status);
        if (query.source_type) add(query.source_type === "manual" ? "e.source_type IN ('manual','reversal') AND e.created_by_id IS NOT NULL AND ? = 'manual'" : "e.source_type = ?", query.source_type);
        if (query.from) add("e.entry_date >= ?::date", query.from);
        if (query.to) add("e.entry_date <= ?::date", query.to);
        if (query.search) add("(e.description ILIKE ? OR e.number ILIKE ? OR e.memo ILIKE ?)", `%${query.search}%`);
        params.push(query.limit + 1, query.offset);
        const rows = (
          await c.query(
            `SELECT e.*, (SELECT sum(debit)::text FROM journal_lines l WHERE l.entry_id = e.id) AS total FROM journal_entries e WHERE ${where}
              ORDER BY e.entry_date DESC, e.number DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
          )
        ).rows as Row[];
        return { object: "list", data: rows.slice(0, query.limit).map(serializeEntryRow), has_more: rows.length > query.limit };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/journal-entries",
    summary: "Create a manual journal entry (draft, or posted with approval rights)",
    tags: ["accounting"],
    permission: "financials:write",
    idempotent: true,
    body: createJournalEntryInput,
    handler: async ({ tx, body, principal, organizationId, environment, actor, reply }) => {
      if (body.post) requirePermission(principal, "financials:approve", "Posting needs approval rights. Save it as a draft for an admin to post.");
      const e = await tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const entry = await createManualEntry(c, { organizationId, environment, date: body.date, description: body.description, memo: body.memo ?? null, lines: toLines(body.lines), actor, post: body.post });
        return journalEntryDetail(c, organizationId, environment, entry.id);
      });
      reply.code(201);
      return e;
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/journal-entries/:id",
    summary: "A journal entry with its lines, source and history",
    tags: ["accounting"],
    permission: "financials:read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment }) => tx((c) => journalEntryDetail(c, organizationId, environment, params.id))
  });

  route(app, {
    method: "PATCH",
    url: "/v1/accounting/journal-entries/:id",
    summary: "Edit a draft journal entry",
    tags: ["accounting"],
    permission: "financials:write",
    params: idParam,
    body: updateJournalEntryInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        await updateManualEntry(c, organizationId, environment, params.id, { date: body.date, description: body.description, memo: body.memo, lines: body.lines ? toLines(body.lines) : undefined }, actor);
        return journalEntryDetail(c, organizationId, environment, params.id);
      })
  });

  for (const [action, permission, summary] of [
    ["approve", "financials:approve", "Approve a draft journal entry"],
    ["post", "financials:approve", "Post a journal entry to the ledger"]
  ] as const) {
    route(app, {
      method: "POST",
      url: `/v1/accounting/journal-entries/:id/${action}`,
      summary,
      tags: ["accounting"],
      permission,
      params: idParam,
      handler: ({ tx, params, organizationId, environment, actor }) =>
        tx(async (c) => {
          if (action === "approve") await approveManualEntry(c, organizationId, environment, params.id, actor);
          else await postManualEntry(c, organizationId, environment, params.id, actor);
          return journalEntryDetail(c, organizationId, environment, params.id);
        })
    });
  }

  route(app, {
    method: "POST",
    url: "/v1/accounting/journal-entries/:id/void",
    summary: "Discard a draft journal entry",
    tags: ["accounting"],
    permission: "financials:write",
    params: idParam,
    body: voidJournalEntryInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        await voidManualEntry(c, organizationId, environment, params.id, body.reason, actor);
        return journalEntryDetail(c, organizationId, environment, params.id);
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/journal-entries/:id/reverse",
    summary: "Reverse a posted journal entry with a new, opposite entry",
    tags: ["accounting"],
    permission: "financials:approve",
    params: idParam,
    body: reverseJournalEntryInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        const { entry } = await reverseEntry(c, organizationId, environment, params.id, { reason: body.reason, actor, date: body.date });
        return journalEntryDetail(c, organizationId, environment, entry.id);
      })
  });
}
