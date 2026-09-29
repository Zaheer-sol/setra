import type { FastifyInstance } from "fastify";
import { booksHealth, repairBooks } from "@setra/engine";
import { route } from "../../lib/route";

/** Books health: do the books agree with invoices, bills, wallets and onchain activity, and repair anything missing. */
export function booksHealthRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/health",
    summary: "Do the books agree with invoices, bills, wallets and onchain activity?",
    tags: ["accounting"],
    permission: "financials:read",
    handler: ({ tx, organizationId, environment }) => tx((c) => booksHealth(c, organizationId, environment))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/repair",
    summary: "Retry failed automatic postings and post anything missing (idempotent)",
    tags: ["accounting"],
    permission: "financials:manage",
    handler: ({ tx, organizationId, environment, actor }) => tx((c) => repairBooks(c, organizationId, environment, actor))
  });
}
