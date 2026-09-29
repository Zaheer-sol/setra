import { networks } from "@setra/config";
import { isUniqueViolation, type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { accountById } from "./chart";
import { ensureBooks } from "./posting-rules";

type Row = Record<string, any>;

export async function createVendor(
  client: Client,
  organizationId: string,
  environment: Environment,
  input: { name: string; email?: string | null; external_ref?: string | null; default_account_id?: string | null; notes?: string | null; wallet_addresses?: Array<{ address: string; network: string; label?: string }> },
  actor: Actor
): Promise<Row> {
  await ensureBooks(client, organizationId, environment);
  if (input.default_account_id) {
    const a = await accountById(client, organizationId, environment, input.default_account_id);
    if (!["expense", "cogs", "asset"].includes(a.type)) throw new EngineError("invalid_account", "A vendor's default account should be an expense, cost or asset account.", 422);
  }
  const id = newId("vendor");
  await client.query(`INSERT INTO vendors (id, organization_id, environment, name, email, external_ref, default_account_id, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    id,
    organizationId,
    environment,
    input.name,
    input.email ?? null,
    input.external_ref ?? null,
    input.default_account_id ?? null,
    input.notes ?? null
  ]);
  for (const a of input.wallet_addresses ?? []) await addVendorAddress(client, organizationId, environment, id, a, actor, false);
  await audit(client, actor, { organizationId, environment, action: "vendor_created", objectType: "vendor", objectId: id, next: { name: input.name } });
  return (await client.query("SELECT * FROM vendors WHERE id = $1", [id])).rows[0] as Row;
}

export async function addVendorAddress(client: Client, organizationId: string, environment: Environment, vendorId: string, input: { address: string; network: string; label?: string }, actor: Actor, withAudit = true): Promise<Row> {
  const network = networks().resolve(input.network, environment);
  if (!network) throw new EngineError("network_unavailable", `${input.network} isn't available in ${environment} mode.`, 422);
  const address = input.address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new EngineError("invalid_address", "Enter a 0x address with 40 hex characters.", 422);
  const id = newId("vendorAddress");
  try {
    await client.query(`INSERT INTO vendor_addresses (id, organization_id, environment, vendor_id, chain_id, address, label) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, organizationId, environment, vendorId, network.chainId, address, input.label ?? null]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new EngineError("address_taken", "This wallet address is already linked to a vendor.", 409);
    throw error;
  }
  if (withAudit) await audit(client, actor, { organizationId, environment, action: "vendor_address_added", objectType: "vendor", objectId: vendorId, next: { address } });
  return (await client.query("SELECT * FROM vendor_addresses WHERE id = $1", [id])).rows[0] as Row;
}

export async function vendorById(client: Client, organizationId: string, environment: Environment, vendorId: string): Promise<Row> {
  const v = (await client.query("SELECT * FROM vendors WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL", [vendorId, organizationId, environment])).rows[0] as Row | undefined;
  if (!v) throw new EngineError("vendor_not_found", "Choose a vendor from this workspace.", 404);
  return v;
}
