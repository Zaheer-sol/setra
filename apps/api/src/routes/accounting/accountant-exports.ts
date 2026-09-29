import type { FastifyInstance } from "fastify";
import { ensureBooks, chartExport, journalExport } from "@setra/engine";
import { chartExportQuery, journalExportQuery } from "@setra/schemas";
import { toCsv } from "../../lib/csv";
import { route } from "../../lib/route";

/** Exports for accountants and other accounting systems (QuickBooks, Xero). */
export function accountantExportRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/exports/journal",
    summary: "Posted journal as CSV, in QuickBooks Online, Xero or Setra layout",
    tags: ["accounting"],
    permission: "financials:read",
    query: journalExportQuery,
    handler: ({ tx, query, organizationId, environment, reply }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const e = await journalExport(c, organizationId, environment, { format: query.format, from: query.from, to: query.to, dateFormat: query.date_format, taxRate: query.tax_rate, includeClosing: query.include_closing });
        reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${e.filename}"`).header("x-setra-entries", String(e.entries));
        return toCsv(e.headers, e.rows);
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/exports/chart",
    summary: "Chart of accounts as CSV, in QuickBooks Online, Xero or Setra layout",
    tags: ["accounting"],
    permission: "financials:read",
    query: chartExportQuery,
    handler: ({ tx, query, organizationId, environment, reply }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const e = await chartExport(c, organizationId, environment, query.format, query.tax_rate);
        reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${e.filename}"`);
        return toCsv(e.headers, e.rows);
      })
  });
}
