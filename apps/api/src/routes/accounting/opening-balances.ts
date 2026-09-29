import type { FastifyInstance } from "fastify";
import { ensureBooks, openingBalances, setOpeningBalances } from "@setra/engine";
import { openingBalancesInput } from "@setra/schemas";
import { route } from "../../lib/route";

/** Opening balances for books that start partway through a business's life. */
export function openingBalanceRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/opening-balances",
    summary: "The current opening balances",
    tags: ["accounting"],
    permission: "financials:read",
    handler: ({ tx, organizationId, environment }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        return openingBalances(c, organizationId, environment);
      })
  });

  route(app, {
    method: "PUT",
    url: "/v1/accounting/opening-balances",
    summary: "Set (or replace) opening balances, balanced against Opening Balance Equity",
    tags: ["accounting"],
    permission: "financials:manage",
    body: openingBalancesInput,
    handler: ({ tx, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        await setOpeningBalances(c, organizationId, environment, body, actor);
        return openingBalances(c, organizationId, environment);
      })
  });
}
