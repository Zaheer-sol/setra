import type { FastifyInstance } from "fastify";
import { closeYear } from "@setra/engine";
import { yearParam } from "@setra/schemas";
import { route } from "../../lib/route";

/** Year-end close: move the year's result into Retained Earnings. */
export function yearEndRoutes(app: FastifyInstance) {
  route(app, {
    method: "POST",
    url: "/v1/accounting/years/:year/close",
    summary: "Close a year: move its result to Retained Earnings and close its months",
    tags: ["accounting"],
    permission: "financials:manage",
    params: yearParam,
    handler: ({ tx, params, organizationId, environment, actor }) => tx((c) => closeYear(c, organizationId, environment, params.year, actor))
  });
}
