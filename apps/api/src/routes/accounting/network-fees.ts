import type { FastifyInstance } from "fastify";
import { route } from "../../lib/route";

type Row = Record<string, any>;

/** Network fees (gas) paid by monitored wallets. */
export function networkFeeRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/network-fees",
    summary: "Gas paid by monitored wallets, and whether it's in the books yet",
    tags: ["accounting"],
    permission: "financials:read",
    handler: ({ tx, organizationId, environment }) =>
      tx(async (c) => {
        const rows = (
          await c.query(
            `SELECT f.*, w.name AS wallet_name, e.id AS entry_id, e.number AS entry_number, i.message AS issue
               FROM network_fees f JOIN wallets w ON w.id = f.wallet_id
               LEFT JOIN journal_entries e ON e.organization_id = f.organization_id AND e.environment = f.environment AND e.source_key = 'gas:' || f.id
               LEFT JOIN accounting_issues i ON i.organization_id = f.organization_id AND i.environment = f.environment AND i.source_key = 'gas:' || f.id AND i.resolved_at IS NULL
              WHERE f.organization_id = $1 AND f.environment = $2 AND f.paid_by_wallet ORDER BY f.block_timestamp DESC LIMIT 200`,
            [organizationId, environment]
          )
        ).rows as Row[];
        const fmt = (wei: string) => {
          const v = BigInt(wei);
          const s = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
          return `${v / 10n ** 18n}${s ? `.${s}` : ""}`;
        };
        return {
          data: rows.map((f) => ({
            id: f.id,
            wallet: { id: f.wallet_id, name: f.wallet_name },
            transaction_hash: f.transaction_hash,
            fee: fmt(f.fee_native),
            symbol: f.native_symbol,
            paid_at: f.block_timestamp,
            journal_entry: f.entry_id ? { id: f.entry_id, number: f.entry_number } : null,
            waiting_for: f.entry_id ? null : f.issue ?? "Waiting to be posted"
          }))
        };
      })
  });
}
