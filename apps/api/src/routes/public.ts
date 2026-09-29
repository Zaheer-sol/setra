import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { networks } from "@setra/config";
import { withGlobal, withSystem, withTenant, type Client } from "@setra/database";
import { amount, createPaymentIntent, explorerTx, serializeLineItems, serializePaymentIntent, simulatePayment, SYSTEM } from "@setra/engine";
import { ApiError } from "../lib/errors";
import { parse } from "../lib/route";

type Row = Record<string, any>;

/**
 * The hosted payment page API. Public, unauthenticated, rate-limited, and deliberately narrow:
 * it exposes what a payer needs (merchant, amount, how to pay, status) and nothing internal,
 * no internal ids beyond the invoice number, no customer email, no other invoices.
 */
export function publicRoutes(app: FastifyInstance) {
  const limit = { rateLimit: { max: 120, timeWindow: "1 minute" } };
  const tokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

  const locate = async (token: string) => {
    const hit = (await withSystem((c) => c.query("SELECT id, organization_id FROM invoices WHERE public_token = $1", [token]))).rows[0];
    if (!hit) throw new ApiError(404, "not_found", "This payment link doesn't exist. Check the link or ask the sender for a new one.");
    return hit as { id: string; organization_id: string };
  };

  app.get("/v1/public/payment-requests/:token", { config: limit, schema: { tags: ["public"], summary: "Hosted payment page data" } }, async (request) => {
    const { token } = parse(tokenParam, request.params, "path");
    const hit = await locate(token);
    return withTenant(hit.organization_id, (c) => publicView(c, hit.id));
  });

  app.post("/v1/public/payment-requests/:token/intent", { config: limit, schema: { tags: ["public"], summary: "Prepare a payment intent for wallet checkout" } }, async (request) => {
    const { token } = parse(tokenParam, request.params, "path");
    const hit = await locate(token);
    return withTenant(hit.organization_id, async (c) => {
      const intent = await createPaymentIntent(c, hit.organization_id, hit.id, {}, { ...SYSTEM, label: "Hosted payment page", requestId: request.id });
      const view = serializePaymentIntent(intent);
      return { intent_id: view.intent_id, contract_address: view.contract_address, chain_id: view.chain_id, terms: view.terms, expires_at: view.expires_at };
    });
  });

  app.post("/v1/public/payment-requests/:token/simulate", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { tags: ["public"], summary: "Test mode only: simulate paying this request" } }, async (request) => {
    const { token } = parse(tokenParam, request.params, "path");
    const hit = await locate(token);
    return withTenant(hit.organization_id, async (c) => {
      const inv = (await c.query("SELECT environment FROM invoices WHERE id = $1", [hit.id])).rows[0];
      if (inv.environment !== "test") throw new ApiError(403, "test_mode_only", "Simulated payments are only available for test-mode payment requests.");
      await simulatePayment(c, hit.organization_id, "test", { scenario: "exact", invoice_id: hit.id, finalize: true }, { ...SYSTEM, label: "Hosted payment page (test mode)", requestId: request.id });
      return publicView(c, hit.id);
    });
  });
}

async function publicView(c: Client, invoiceId: string) {
  const inv = (await c.query("SELECT i.*, w.address AS wallet_address, c.name AS customer_name FROM invoices i JOIN wallets w ON w.id = i.wallet_id JOIN customers c ON c.id = i.customer_id WHERE i.id = $1", [invoiceId])).rows[0] as Row;
  const org = (await withGlobal((g) => g.query("SELECT name, support_email FROM organizations WHERE id = $1", [inv.organization_id]))).rows[0] as Row;
  const network = networks().byChainId(Number(inv.chain_id))!;
  const asset = network.assets.find((a) => a.id === inv.asset_id)!;
  const payments = (
    await c.query("SELECT * FROM payments WHERE (invoice_id = $1 OR (provisional_invoice_id = $1 AND status = 'confirming')) AND status <> 'reversed' ORDER BY block_timestamp", [invoiceId])
  ).rows as Row[];
  const lineItems = (await c.query("SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position", [invoiceId])).rows;
  const d = asset.decimals;
  const remaining = BigInt(inv.amount_due) - BigInt(inv.amount_paid) - BigInt(inv.amount_written_off);
  const confirming = payments.filter((p) => p.status === "confirming").reduce((sum, p) => sum + BigInt(p.amount), 0n);
  const expired = inv.status === "expired" || (inv.status === "open" && inv.expires_at && new Date(inv.expires_at) < new Date());
  const state =
    inv.status === "cancelled"
      ? "cancelled"
      : inv.status === "paid"
        ? "paid"
        : inv.status === "overpaid"
          ? "overpaid"
          : confirming > 0n
            ? "confirming"
            : inv.status === "partially_paid"
              ? "partially_paid"
              : expired
                ? "expired"
                : "awaiting_payment";
  return {
    merchant: { name: org.name, support_email: org.support_email ?? null },
    invoice: {
      number: inv.number,
      title: inv.title ?? null,
      purpose: inv.purpose ?? null,
      line_items: serializeLineItems(lineItems, d),
      customer_name: inv.customer_name,
      currency: inv.currency,
      amount_due: amount(inv.amount_due, d),
      amount_paid: amount(inv.amount_paid, d),
      amount_remaining: amount(remaining > 0n ? remaining : 0n, d),
      amount_confirming: amount(confirming, d),
      due_at: inv.due_at,
      expires_at: inv.expires_at,
      paid_at: inv.paid_at
    },
    state,
    test_mode: inv.environment === "test",
    pay: {
      network: { name: network.name, family: network.family, chain_id: network.chainId, testnet: network.environment === "test", explorer_url: network.explorerUrl ?? null, native_symbol: network.nativeSymbol, rpc_url: network.publicRpcUrl },
      asset: { symbol: asset.symbol, name: asset.name, address: asset.address, decimals: asset.decimals },
      recipient: inv.wallet_address,
      amount: amount(remaining > 0n ? remaining : 0n, d),
      amount_base_units: (remaining > 0n ? remaining : 0n).toString(),
      payment_intents: network.paymentIntent ? { contract_address: network.paymentIntent.address } : null
    },
    payments: payments.map((p) => ({
      amount: amount(p.amount, d),
      status: p.status,
      transaction_hash: p.source === "simulated" ? null : p.transaction_hash,
      explorer_url: explorerTx(Number(p.chain_id), p.transaction_hash, p.source === "simulated"),
      simulated: p.source === "simulated",
      paid_at: p.block_timestamp
    }))
  };
}
