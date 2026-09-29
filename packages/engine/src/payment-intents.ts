import { networks } from "@setra/config";
import { computeIntentId, intentReference } from "@setra/contracts-client";
import { type Client } from "@setra/database";
import { newId } from "@setra/schemas";
import { audit, EngineError, log, type Actor } from "./context";

/**
 * Payment intents: an onchain reference to an invoice, committed offchain, for the SetraPaymentIntent contract. Validated against the workspace's own data (tenant and mode scoped) and audited.
 */

type Row = Record<string, any>;

/**
 * Prepare a structured payment intent for an invoice. No transaction is sent: the intent id is a
 * commitment to the terms, computed offchain exactly as SetraPaymentIntent.intentIdOf does.
 * Reuses an existing open intent for the same remaining amount.
 */
export async function createPaymentIntent(client: Client, organizationId: string, invoiceId: string, options: { ttlSeconds?: number }, actor: Actor): Promise<Row> {
  const inv = (await client.query("SELECT i.*, w.address AS wallet_address FROM invoices i JOIN wallets w ON w.id = i.wallet_id WHERE i.id = $1 AND i.organization_id = $2 FOR UPDATE OF i", [invoiceId, organizationId])).rows[0] as Row | undefined;
  if (!inv) throw new EngineError("not_found", "No such invoice.", 404);
  if (!["open", "partially_paid"].includes(inv.status)) throw new EngineError("invoice_not_payable", "This invoice is not open for payment.", 409);
  const network = networks().byChainId(Number(inv.chain_id))!;
  if (!network.paymentIntent) throw new EngineError("payment_intents_unavailable", `Payment intents aren't enabled on ${network.name} yet. Direct transfers still work.`, 422);
  const asset = network.assets.find((a) => a.id === inv.asset_id)!;
  const remaining = BigInt(inv.amount_due) - BigInt(inv.amount_paid) - BigInt(inv.amount_written_off);
  if (remaining <= 0n) throw new EngineError("invoice_not_payable", "Nothing remains to be paid.", 409);

  const reusable = (
    await client.query(
      `SELECT * FROM payment_intents WHERE invoice_id = $1 AND status = 'open' AND amount = $2 AND contract_address = $3 AND expires_at > now() + interval '5 minutes' ORDER BY created_at DESC LIMIT 1`,
      [invoiceId, remaining.toString(), network.paymentIntent.address]
    )
  ).rows[0];
  if (reusable) return reusable as Row;

  const ttl = options.ttlSeconds ?? 24 * 60 * 60;
  let expiresAt = new Date(Date.now() + ttl * 1000);
  if (inv.expires_at && new Date(inv.expires_at) < expiresAt) expiresAt = new Date(inv.expires_at);
  if (expiresAt.getTime() <= Date.now() + 60_000) throw new EngineError("invoice_expiring", "This invoice expires too soon for a payment intent.", 409);
  const expiresAtSeconds = BigInt(Math.floor(expiresAt.getTime() / 1000));

  const id = newId("paymentIntent");
  const ref = intentReference(id);
  const intentHash = computeIntentId(network.chainId, network.paymentIntent.address, {
    merchant: inv.wallet_address,
    token: asset.address,
    amount: remaining,
    expiresAt: expiresAtSeconds,
    ref
  });
  await client.query(
    `INSERT INTO payment_intents (id, organization_id, environment, invoice_id, chain_id, contract_address, intent_hash, reference, merchant_address, asset_id, token_address, amount, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, organizationId, inv.environment, invoiceId, network.chainId, network.paymentIntent.address, intentHash.toLowerCase(), ref, inv.wallet_address, asset.id, asset.address, remaining.toString(), new Date(Number(expiresAtSeconds) * 1000)]
  );
  await audit(client, actor, { organizationId, environment: inv.environment, action: "payment_intent_created", objectType: "payment_intent", objectId: id, next: { invoice_id: invoiceId, intent_id: intentHash } });
  log().info("payment_intent_created", { organizationId, paymentIntentId: id, invoiceId, intentId: intentHash });
  return (await client.query("SELECT * FROM payment_intents WHERE id = $1", [id])).rows[0] as Row;
}
