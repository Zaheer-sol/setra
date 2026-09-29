import { networks } from "@setra/config";
import { isUniqueViolation, type Client } from "@setra/database";
import { fromBaseUnits, MoneyError, newId, toBaseUnits, type CreateInvoiceInput, type Environment } from "@setra/schemas";
import { randomToken } from "@setra/security";
import { audit, EngineError, type Actor } from "./context";
import { accountInvoiceCancelled, accountInvoiceIssued } from "./accounting/posting-rules";

/**
 * Payment requests (invoices): create, with optional line items, and cancel. Validated against the workspace's own data (tenant and mode scoped) and audited.
 */

type Row = Record<string, any>;

export async function createInvoice(client: Client, organizationId: string, environment: Environment, input: CreateInvoiceInput, actor: Actor): Promise<Row> {
  const customer = (await client.query("SELECT * FROM customers WHERE id = $1 AND organization_id = $2 AND environment = $3 AND archived_at IS NULL", [input.customer_id, organizationId, environment])).rows[0];
  if (!customer) throw new EngineError("customer_not_found", "Choose a customer from this workspace.", 404);

  const network = networks().resolve(input.network, environment);
  if (!network) throw new EngineError("network_unavailable", `${capitalize(input.network)} isn't available in ${environment} mode.`, 422);
  const asset = network.assets.find((a) => a.symbol === input.asset);
  if (!asset) throw new EngineError("asset_unavailable", `${input.asset} isn't supported on ${network.name}.`, 422);
  if (asset.pegCurrency !== input.currency) throw new EngineError("currency_mismatch", `${asset.symbol} settles ${asset.pegCurrency} invoices only.`, 422);

  const wallet = (
    await client.query(
      `SELECT w.* FROM wallets w JOIN wallet_assets wa ON wa.wallet_id = w.id AND wa.asset_id = $4
        WHERE w.organization_id = $1 AND w.environment = $2 AND w.chain_id = $3 AND w.archived_at IS NULL ${input.wallet_id ? "AND w.id = $5" : ""}
        ORDER BY w.created_at LIMIT 1`,
      input.wallet_id ? [organizationId, environment, network.chainId, asset.id, input.wallet_id] : [organizationId, environment, network.chainId, asset.id]
    )
  ).rows[0] as Row | undefined;
  if (!wallet) {
    throw new EngineError(
      input.wallet_id ? "wallet_not_eligible" : "wallet_required",
      input.wallet_id ? `That wallet doesn't accept ${asset.symbol} on ${network.name}.` : `Add a ${network.name} receiving wallet that accepts ${asset.symbol} first.`,
      422
    );
  }

  const baseUnits = (value: string, what: string) => {
    try {
      return toBaseUnits(value, asset.decimals);
    } catch (error) {
      if (error instanceof MoneyError) throw new EngineError("invalid_amount", `${what}: ${error.message}`, 422);
      throw error;
    }
  };
  // Line items are exact integer arithmetic in base units: amount = unit_amount × quantity.
  const items = (input.line_items ?? []).map((item, position) => {
    const unit = baseUnits(item.unit_amount, `Line ${position + 1}`);
    if (unit <= 0n) throw new EngineError("invalid_amount", `Line ${position + 1}: the unit price must be greater than zero.`, 422);
    const quantity = BigInt(item.quantity ?? 1);
    return { position, description: item.description, quantity, unit, amount: unit * quantity };
  });
  const itemsTotal = items.reduce((sum, i) => sum + i.amount, 0n);
  const amountDue = input.amount !== undefined ? baseUnits(input.amount, "Amount") : itemsTotal;
  if (amountDue <= 0n) throw new EngineError("invalid_amount", "The amount must be greater than zero.", 422);
  if (items.length && itemsTotal !== amountDue) {
    throw new EngineError(
      "line_items_mismatch",
      `The line items add up to ${fromBaseUnits(itemsTotal, asset.decimals, 2)} but the amount is ${fromBaseUnits(amountDue, asset.decimals, 2)}.`,
      422
    );
  }
  if (input.expires_at && new Date(input.expires_at).getTime() <= Date.now()) throw new EngineError("invalid_expiry", "The expiration must be in the future.", 422);

  let number = input.number;
  if (!number) {
    // Continue after the highest existing INV-<n> so auto-numbering fits numbers the merchant already uses.
    const highest = await client.query<{ n: number | null }>(
      `SELECT max((regexp_match(number, '^INV-(\\d{1,9})$'))[1]::int) AS n FROM invoices WHERE organization_id = $1 AND environment = $2`,
      [organizationId, environment]
    );
    const floor = (highest.rows[0]?.n ?? 1000) + 1;
    const seq = await client.query<{ value: number }>(
      `INSERT INTO invoice_sequences (organization_id, environment, next_value) VALUES ($1, $2, $3 + 1)
       ON CONFLICT (organization_id, environment) DO UPDATE SET next_value = GREATEST(invoice_sequences.next_value, $3) + 1
       RETURNING next_value - 1 AS value`,
      [organizationId, environment, floor]
    );
    number = `INV-${seq.rows[0]!.value}`;
  }

  const id = newId("invoice");
  try {
    await client.query(
      `INSERT INTO invoices (id, organization_id, environment, customer_id, number, title, purpose, currency, asset_id, chain_id, wallet_id, amount_due, public_token, due_at, expires_at, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        organizationId,
        environment,
        customer.id,
        number,
        input.title,
        input.purpose ?? null,
        input.currency,
        asset.id,
        network.chainId,
        wallet.id,
        amountDue.toString(),
        randomToken(18),
        input.due_at ?? null,
        input.expires_at ?? null,
        JSON.stringify(input.metadata ?? {}),
        actor.id ?? null
      ]
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new EngineError("invoice_number_taken", `Invoice number ${number} is already used.`, 409);
    throw error;
  }
  for (const item of items) {
    await client.query(
      `INSERT INTO invoice_line_items (id, organization_id, invoice_id, position, description, quantity, unit_amount, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId("lineItem"), organizationId, id, item.position, item.description, item.quantity.toString(), item.unit.toString(), item.amount.toString()]
    );
  }
  await accountInvoiceIssued(client, id);
  await audit(client, actor, {
    organizationId,
    environment,
    action: "invoice_created",
    objectType: "invoice",
    objectId: id,
    next: { number, title: input.title, amount: fromBaseUnits(amountDue, asset.decimals, 2), line_items: items.length, asset: asset.symbol, network: network.key, customer_id: customer.id }
  });
  return (await client.query("SELECT i.*, w.address AS wallet_address FROM invoices i JOIN wallets w ON w.id = i.wallet_id WHERE i.id = $1", [id])).rows[0] as Row;
}

export async function cancelInvoice(client: Client, organizationId: string, invoiceId: string, reason: string | undefined, actor: Actor): Promise<Row> {
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE", [invoiceId, organizationId])).rows[0] as Row | undefined;
  if (!inv) throw new EngineError("not_found", "No such invoice.", 404);
  if (!["open", "expired"].includes(inv.status)) {
    throw new EngineError("invoice_not_cancellable", inv.status === "cancelled" ? "This invoice is already cancelled." : "Invoices with payments applied can't be cancelled.", 409);
  }
  await client.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancel_reason = $1, updated_at = now() WHERE id = $2", [reason ?? null, invoiceId]);
  await client.query("UPDATE payment_intents SET status = 'cancelled', updated_at = now() WHERE invoice_id = $1 AND status = 'open'", [invoiceId]);
  await accountInvoiceCancelled(client, invoiceId);
  await audit(client, actor, { organizationId, environment: inv.environment, action: "invoice_cancelled", objectType: "invoice", objectId: invoiceId, previous: { status: inv.status }, next: { status: "cancelled", reason } });
  return (await client.query("SELECT i.*, w.address AS wallet_address FROM invoices i JOIN wallets w ON w.id = i.wallet_id WHERE i.id = $1", [invoiceId])).rows[0] as Row;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
