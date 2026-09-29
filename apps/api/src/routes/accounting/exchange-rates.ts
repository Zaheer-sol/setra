import type { FastifyInstance } from "fastify";
import { listRates, setRate } from "@setra/engine";
import { fxRateInput } from "@setra/schemas";
import { route } from "../../lib/route";

/** Exchange rates for valuing assets without a peg to the reporting currency. */
export function exchangeRateRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/fx-rates",
    summary: "Exchange rates available to value non-USD amounts (yours and published)",
    tags: ["accounting"],
    permission: "financials:read",
    handler: ({ tx, organizationId }) => tx(async (c) => ({ data: await listRates(c, organizationId) }))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/fx-rates",
    summary: "Set an exchange rate for a date (e.g. MON in USD for network fees)",
    tags: ["accounting"],
    permission: "financials:manage",
    body: fxRateInput,
    handler: async ({ tx, body, organizationId, actor, reply }) => {
      const r = await tx((c) => setRate(c, organizationId, body, actor));
      reply.code(201);
      return r;
    }
  });
}
