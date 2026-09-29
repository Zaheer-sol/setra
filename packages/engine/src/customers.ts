import { networks } from "@setra/config";
import { isUniqueViolation, type Client } from "@setra/database";
import { newId, type CreateCustomerInput, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "./context";

/**
 * Customers and the wallet addresses they pay from. Validated against the workspace's own data (tenant and mode scoped) and audited.
 */

type Row = Record<string, any>;

export async function createCustomer(client: Client, organizationId: string, environment: Environment, input: CreateCustomerInput, actor: Actor): Promise<Row> {
  const id = newId("customer");
  await client.query(`INSERT INTO customers (id, organization_id, environment, name, email, external_ref, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    id,
    organizationId,
    environment,
    input.name,
    input.email ?? null,
    input.external_ref ?? null,
    JSON.stringify(input.metadata ?? {})
  ]);
  for (const a of input.wallet_addresses ?? []) await addCustomerAddress(client, organizationId, environment, id, a, actor, false);
  await audit(client, actor, { organizationId, environment, action: "customer_created", objectType: "customer", objectId: id, next: { name: input.name } });
  return (await client.query("SELECT * FROM customers WHERE id = $1", [id])).rows[0] as Row;
}

export async function addCustomerAddress(
  client: Client,
  organizationId: string,
  environment: Environment,
  customerId: string,
  input: { address: string; network: string; label?: string },
  actor: Actor,
  withAudit = true
): Promise<Row> {
  const network = networks().resolve(input.network, environment);
  if (!network) throw new EngineError("network_unavailable", `${capitalize(input.network)} isn't available in ${environment} mode.`, 422);
  const own = await client.query("SELECT 1 FROM wallets WHERE organization_id = $1 AND chain_id = $2 AND address = $3 AND archived_at IS NULL", [organizationId, network.chainId, input.address]);
  if (own.rows[0]) throw new EngineError("address_is_receiving_wallet", "That address is one of your receiving wallets, not a customer wallet.", 422);
  const id = newId("customerAddress");
  try {
    await client.query(
      `INSERT INTO customer_addresses (id, organization_id, environment, customer_id, chain_id, address, label, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, organizationId, environment, customerId, network.chainId, input.address, input.label ?? null, actor.type === "api_key" ? "api" : "manual"]
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new EngineError("address_taken", "This wallet address is already linked to a customer.", 409);
    throw error;
  }
  if (withAudit) await audit(client, actor, { organizationId, environment, action: "customer_address_added", objectType: "customer", objectId: customerId, next: { address: input.address } });
  return (await client.query("SELECT * FROM customer_addresses WHERE id = $1", [id])).rows[0] as Row;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
