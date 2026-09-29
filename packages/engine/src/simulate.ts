import { randomBytes } from "node:crypto";
import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { toBaseUnits, type SimulatePaymentInput } from "@setra/schemas";
import { EngineError, log, type Actor, audit } from "./context";
import { ingestObservation, reversePayment, settleObservation, type WalletRef } from "./pipeline";

type Row = Record<string, any>;

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;

/** A token address that is not in any registry, used to exercise the wrong-token path in test mode. */
const UNREGISTERED_TOKEN = "0x000000000000000000000000000000000000dead";

/**
 * Test mode only. Creates a clearly-labelled simulated source observation and sends it through the
 * exact same pipeline as a real chain observation (observe → provisional match → settle → events →
 * webhooks). Simulations are rejected outside test mode by the API and here.
 */
export async function simulatePayment(client: Client, organizationId: string, environment: "test" | "live", input: SimulatePaymentInput, actor: Actor, options: { at?: Date } = {}) {
  if (environment !== "test") throw new EngineError("test_mode_only", "Simulated payments are only available in test mode.", 403);

  const invoice = input.invoice_id
    ? ((await client.query("SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 AND environment = 'test'", [input.invoice_id, organizationId])).rows[0] as Row | undefined)
    : undefined;
  if (input.invoice_id && !invoice) throw new EngineError("invoice_not_found", "No such test-mode invoice.", 404);

  const walletId = input.wallet_id ?? invoice?.wallet_id;
  const wallet = (
    await client.query(
      `SELECT * FROM wallets WHERE organization_id = $1 AND environment = 'test' AND archived_at IS NULL ${walletId ? "AND id = $2" : ""} ORDER BY created_at LIMIT 1`,
      walletId ? [organizationId, walletId] : [organizationId]
    )
  ).rows[0] as Row | undefined;
  if (!wallet) throw new EngineError("wallet_required", "Add a test-mode receiving wallet first.", 422);

  const network = networks().byChainId(Number(wallet.chain_id))!;
  const acceptedAsset = (await client.query<{ asset_id: string }>("SELECT asset_id FROM wallet_assets WHERE wallet_id = $1 ORDER BY asset_id LIMIT 1", [wallet.id])).rows[0]?.asset_id;
  const asset = network.assets.find((a) => a.id === (invoice?.asset_id ?? acceptedAsset)) ?? network.assets[0];
  if (!asset) throw new EngineError("asset_missing", "This network has no configured stablecoin.", 422);

  const remaining = invoice ? BigInt(invoice.amount_due) - BigInt(invoice.amount_paid) - BigInt(invoice.amount_written_off) : 0n;
  const knownSender = invoice
    ? (await client.query<{ address: string }>("SELECT address FROM customer_addresses WHERE customer_id = $1 AND chain_id = $2 ORDER BY created_at LIMIT 1", [invoice.customer_id, wallet.chain_id])).rows[0]?.address
    : undefined;

  let amount: bigint;
  let from = input.from_address ?? knownSender ?? hex(20);
  let token = asset.address as string;
  switch (input.scenario) {
    case "exact":
      if (!invoice) throw new EngineError("invoice_required", "Choose an invoice for an exact payment.", 422);
      amount = remaining > 0n ? remaining : BigInt(invoice.amount_due);
      break;
    case "partial":
      if (!invoice) throw new EngineError("invoice_required", "Choose an invoice for a partial payment.", 422);
      amount = input.amount ? toBaseUnits(input.amount, asset.decimals) : remaining * 3n / 4n;
      break;
    case "overpaid":
      if (!invoice) throw new EngineError("invoice_required", "Choose an invoice for an overpayment.", 422);
      amount = input.amount ? toBaseUnits(input.amount, asset.decimals) : remaining + remaining / 4n;
      break;
    case "duplicate":
      if (!invoice) throw new EngineError("invoice_required", "Choose a paid invoice to send a duplicate.", 422);
      amount = BigInt(invoice.amount_due);
      break;
    case "unknown":
      amount = input.amount ? toBaseUnits(input.amount, asset.decimals) : toBaseUnits("740.00", asset.decimals);
      from = input.from_address ?? hex(20);
      break;
    case "wrong_token":
      amount = input.amount ? toBaseUnits(input.amount, asset.decimals) : remaining > 0n ? remaining : toBaseUnits("100.00", asset.decimals);
      token = network.assets.find((a) => a.id !== asset.id)?.address ?? UNREGISTERED_TOKEN;
      break;
    default:
      throw new EngineError("unsupported_scenario", "Unsupported scenario.", 422);
  }
  if (amount <= 0n) throw new EngineError("invalid_amount", "The simulated amount must be greater than zero.", 422);

  const cursor = (await client.query<{ block_number: string }>("SELECT block_number FROM chain_cursors WHERE chain_id = $1 AND stage = 'settled'", [wallet.chain_id])).rows[0];
  const walletRef: WalletRef = { id: wallet.id, organization_id: organizationId, environment: "test", chain_id: Number(wallet.chain_id), name: wallet.name, address: wallet.address };
  const result = await ingestObservation(
    client,
    walletRef,
    {
      sourceType: "simulated",
      chainId: Number(wallet.chain_id),
      blockNumber: cursor ? BigInt(cursor.block_number) : 0n,
      blockHash: hex(32),
      transactionHash: hex(32),
      transactionIndex: 0,
      logIndex: 0,
      tokenAddress: token,
      fromAddress: from,
      toAddress: wallet.address,
      amount,
      blockTimestamp: options.at ?? new Date(),
      raw: { simulated: true, scenario: input.scenario, note: "Simulated in test mode. No funds moved." }
    },
    "tip"
  );
  if (input.finalize && result.observationId) await settleObservation(client, result.observationId, "Simulated settlement (test mode)");
  await audit(client, actor, { organizationId, environment: "test", action: "payment_simulated", objectType: "payment", objectId: result.paymentId ?? "none", next: { scenario: input.scenario, invoice_id: invoice?.id ?? null } });
  log().info("payment_simulated", { organizationId, scenario: input.scenario, paymentId: result.paymentId });
  return result;
}

/** Test mode only: finalize a simulated confirming payment (to demo the confirming → paid transition). */
export async function confirmSimulatedPayment(client: Client, organizationId: string, paymentId: string) {
  const payment = await simulatedPayment(client, organizationId, paymentId);
  await settleObservation(client, payment.observation_id, "Simulated settlement (test mode)");
}

/**
 * Test mode only: invalidate a simulated observation as if its block had been reorganized away.
 * Exercises the same compensation path as a real deep reorg.
 */
export async function simulateReorg(client: Client, organizationId: string, paymentId: string, actor: Actor) {
  await simulatedPayment(client, organizationId, paymentId);
  return reversePayment(client, paymentId, "Controlled reorg simulated in test mode", actor);
}

async function simulatedPayment(client: Client, organizationId: string, paymentId: string): Promise<Row> {
  const payment = (await client.query("SELECT * FROM payments WHERE id = $1 AND organization_id = $2", [paymentId, organizationId])).rows[0] as Row | undefined;
  if (!payment) throw new EngineError("not_found", "No such payment.", 404);
  if (payment.environment !== "test" || payment.source !== "simulated") throw new EngineError("simulated_only", "Only simulated test-mode payments can be changed this way.", 403);
  return payment;
}
