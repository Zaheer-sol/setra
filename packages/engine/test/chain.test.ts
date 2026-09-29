import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { resetNetworks, networks } from "../../config/src";
import { EvmAdapter } from "../../blockchain/src";
import { computeIntentId, ERC20_ABI, PAYMENT_INTENT_ABI } from "../../contracts-client/src";
import { closePools, withSystem, withTenant, pool } from "../../database/src";
import { syncNetworks } from "../../database/src/migrator";
import { startDevChain, type DevChain } from "../../devchain/src";
import { ChainIngestor, createCustomer, createInvoice, createOrganization, createPaymentIntent, createUser, createWallet, type Actor } from "../src";
import { randomAddress, resetLocalChainState } from "../../../test/fixtures";

/**
 * End-to-end against a real EVM node (Anvil): real ERC-20 transfers, the real SetraPaymentIntent
 * contract, real blocks, a real chain reorganization, restarts and RPC failure. The ingestion code
 * under test is exactly what runs against Monad.
 */

let chain: DevChain;
let orgId: string;
let actor: Actor;
let merchant: Address;
let walletId: string;
const customers: Record<string, string> = {};

async function ingestor(workerId = "test-worker") {
  return new ChainIngestor(new EvmAdapter(networks().byKey("local")!), { workerId, backfillSafetyBlocks: 50 });
}

async function tickUntil(check: () => Promise<boolean>, workerId?: string, max = 10) {
  const ing = await ingestor(workerId);
  for (let i = 0; i < max; i++) {
    await ing.tick();
    if (await check()) return;
    await chain.mine(1);
  }
  throw new Error("condition not reached");
}

const q = (sql: string, params: unknown[] = []) => withTenant(orgId, (c) => c.query(sql, params)).then((r) => r.rows);

beforeAll(async () => {
  const port = 8600 + Math.floor(Math.random() * 300);
  chain = await startDevChain({ port });
  process.env.LOCAL_CHAIN_ENABLED = "true";
  process.env.LOCAL_CHAIN_RPC_URL = chain.rpcUrl;
  process.env.LOCAL_USDC_ADDRESS = chain.usdc;
  process.env.LOCAL_PAYMENT_INTENT_ADDRESS = chain.intentContract;
  process.env.LOCAL_CHAIN_CONFIRMATIONS = "2";
  resetNetworks();
  const owner = await import("pg").then(({ default: pg }) => new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL }));
  await owner.connect();
  await syncNetworks(owner);
  await owner.end();
  await resetLocalChainState();

  const user = await createUser({ email: `chain+${Date.now()}@acme.test`, name: "Chain Tester", password: "correct horse battery" });
  const org = await createOrganization({ name: "Acme Infrastructure", ownerUserId: user.id });
  orgId = org.id;
  actor = { type: "user", id: user.id, label: user.email };
  merchant = chain.accounts[4]!.address.toLowerCase() as Address;
  await withTenant(orgId, async (c) => {
    walletId = (await createWallet(c, orgId, "test", { name: "Main Wallet", network: "local", address: merchant, assets: ["USDC"] }, actor)).id;
    customers.acme = (await createCustomer(c, orgId, "test", { name: "Acme Ltd", metadata: {}, wallet_addresses: [{ address: chain.accounts[1]!.address.toLowerCase() as Address, network: "local" }] }, actor)).id;
    customers.nova = (await createCustomer(c, orgId, "test", { name: "Nova Systems", metadata: {}, wallet_addresses: [] }, actor)).id;
  });
  // First tick activates the wallet (monitoring starts at the next settled block).
  await chain.mine(3);
  await (await ingestor()).tick();
}, 120_000);

afterAll(async () => {
  chain?.stop();
  await closePools();
});

describe("direct USDC transfer on a real EVM node", () => {
  it("detects, confirms and matches a transfer to the merchant wallet", async () => {
    const inv = await withTenant(orgId, (c) => createInvoice(c, orgId, "test", { customer_id: customers.nova!, amount: "2000.00", title: "Hosting", currency: "USD", asset: "USDC", network: "local", metadata: {} }, actor));
    const tx = await chain.transferUsdc(2, merchant, 2_000_000_000n); // unknown sender, unique exact amount

    await tickUntil(async () => (await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status === "paid");
    const [payment] = await q("SELECT * FROM payments WHERE transaction_hash = $1", [tx]);
    expect(payment.status).toBe("matched");
    expect(payment.source).toBe("chain");
    const [obs] = await q("SELECT * FROM source_observations WHERE id = $1", [payment.observation_id]);
    expect(obs.confirmation_state).toBe("finalized");
    expect(obs.token_address).toBe(chain.usdc);
    const receipt = await chain.publicClient.getTransactionReceipt({ hash: tx as Hex });
    expect(obs.block_hash).toBe(receipt.blockHash);
    const events = (await q("SELECT type FROM financial_events WHERE payment_id = $1 ORDER BY id", [payment.id])).map((r) => r.type);
    expect(events).toEqual(["PAYMENT_OBSERVED", "PAYMENT_MATCHED"]);
  });

  it("does not duplicate anything after a worker restart or when ranges are rescanned", async () => {
    const before = await q("SELECT count(*)::int AS n FROM source_observations");
    await withSystem((c) => c.query("UPDATE chain_cursors SET block_number = block_number - 20 WHERE chain_id = 31337 AND stage = 'settled'"));
    await (await ingestor("restarted-worker")).tick();
    const after = await q("SELECT count(*)::int AS n FROM source_observations");
    expect(after[0].n).toBe(before[0].n);
  });

  it("pauses without moving the cursor when the RPC is unavailable", async () => {
    const [before] = (await withSystem((c) => c.query("SELECT block_number FROM chain_cursors WHERE chain_id = 31337 AND stage = 'settled'"))).rows;
    const broken = new ChainIngestor(new EvmAdapter({ ...networks().byKey("local")!, rpcUrl: "http://127.0.0.1:1" }), { workerId: "broken" });
    await expect(broken.tick()).rejects.toThrow();
    const [after] = (await withSystem((c) => c.query("SELECT block_number, last_error FROM chain_cursors WHERE chain_id = 31337 AND stage = 'settled'"))).rows;
    expect(after.block_number).toBe(before.block_number);
    expect(after.last_error).toBeTruthy();
    await (await ingestor()).tick(); // recovers and clears the error
    const [recovered] = (await withSystem((c) => c.query("SELECT last_error FROM chain_cursors WHERE chain_id = 31337 AND stage = 'settled'"))).rows;
    expect(recovered.last_error).toBeNull();
  });
});

describe("SetraPaymentIntent on a real EVM node", () => {
  it("matches by onchain reference when two invoices have the same amount, recording one payment with supporting evidence", async () => {
    const make = (customer: string) =>
      withTenant(orgId, (c) => createInvoice(c, orgId, "test", { customer_id: customer, amount: "750.00", title: "Hosting", currency: "USD", asset: "USDC", network: "local", metadata: {} }, actor));
    await make(customers.acme!);
    const target = await make(customers.nova!);
    const intent = await withTenant(orgId, (c) => createPaymentIntent(c, orgId, target.id, {}, actor));

    const terms = { merchant, token: chain.usdc, amount: BigInt(intent.amount), expiresAt: BigInt(Math.floor(new Date(intent.expires_at).getTime() / 1000)), ref: intent.reference as Hex };
    const onchainId = await chain.publicClient.readContract({ address: chain.intentContract, abi: PAYMENT_INTENT_ABI, functionName: "intentIdOf", args: [terms] });
    expect(onchainId.toLowerCase()).toBe(intent.intent_hash);
    expect(computeIntentId(chain.chainId, chain.intentContract, terms).toLowerCase()).toBe(intent.intent_hash);

    const payer = chain.wallet(3);
    const approve = await payer.writeContract({ address: chain.usdc, abi: ERC20_ABI, functionName: "approve", args: [chain.intentContract, terms.amount], account: chain.accounts[3]!, chain: payer.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: approve });
    const payTx = await payer.writeContract({ address: chain.intentContract, abi: PAYMENT_INTENT_ABI, functionName: "pay", args: [terms], account: chain.accounts[3]!, chain: payer.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: payTx });

    await tickUntil(async () => (await q("SELECT status FROM invoices WHERE id = $1", [target.id]))[0].status === "paid");
    const payments = await q("SELECT * FROM payments WHERE transaction_hash = $1", [payTx]);
    expect(payments).toHaveLength(1);
    expect(payments[0].payment_intent_id).toBe(intent.id);
    expect(payments[0].supporting_observation_id).toBeTruthy();
    const [primary] = await q("SELECT source_type FROM source_observations WHERE id = $1", [payments[0].observation_id]);
    expect(primary.source_type).toBe("payment_intent_event");
    const [decision] = await q("SELECT checks FROM match_decisions WHERE payment_id = $1 AND stage = 'final'", [payments[0].id]);
    expect(decision.checks.find((c: { code: string }) => c.code === "payment_intent").passed).toBe(true);
    const [intentRow] = await q("SELECT status, payer_address FROM payment_intents WHERE id = $1", [intent.id]);
    expect(intentRow).toEqual({ status: "paid", payer_address: chain.accounts[3]!.address.toLowerCase() });

    // The merchant refunds through the contract; Setra records REFUND_OBSERVED with the refund tx as evidence.
    const merchantWallet = chain.wallet(4);
    const approveRefund = await merchantWallet.writeContract({ address: chain.usdc, abi: ERC20_ABI, functionName: "approve", args: [chain.intentContract, terms.amount], account: chain.accounts[4]!, chain: merchantWallet.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: approveRefund });
    const refundTx = await merchantWallet.writeContract({ address: chain.intentContract, abi: PAYMENT_INTENT_ABI, functionName: "refund", args: [terms], account: chain.accounts[4]!, chain: merchantWallet.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: refundTx });
    await tickUntil(async () => (await q("SELECT status FROM payment_intents WHERE id = $1", [intent.id]))[0].status === "refunded");
    const [refund] = await q("SELECT data FROM financial_events WHERE payment_id = $1 AND type = 'REFUND_OBSERVED'", [payments[0].id]);
    expect(refund.data.refund).toMatchObject({ transaction_hash: refundTx.toLowerCase(), recipient: chain.accounts[3]!.address.toLowerCase(), contract_event: "PaymentIntentRefunded" });
  });
});

describe("real chain reorganization", () => {
  it("reverses a settled payment whose block is replaced, and reopens the invoice", async () => {
    const inv = await withTenant(orgId, (c) => createInvoice(c, orgId, "test", { customer_id: customers.acme!, amount: "321.00", title: "Hosting", currency: "USD", asset: "USDC", network: "local", metadata: {} }, actor));
    const snapshot = await chain.testClient.snapshot();
    const tx = await chain.transferUsdc(1, merchant, 321_000_000n);
    await tickUntil(async () => (await q("SELECT status FROM invoices WHERE id = $1", [inv.id]))[0].status === "paid");

    // Replace the chain: revert to before the payment and build a longer fork without it.
    await chain.testClient.revert({ id: snapshot });
    await chain.mine(8);
    const ing = await ingestor();
    await ing.tick(); // detects the hash mismatch at the settled cursor and compensates
    await ing.tick(); // rescans the new canonical range

    const [payment] = await q("SELECT * FROM payments WHERE transaction_hash = $1", [tx]);
    expect(payment.status).toBe("reversed");
    const [invoice] = await q("SELECT status, amount_paid FROM invoices WHERE id = $1", [inv.id]);
    expect(invoice).toEqual({ status: "open", amount_paid: "0" });
    const types = (await q("SELECT type FROM financial_events WHERE payment_id = $1 ORDER BY id", [payment.id])).map((r) => r.type);
    expect(types).toEqual(["PAYMENT_OBSERVED", "PAYMENT_MATCHED", "PAYMENT_REVERSED"]);
    const [exception] = await q("SELECT type, status FROM exceptions WHERE payment_id = $1 AND type = 'reversal'", [payment.id]);
    expect(exception).toEqual({ type: "reversal", status: "open" });
  });
});

describe("tenant routing", () => {
  it("records a payment for every workspace monitoring the same address, isolated from each other", async () => {
    const user = await createUser({ email: `other+${Date.now()}@nova.test`, name: "Other", password: "correct horse battery" });
    const other = await createOrganization({ name: "Other Workspace", ownerUserId: user.id });
    await withTenant(other.id, (c) => createWallet(c, other.id, "test", { name: "Shared address", network: "local", address: merchant, assets: ["USDC"] }, { type: "user", id: user.id }));
    await (await ingestor()).tick(); // activates the new wallet
    await chain.mine(1);
    const tx = await chain.transferUsdc(2, merchant, 1_234_560_000n);
    const ing = await ingestor();
    for (let i = 0; i < 6; i++) {
      await ing.tick();
      await chain.mine(1);
    }
    const mine = await q("SELECT organization_id FROM payments WHERE transaction_hash = $1", [tx]);
    const theirs = (await withTenant(other.id, (c) => c.query("SELECT organization_id FROM payments WHERE transaction_hash = $1", [tx]))).rows;
    expect(mine).toEqual([{ organization_id: orgId }]);
    expect(theirs).toEqual([{ organization_id: other.id }]);
    void randomAddress;
    void pool;
  });
});
