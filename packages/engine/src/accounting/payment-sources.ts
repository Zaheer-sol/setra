import { type Client } from "@setra/database";
import { type Environment } from "@setra/schemas";
import { EngineError } from "../context";
import { accountById, systemAccount } from "./chart";

type Row = Record<string, any>;

export async function spendAccount(client: Client, organizationId: string, environment: Environment, accountId: string | null | undefined, vendor: Row | null): Promise<Row> {
  const id = accountId ?? vendor?.default_account_id ?? (await systemAccount(client, organizationId, environment, "general_expense")).id;
  const a = await accountById(client, organizationId, environment, id);
  if (!["expense", "cogs", "asset"].includes(a.type) || a.subtype === "cash") throw new EngineError("invalid_account", "Choose an expense, cost of goods or (non-cash) asset account.", 422);
  if (a.archived_at) throw new EngineError("account_archived", `Account ${a.code} is archived.`, 422);
  return a;
}

/** A transfer from a monitored wallet that can back an expense, bill payment or classification (not already used). */
export async function usableTransfer(client: Client, organizationId: string, environment: Environment, transferId: string): Promise<Row> {
  const t = (await client.query("SELECT * FROM outgoing_transfers WHERE id = $1 AND organization_id = $2 AND environment = $3 FOR UPDATE", [transferId, organizationId, environment])).rows[0] as Row | undefined;
  if (!t) throw new EngineError("transfer_not_found", "Choose an outgoing transfer from your wallets in this mode.", 404);
  if (!t.canonical) throw new EngineError("transfer_not_canonical", "That transfer is no longer part of the chain.", 409);
  if (!t.asset_id) throw new EngineError("transfer_unsupported_token", "That transfer isn't in a supported stablecoin.", 422);
  const used = await client.query(
    `SELECT 'refund' AS k FROM refunds WHERE outgoing_transfer_id = $1
     UNION ALL SELECT 'bill payment' FROM bill_payments WHERE outgoing_transfer_id = $1
     UNION ALL SELECT 'expense' FROM expenses WHERE outgoing_transfer_id = $1 AND status <> 'rejected'
     UNION ALL SELECT 'classification' FROM transaction_classifications WHERE outgoing_transfer_id = $1 AND reversed_at IS NULL`,
    [transferId]
  );
  if (used.rows[0]) throw new EngineError("transfer_already_used", `That transfer is already recorded as a ${used.rows[0].k}.`, 409);
  const own = (await client.query("SELECT 1 FROM wallets WHERE organization_id = $1 AND environment = $2 AND chain_id = $3 AND address = $4", [organizationId, environment, t.chain_id, t.to_address])).rows[0];
  if (own) throw new EngineError("internal_transfer", "That transfer went to one of your own wallets; it's an internal transfer, not spending.", 422);
  return t;
}

export async function paidFromAccount(client: Client, organizationId: string, environment: Environment, accountId: string): Promise<Row> {
  const a = await accountById(client, organizationId, environment, accountId);
  if (a.wallet_id) throw new EngineError("use_transfer", "For money paid from a monitored wallet, link the onchain transfer instead, so the wallet balance stays exact.", 422);
  if (!(a.subtype === "cash" || a.type === "equity" || a.type === "liability")) throw new EngineError("invalid_account", "Pay from a bank/cash account, an owner's equity account (paid personally) or a liability account (card, loan).", 422);
  return a;
}
