import type { FastifyInstance } from "fastify";
import { ensureBooks, chartExport, journalExport } from "@setra/engine";
import { chartExportQuery, journalExportQuery } from "@setra/schemas";
import { exportOwner, sendDataCsv } from "../../lib/report-file";
import { route } from "../../lib/route";

/** "setra-journal-xero-2026-09-01-to-2026-09-30.csv" → "journal-xero-2026-09-01-to-2026-09-30", to be prefixed with the business. */
const importName = (engineFilename: string) => engineFilename.replace(/^setra-/, "").replace(/\.csv$/, "");

/** Exports for accountants and other accounting systems (QuickBooks, Xero). */
export function accountantExportRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/exports/journal",
    summary: "Posted journal as CSV, in QuickBooks Online, Xero or Setra layout",
    tags: ["accounting"],
    permission: "financials:read",
    query: journalExportQuery,
    handler: ({ tx, query, organizationId, environment, reply, actor }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const e = await journalExport(c, organizationId, environment, { format: query.format, from: query.from, to: query.to, dateFormat: query.date_format, taxRate: query.tax_rate, includeClosing: query.include_closing });
        reply.header("x-setra-entries", String(e.entries));
        // Import layouts stay exactly as QuickBooks and Xero expect; the filename says whose books they are.
        return sendDataCsv(reply, await exportOwner(c, organizationId, environment, actor), importName(e.filename), e.headers, e.rows);
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/exports/chart",
    summary: "Chart of accounts as CSV, in QuickBooks Online, Xero or Setra layout",
    tags: ["accounting"],
    permission: "financials:read",
    query: chartExportQuery,
    handler: ({ tx, query, organizationId, environment, reply, actor }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const e = await chartExport(c, organizationId, environment, query.format, query.tax_rate);
        return sendDataCsv(reply, await exportOwner(c, organizationId, environment, actor), importName(e.filename), e.headers, e.rows);
      })
  });
}
