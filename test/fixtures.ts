import { randomBytes } from "node:crypto";
import { withSystem, withTenant } from "../packages/database/src";
import { createCustomer, createInvoice, createOrganization, createUser, createWallet, setLogger, silentLogger, type Actor, type ObservationInput, type WalletRef } from "../packages/engine/src";
import { toBaseUnits } from "../packages/schemas/src";

setLogger(silentLogger);

export const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
export const randomHash = () => `0x${randomBytes(32).toString("hex")}`;
export const usd = (v: string) => toBaseUnits(v, 6);

export const LOCAL_USDC = (process.env.LOCAL_USDC_ADDRESS ?? "0x5fbdb2315678afecb367f032d93f642f64180aa3").toLowerCase();
export const MONAD_TESTNET_USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3";

export interface Workspace {
  orgId: string;
  userId: string;
  actor: Actor;
  wallet: WalletRef & { raw: Record<string, any> };
  customers: Record<string, { id: string; address?: string }>;
}

/** A realistic test workspace: one org, one Monad testnet wallet accepting USDC, three customers. */
export async function workspace(opts: { network?: "monad" | "local"; knownAddresses?: boolean } = {}): Promise<Workspace> {
  const user = await createUser({ email: `owner+${randomBytes(4).toString("hex")}@acme.test`, name: "Maya Chen", password: "correct horse battery" });
  const org = await createOrganization({ name: "Acme Infrastructure", ownerUserId: user.id });
  const actor: Actor = { type: "user", id: user.id, label: user.email };
  return withTenant(org.id, async (client) => {
    const wallet = await createWallet(client, org.id, "test", { name: "Main Wallet", network: opts.network ?? "monad", address: randomAddress(), assets: ["USDC"] }, actor);
    const customers: Workspace["customers"] = {};
    for (const name of ["Acme Ltd", "Nova Systems", "Studio Ten"]) {
      const address = opts.knownAddresses === false ? undefined : randomAddress();
      const c = await createCustomer(client, org.id, "test", { name, metadata: {}, wallet_addresses: address ? [{ address, network: opts.network ?? "monad" }] : [] }, actor);
      customers[name] = { id: c.id, address };
    }
    return {
      orgId: org.id,
      userId: user.id,
      actor,
      wallet: { id: wallet.id, organization_id: org.id, environment: "test", chain_id: Number(wallet.chain_id), name: wallet.name, address: wallet.address, raw: wallet },
      customers
    };
  });
}

export async function invoice(ws: Workspace, customer: string, amount: string, extra: Record<string, unknown> = {}) {
  return withTenant(ws.orgId, (client) =>
    createInvoice(client, ws.orgId, "test", { customer_id: ws.customers[customer]!.id, amount, title: `Services for ${customer}`, currency: "USD", asset: "USDC", network: ws.wallet.chain_id === 31337 ? "local" : "monad", metadata: {}, ...extra } as never, ws.actor)
  );
}

let block = 1_000_000n;
/** Build a transfer observation to the workspace wallet. */
export function transfer(ws: Workspace, amount: bigint, from: string, overrides: Partial<ObservationInput> = {}): ObservationInput {
  block += 1n;
  return {
    sourceType: "erc20_transfer",
    chainId: ws.wallet.chain_id,
    blockNumber: block,
    blockHash: randomHash(),
    transactionHash: randomHash(),
    transactionIndex: 0,
    logIndex: 0,
    tokenAddress: ws.wallet.chain_id === 31337 ? LOCAL_USDC : MONAD_TESTNET_USDC,
    fromAddress: from,
    toAddress: ws.wallet.address,
    amount,
    blockTimestamp: new Date(),
    ...overrides
  };
}

/**
 * Suites that start their own Anvil node all use chain 31337 and Anvil's deterministic accounts. Reset
 * what a previous suite in the same run left behind: its cursors (for a chain that no longer exists),
 * its wallets monitoring the same addresses, and its observations, which would otherwise be re-verified
 * by the reorg check against a node that never had those blocks.
 */
export async function resetLocalChainState() {
  await withSystem(async (c) => {
    await c.query("DELETE FROM chain_cursors WHERE chain_id = 31337");
    await c.query("DELETE FROM wallet_backfills WHERE wallet_id IN (SELECT id FROM wallets WHERE chain_id = 31337)");
    await c.query("UPDATE wallets SET monitoring_enabled = false, archived_at = now() WHERE chain_id = 31337 AND archived_at IS NULL");
    await c.query("UPDATE source_observations SET canonical = false WHERE chain_id = 31337 AND canonical AND source_type <> 'simulated'");
  });
}
