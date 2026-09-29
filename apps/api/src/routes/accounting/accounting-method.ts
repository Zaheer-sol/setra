import type { FastifyInstance } from "fastify";
import { booksSettings, ensureBooks, setAccountingMethod } from "@setra/engine";
import { accountingSettingsInput } from "@setra/schemas";
import { route } from "../../lib/route";

/** Accounting method (cash or accrual) for each mode; it can only change before anything is posted. */
export function accountingMethodRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/settings",
    summary: "Accounting settings for this mode",
    tags: ["accounting"],
    permission: "financials:read",
    handler: ({ tx, organizationId, environment }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        const s = await booksSettings(c, organizationId, environment);
        const entries = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND environment = $2", [organizationId, environment])).rows[0]!.n;
        return { method: s.method, reporting_currency: s.reportingCurrency, method_locked: entries > 0, valuation: "Stablecoins are valued at their peg (1 USDC = 1 USD). Assets without a peg to the reporting currency have no valuation and are shown as such." };
      })
  });

  route(app, {
    method: "PATCH",
    url: "/v1/accounting/settings",
    summary: "Change the accounting method (only before anything is posted)",
    tags: ["accounting"],
    permission: "financials:manage",
    sessionOnly: true,
    body: accountingSettingsInput,
    handler: ({ tx, body, organizationId, environment, actor }) =>
      tx(async (c) => {
        await setAccountingMethod(c, organizationId, environment, body.method, actor);
        return { method: body.method };
      })
  });
}
