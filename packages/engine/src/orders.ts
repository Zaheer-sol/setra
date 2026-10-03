import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { newId, toBaseUnits, type CreateInvoiceInput, type Environment, type OrderInput } from "@setra/schemas";
import { audit, EngineError, type Actor } from "./context";
import { createCustomer } from "./customers";
import { cancelInvoice, createInvoice } from "./invoices";

/**
 * Orders from the merchant's own system. The merchant (or their store, checkout or processor) tells
 * Setra what it expects to be paid, keyed by its own order ID, and never opens Setra to create an
 * invoice. Each order is kept as an invoice, so matching, accounting and exceptions are unchanged.
 *
 * Sending an order is idempotent: the same order again changes nothing; a new amount replaces the
 * order while nothing has been paid against it; status "cancelled" cancels it.
 */

type Row = Record<string, any>;

export type OrderOutcome = "created" | "updated" | "unchanged" | "cancelled" | "ignored";

export interface OrderResult {
  outcome: OrderOutcome;
  invoice: Row | null;
  detail?: string;
}

/** The live (not cancelled) invoice for a merchant order ID, if any. */
export async function findOrder(client: Client, organizationId: string, environment: Environment, externalId: string, lock = false): Promise<Row | undefined> {
  return (
    await client.query(
      `SELECT * FROM invoices WHERE organization_id = $1 AND environment = $2 AND external_id = $3 AND status <> 'cancelled' ${lock ? "FOR UPDATE" : ""}`,
      [organizationId, environment, externalId]
    )
  ).rows[0] as Row | undefined;
}

/** The customer an order is for: by Setra ID, by the merchant's own reference, or by email; created if new. */
async function resolveCustomer(client: Client, organizationId: string, environment: Environment, input: OrderInput, actor: Actor): Promise<Row> {
  if (input.customer_id) {
    const c = (await client.query("SELECT * FROM customers WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL", [input.customer_id, organizationId, environment])).rows[0] as Row | undefined;
    if (!c) throw new EngineError("customer_not_found", "Choose a customer from this workspace.", 404);
    return c;
  }
  const given = input.customer ?? { wallet_addresses: [] };
  let customer: Row | undefined;
  if (given.external_ref) {
    customer = (
      await client.query("SELECT * FROM customers WHERE organization_id = $1 AND environment = $2 AND external_ref = $3 AND archived_at IS NULL ORDER BY created_at LIMIT 1", [organizationId, environment, given.external_ref])
    ).rows[0] as Row | undefined;
  }
  if (!customer && given.email && !given.external_ref) {
    customer = (await client.query("SELECT * FROM customers WHERE organization_id = $1 AND environment = $2 AND lower(email) = $3 AND archived_at IS NULL ORDER BY created_at LIMIT 1", [organizationId, environment, given.email])).rows[0] as
      | Row
      | undefined;
  }
  if (!customer) {
    return createCustomer(
      client,
      organizationId,
      environment,
      {
        name: given.name ?? given.email ?? `Customer ${given.external_ref}`,
        email: given.email,
        external_ref: given.external_ref,
        // Wallets already linked elsewhere are left where they are (see below).
        wallet_addresses: await unclaimed(client, organizationId, environment, given.wallet_addresses),
        metadata: {}
      },
      actor
    );
  }
  // Known customer: fill in what the merchant's system now knows, never overwrite what's there.
  if (given.email && !customer.email) await client.query("UPDATE customers SET email = $1, updated_at = now() WHERE id = $2", [given.email, customer.id]);
  for (const w of await unclaimed(client, organizationId, environment, given.wallet_addresses)) {
    const network = networks().resolve(w.network, environment)!;
    await client.query(
      "INSERT INTO customer_addresses (id, organization_id, environment, customer_id, chain_id, address, source) SELECT $1,$2,$3,$4,$5,$6,'api' WHERE NOT EXISTS (SELECT 1 FROM customer_addresses WHERE organization_id = $2 AND chain_id = $5 AND address = $6)",
      [newId("customerAddress"), organizationId, environment, customer.id, network.chainId, w.address]
    );
  }
  return customer;
}

/** Wallet addresses not yet linked to any customer or used as a receiving wallet (linking them twice would be refused). */
type WalletInput = { address: `0x${string}`; network: "monad" | "base" | "local" };
async function unclaimed(client: Client, organizationId: string, environment: Environment, wallets: WalletInput[]): Promise<WalletInput[]> {
  const out: WalletInput[] = [];
  for (const w of wallets) {
    const network = networks().resolve(w.network, environment);
    if (!network) continue;
    const taken = await client.query(
      "SELECT 1 FROM customer_addresses WHERE organization_id = $1 AND chain_id = $2 AND address = $3 UNION SELECT 1 FROM wallets WHERE organization_id = $1 AND chain_id = $2 AND address = $3 AND archived_at IS NULL",
      [organizationId, network.chainId, w.address.toLowerCase()]
    );
    if (!taken.rows[0]) out.push({ ...w, address: w.address.toLowerCase() as `0x${string}` });
  }
  return out;
}

/** The amount an order asks for, in base units of its asset (to tell an unchanged order from an updated one). */
function expectedUnits(input: OrderInput, environment: Environment): bigint {
  const network = networks().resolve(input.network, environment);
  const asset = network?.assets.find((a) => a.symbol === input.asset);
  if (!network || !asset) throw new EngineError("asset_unavailable", `${input.asset} isn't supported on ${input.network} in ${environment} mode.`, 422);
  if (input.amount !== undefined) return toBaseUnits(input.amount, asset.decimals);
  return (input.line_items ?? []).reduce((sum, li) => sum + toBaseUnits(li.unit_amount, asset.decimals) * BigInt(li.quantity ?? 1), 0n);
}

/** Create, update or cancel an order from the merchant's system. */
export async function upsertOrder(client: Client, organizationId: string, environment: Environment, input: OrderInput, actor: Actor, source: { id: string } | null = null): Promise<OrderResult> {
  // Serialize concurrent deliveries of the same order (a store often sends "created" and "updated" together).
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`order:${organizationId}:${environment}:${input.external_id}`]);
  const existing = await findOrder(client, organizationId, environment, input.external_id, true);

  if (input.status === "cancelled") {
    if (!existing) return { outcome: "ignored", invoice: null, detail: "There's no open order with this ID to cancel." };
    if (!["open", "expired"].includes(existing.status)) return { outcome: "unchanged", invoice: existing, detail: "Payments are already applied to this order, so it stays as it is." };
    return { outcome: "cancelled", invoice: await cancelInvoice(client, organizationId, existing.id, "Cancelled in the merchant's system", actor) };
  }

  const amount = expectedUnits(input, environment);
  if (existing) {
    const asset = networks().asset(existing.asset_id)?.asset;
    const same = BigInt(existing.amount_due) === amount && asset?.symbol === input.asset;
    if (same) return { outcome: "unchanged", invoice: existing };
    const untouched = existing.status === "open" && BigInt(existing.amount_paid) === 0n && BigInt(existing.amount_written_off ?? 0) === 0n;
    const confirming = (await client.query("SELECT 1 FROM payments WHERE invoice_id = $1 OR provisional_invoice_id = $1 LIMIT 1", [existing.id])).rows[0];
    if (!untouched || confirming) {
      throw new EngineError("order_has_payments", `Order ${input.external_id} already has a payment against it, so its amount can't change. Cancel it in Setra or issue a credit note instead.`, 409);
    }
    await cancelInvoice(client, organizationId, existing.id, "Replaced by an updated order from the merchant's system", actor);
  }

  const customer = await resolveCustomer(client, organizationId, environment, input, actor);
  // Use the merchant's order number when it's free; otherwise fall back to Setra's numbering.
  let number = input.number;
  if (number && (await client.query("SELECT 1 FROM invoices WHERE organization_id = $1 AND environment = $2 AND number = $3", [organizationId, environment, number])).rows[0]) number = undefined;
  const invoiceInput: CreateInvoiceInput = {
    customer_id: customer.id,
    number,
    title: input.title ?? `Order ${input.number ?? input.external_id}`,
    purpose: input.purpose,
    line_items: input.line_items,
    amount: input.amount,
    currency: input.currency,
    asset: input.asset,
    network: input.network,
    wallet_id: input.wallet_id,
    due_at: input.due_at,
    expires_at: input.expires_at,
    metadata: input.metadata
  };
  const invoice = await createInvoice(client, organizationId, environment, invoiceInput, actor, { externalId: input.external_id, orderSourceId: source?.id ?? null });
  await audit(client, actor, {
    organizationId,
    environment,
    action: existing ? "order_updated" : "order_received",
    objectType: "invoice",
    objectId: invoice.id,
    previous: existing ? { invoice_id: existing.id, amount_due: existing.amount_due } : undefined,
    next: { external_id: input.external_id, amount_due: invoice.amount_due }
  });
  return { outcome: existing ? "updated" : "created", invoice };
}
