import type { FastifyInstance } from "fastify";
import type { Client } from "@setra/database";
import { classifyTransaction, ensureBooks, money, undoClassification } from "@setra/engine";
import { classifyTransactionInput, reasonInput, type Environment } from "@setra/schemas";
import { idParam, route } from "../../lib/route";

type Row = Record<string, any>;

/** Money that arrived or left and still needs a human decision. */
export async function unclassified(c: Client, organizationId: string, environment: Environment) {
  await ensureBooks(c, organizationId, environment);
  const receipts = (
    await c.query(
      `SELECT p.id, p.amount, p.asset_id, p.from_address, p.transaction_hash, p.block_timestamp, p.status, a.symbol, a.decimals
         FROM payments p JOIN assets a ON a.id = p.asset_id
        WHERE p.organization_id = $1 AND p.environment = $2 AND p.status IN ('needs_review','dismissed')
          AND NOT EXISTS (SELECT 1 FROM transaction_classifications x WHERE x.payment_id = p.id AND x.reversed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.organization_id = p.organization_id AND w.environment = p.environment AND w.chain_id = p.chain_id AND w.address = p.from_address)
        ORDER BY p.block_timestamp DESC LIMIT 200`,
      [organizationId, environment]
    )
  ).rows as Row[];
  const outgoing = (
    await c.query(
      `SELECT t.id, t.amount, t.asset_id, t.to_address, t.transaction_hash, t.block_timestamp, t.wallet_id, w.name AS wallet_name, a.symbol, a.decimals, va.vendor_id, v.name AS vendor_name
         FROM outgoing_transfers t JOIN wallets w ON w.id = t.wallet_id JOIN assets a ON a.id = t.asset_id
         LEFT JOIN vendor_addresses va ON va.organization_id = t.organization_id AND va.chain_id = t.chain_id AND va.address = t.to_address
         LEFT JOIN vendors v ON v.id = va.vendor_id
        WHERE t.organization_id = $1 AND t.environment = $2 AND t.canonical
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.outgoing_transfer_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM bill_payments b WHERE b.outgoing_transfer_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM expenses x WHERE x.outgoing_transfer_id = t.id AND x.status <> 'rejected')
          AND NOT EXISTS (SELECT 1 FROM transaction_classifications x WHERE x.outgoing_transfer_id = t.id AND x.reversed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM wallets w2 WHERE w2.organization_id = t.organization_id AND w2.environment = t.environment AND w2.chain_id = t.chain_id AND w2.address = t.to_address)
        ORDER BY t.block_timestamp DESC LIMIT 200`,
      [organizationId, environment]
    )
  ).rows as Row[];
  const fmt = (v: string, d: number) => money(BigInt(v) * 10n ** BigInt(Math.max(0, 6 - d)) / 10n ** BigInt(Math.max(0, d - 6)));
  return {
    receipts: receipts.map((p) => ({ id: p.id, amount: fmt(p.amount, p.decimals), asset: p.symbol, from_address: p.from_address, transaction_hash: p.transaction_hash, received_at: p.block_timestamp, status: p.status, link: `/app/payments/${p.id}` })),
    outgoing: outgoing.map((t) => ({ id: t.id, amount: fmt(t.amount, t.decimals), asset: t.symbol, to_address: t.to_address, transaction_hash: t.transaction_hash, sent_at: t.block_timestamp, wallet: { id: t.wallet_id, name: t.wallet_name }, vendor: t.vendor_id ? { id: t.vendor_id, name: t.vendor_name } : null }))
  };
}

/** Money Setra couldn't explain on its own: what still needs a decision, classifying it, and undoing a classification. */
export function classificationRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/unclassified",
    summary: "Money received or sent that still needs to be identified or classified",
    tags: ["accounting"],
    permission: "financials:read",
    handler: ({ tx, organizationId, environment }) => tx((c) => unclassified(c, organizationId, environment))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/classifications",
    summary: "Classify an unidentified receipt or an outgoing transfer to an account",
    tags: ["accounting"],
    permission: "financials:write",
    idempotent: true,
    body: classifyTransactionInput,
    handler: async ({ tx, body, organizationId, environment, actor, reply }) => {
      const r = await tx((c) => classifyTransaction(c, organizationId, environment, body, actor));
      reply.code(201);
      return r;
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/classifications/:id/undo",
    summary: "Undo a classification; the money returns to its holding account",
    tags: ["accounting"],
    permission: "financials:approve",
    params: idParam,
    body: reasonInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx(async (c) => (await undoClassification(c, organizationId, environment, params.id, body.reason, actor), { ok: true }))
  });
}
