import type { FastifyInstance } from "fastify";
import { accountBalances, createLedgerAccount, ensureBooks, money, seedChart, updateLedgerAccount } from "@setra/engine";
import { createLedgerAccountInput, ledgerAccountListQuery, updateLedgerAccountInput } from "@setra/schemas";
import { notFound } from "../../lib/errors";
import { idParam, route } from "../../lib/route";

type Row = Record<string, any>;

/** The chart of accounts: list, create, rename and archive ledger accounts. */
export function ledgerAccountRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/accounts",
    summary: "Chart of accounts with balances",
    tags: ["accounting"],
    permission: "financials:read",
    query: ledgerAccountListQuery,
    handler: ({ tx, query, organizationId, environment }) =>
      tx(async (c) => {
        await ensureBooks(c, organizationId, environment);
        // Workspaces set up before an account joined the standard chart get it here (never duplicated).
        await seedChart(c, organizationId, environment);
        const balances = await accountBalances(c, organizationId, environment, { to: query.as_of ?? null });
        const meta = new Map(((await c.query("SELECT id, description, archived_at, system_key, wallet_id, asset_id FROM ledger_accounts WHERE organization_id = $1 AND environment = $2", [organizationId, environment])).rows as Row[]).map((r) => [r.id, r]));
        return {
          data: balances
            .filter((a) => query.include_archived || !meta.get(a.id)?.archived_at)
            .map((a) => ({
              id: a.id,
              object: "ledger_account",
              code: a.code,
              name: a.name,
              type: a.type,
              subtype: a.subtype,
              normal_balance: a.normal_balance,
              system: a.system_key !== null,
              system_key: a.system_key,
              wallet_id: a.wallet_id,
              description: meta.get(a.id)?.description ?? null,
              archived: !!meta.get(a.id)?.archived_at,
              balance: money(a.balance),
              debits: money(a.debits),
              credits: money(a.credits)
            }))
        };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/accounts",
    summary: "Add an account to the chart",
    tags: ["accounting"],
    permission: "financials:manage",
    idempotent: true,
    body: createLedgerAccountInput,
    handler: async ({ tx, body, organizationId, environment, actor, reply }) => {
      const a = await tx((c) => createLedgerAccount(c, organizationId, environment, body, actor));
      reply.code(201);
      return { id: a.id, object: "ledger_account", code: a.code, name: a.name, type: a.type, subtype: a.subtype, normal_balance: a.normal_balance, description: a.description };
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/accounting/accounts/:id",
    summary: "An account with its balance",
    tags: ["accounting"],
    permission: "financials:read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment }) =>
      tx(async (c) => {
        const a = (await c.query("SELECT * FROM ledger_accounts WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0] as Row | undefined;
        if (!a) throw notFound("account");
        const bal = (await accountBalances(c, organizationId, environment)).find((b) => b.id === a.id)!;
        const monthly = (
          await c.query(
            `SELECT to_char(date_trunc('month', e.entry_date), 'YYYY-MM') AS month, sum(l.debit)::text AS d, sum(l.credit)::text AS c
               FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.status = 'posted'
              GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
            [a.id]
          )
        ).rows as Row[];
        const sign = a.normal_balance === "debit" ? 1n : -1n;
        return {
          id: a.id,
          object: "ledger_account",
          code: a.code,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          normal_balance: a.normal_balance,
          system: a.system_key !== null,
          system_key: a.system_key,
          wallet_id: a.wallet_id,
          asset_id: a.asset_id,
          description: a.description,
          archived: a.archived_at !== null,
          balance: money(bal.balance),
          debits: money(bal.debits),
          credits: money(bal.credits),
          monthly: monthly.map((m) => ({ month: m.month, debits: money(BigInt(m.d)), credits: money(BigInt(m.c)), net: money((BigInt(m.d) - BigInt(m.c)) * sign) }))
        };
      })
  });

  route(app, {
    method: "PATCH",
    url: "/v1/accounting/accounts/:id",
    summary: "Rename, renumber or archive an account",
    tags: ["accounting"],
    permission: "financials:manage",
    params: idParam,
    body: updateLedgerAccountInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx((c) => updateLedgerAccount(c, organizationId, environment, params.id, body, actor))
  });
}
