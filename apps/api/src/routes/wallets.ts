import type { FastifyInstance } from "fastify";
import { networks } from "@setra/config";
import { withGlobal, type Client } from "@setra/database";
import { audit, createWallet, serializeWallet } from "@setra/engine";
import { createWalletInput, listQuery, updateWalletInput } from "@setra/schemas";
import { ApiError, notFound } from "../lib/errors";
import { cursorClause, page } from "../lib/pagination";
import { idParam, route } from "../lib/route";

type Row = Record<string, any>;

/**
 * Honest monitoring status. Setra never claims a wallet is "live" unless the worker has recently
 * advanced the chain cursor past the wallet's start block.
 */
export async function walletSync(wallets: Row[], client: Client) {
  const chainIds = [...new Set(wallets.map((w) => Number(w.chain_id)))];
  const cursors = chainIds.length
    ? (await withGlobal((c) => c.query("SELECT * FROM chain_cursors WHERE chain_id = ANY($1)", [chainIds]))).rows
    : [];
  const backfills = wallets.length
    ? (await client.query("SELECT DISTINCT ON (wallet_id) * FROM wallet_backfills WHERE wallet_id = ANY($1) ORDER BY wallet_id, created_at DESC", [wallets.map((w) => w.id)])).rows
    : [];
  const result = new Map<string, Row>();
  for (const w of wallets) {
    const network = networks().byChainId(Number(w.chain_id));
    const settled = cursors.find((c) => Number(c.chain_id) === Number(w.chain_id) && c.stage === "settled");
    const tip = cursors.find((c) => Number(c.chain_id) === Number(w.chain_id) && c.stage === "tip");
    const backfill = backfills.find((b) => b.wallet_id === w.id);
    const updatedAt = settled?.updated_at ? new Date(settled.updated_at) : null;
    const stale = !updatedAt || Date.now() - updatedAt.getTime() > 30_000;
    let status: string;
    let message: string;
    if (!w.monitoring_enabled) {
      status = "paused";
      message = "Monitoring is paused. New payments to this wallet won't be recorded.";
    } else if (!network?.enabled) {
      status = "unavailable";
      message = `${network?.name ?? "This network"} is not enabled on this deployment.`;
    } else if (settled?.last_error) {
      status = "error";
      message = "The network provider is failing. Setra is retrying and will not mark anything paid until it recovers.";
    } else if (w.monitor_from_block === null) {
      status = "starting";
      message = "Waiting for the monitoring worker to start watching this wallet.";
    } else if (stale) {
      status = "delayed";
      message = "Monitoring is behind. Payments will appear once the worker catches up. Nothing is lost.";
    } else if (backfill && backfill.status !== "completed") {
      status = "backfilling";
      message = "Live, and scanning recent history for earlier payments.";
    } else {
      status = "live";
      message = `Watching every ${network.name} block.`;
    }
    result.set(w.id, {
      status,
      message,
      settled_block: settled && Number(settled.block_number) >= 0 ? String(settled.block_number) : null,
      tip_block: tip ? String(tip.block_number) : null,
      head_block: settled?.head_block_number ? String(settled.head_block_number) : null,
      last_synced_at: updatedAt?.toISOString() ?? null,
      backfill: backfill
        ? { status: backfill.status, from_block: String(backfill.from_block), to_block: String(backfill.to_block), next_block: String(backfill.next_block) }
        : null
    });
  }
  return result;
}

async function walletStats(client: Client, ids: string[]) {
  if (!ids.length) return new Map<string, Row>();
  const r = await client.query(
    `SELECT p.wallet_id, count(*)::int AS payments,
            COALESCE(SUM(p.amount / power(10::numeric, a.decimals)) FILTER (WHERE a.peg_currency = 'USD' AND p.status IN ('matched','partial','overpaid','needs_review','dismissed')), 0)::text AS total_received,
            max(p.block_timestamp) AS last_payment_at
       FROM payments p LEFT JOIN assets a ON a.id = p.asset_id
      WHERE p.wallet_id = ANY($1) AND p.status <> 'reversed' GROUP BY p.wallet_id`,
    [ids]
  );
  return new Map(r.rows.map((row) => [row.wallet_id, row]));
}

async function walletAssets(client: Client, ids: string[]) {
  if (!ids.length) return new Map<string, string[]>();
  const r = await client.query<{ wallet_id: string; asset_id: string }>("SELECT wallet_id, asset_id FROM wallet_assets WHERE wallet_id = ANY($1) ORDER BY asset_id", [ids]);
  const map = new Map<string, string[]>();
  for (const row of r.rows) map.set(row.wallet_id, [...(map.get(row.wallet_id) ?? []), row.asset_id]);
  return map;
}

export function walletRoutes(app: FastifyInstance) {
  const present = async (client: Client, rows: Row[]) => {
    const ids = rows.map((r) => r.id);
    const [assets, stats, sync] = await Promise.all([walletAssets(client, ids), walletStats(client, ids), walletSync(rows, client)]);
    return (row: Row) => serializeWallet(row, { assets: assets.get(row.id) ?? [], stats: stats.get(row.id) ?? {}, sync: sync.get(row.id) ?? null });
  };

  route(app, {
    method: "POST",
    url: "/v1/wallets",
    summary: "Add a receiving wallet to monitor",
    tags: ["wallets"],
    permission: "wallets:write",
    idempotent: true,
    body: createWalletInput,
    handler: async ({ body, tx, organizationId, environment, actor, reply }) => {
      const wallet = await tx(async (c) => {
        const row = await createWallet(c, organizationId, environment, body, actor);
        return (await present(c, [row]))(row);
      });
      reply.code(201);
      return wallet;
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/wallets",
    summary: "List receiving wallets",
    tags: ["wallets"],
    permission: "read",
    query: listQuery,
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment];
        const where = `organization_id = $1 AND environment = $2 AND archived_at IS NULL${cursorClause(params, query.starting_after)}`;
        params.push(query.limit + 1);
        const rows = (await c.query(`SELECT * FROM wallets WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params)).rows;
        return page(rows, query.limit, await present(c, rows));
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/wallets/:id",
    summary: "Retrieve a wallet with monitoring status",
    tags: ["wallets"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const row = (await c.query("SELECT * FROM wallets WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0];
        if (!row) throw notFound("wallet");
        return (await present(c, [row]))(row);
      })
  });

  route(app, {
    method: "PATCH",
    url: "/v1/wallets/:id",
    summary: "Rename a wallet or pause/resume monitoring",
    tags: ["wallets"],
    permission: "wallets:write",
    params: idParam,
    body: updateWalletInput,
    handler: async ({ params, body, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        const before = (await c.query("SELECT * FROM wallets WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL FOR UPDATE", [params.id, organizationId, environment])).rows[0];
        if (!before) throw notFound("wallet");
        const row = (
          await c.query("UPDATE wallets SET name = COALESCE($2, name), monitoring_enabled = COALESCE($3, monitoring_enabled), updated_at = now() WHERE id = $1 RETURNING *", [
            params.id,
            body.name ?? null,
            body.monitoring_enabled ?? null
          ])
        ).rows[0];
        if (body.monitoring_enabled !== undefined && body.monitoring_enabled !== before.monitoring_enabled) {
          // Resuming after a pause: backfill the gap so payments made while paused are still recorded.
          if (body.monitoring_enabled) await c.query("UPDATE wallets SET monitor_from_block = NULL, requested_backfill_from_block = COALESCE(requested_backfill_from_block, monitor_from_block) WHERE id = $1", [params.id]);
        }
        await audit(c, actor, {
          organizationId,
          environment,
          action: body.monitoring_enabled === false ? "wallet_monitoring_paused" : body.monitoring_enabled === true ? "wallet_monitoring_resumed" : "wallet_updated",
          objectType: "wallet",
          objectId: params.id,
          previous: { name: before.name, monitoring_enabled: before.monitoring_enabled },
          next: { name: row.name, monitoring_enabled: row.monitoring_enabled }
        });
        const fresh = (await c.query("SELECT * FROM wallets WHERE id = $1", [params.id])).rows[0];
        return (await present(c, [fresh]))(fresh);
      })
  });

  route(app, {
    method: "DELETE",
    url: "/v1/wallets/:id",
    summary: "Stop using a wallet (history is kept)",
    tags: ["wallets"],
    permission: "wallets:write",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        const w = (await c.query("SELECT * FROM wallets WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL FOR UPDATE", [params.id, organizationId, environment])).rows[0];
        if (!w) throw notFound("wallet");
        const open = await c.query("SELECT count(*)::int AS n FROM invoices WHERE wallet_id = $1 AND status IN ('open','partially_paid')", [params.id]);
        if (open.rows[0].n > 0) throw new ApiError(409, "wallet_has_open_invoices", `This wallet has ${open.rows[0].n} open invoice(s). Cancel or settle them first.`);
        await c.query("UPDATE wallets SET archived_at = now(), monitoring_enabled = false, updated_at = now() WHERE id = $1", [params.id]);
        await audit(c, actor, { organizationId, environment, action: "wallet_removed", objectType: "wallet", objectId: params.id, previous: { address: w.address } });
        return { id: params.id, archived: true };
      })
  });
}
