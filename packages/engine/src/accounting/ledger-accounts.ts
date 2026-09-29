import { isUniqueViolation, type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { accountById, NORMAL_BALANCE, type AccountType } from "./chart";
import { ensureBooks } from "./posting-rules";

type Row = Record<string, any>;

const SUBTYPES: Record<AccountType, string[]> = {
  asset: ["cash", "other_asset", "receivable"],
  liability: ["other_liability", "payable"],
  equity: ["equity"],
  revenue: ["revenue", "contra_revenue"],
  cogs: ["cogs"],
  expense: ["expense"]
};

export async function createLedgerAccount(
  client: Client,
  organizationId: string,
  environment: Environment,
  input: { code: string; name: string; type: AccountType; subtype?: string; description?: string | null },
  actor: Actor
): Promise<Row> {
  await ensureBooks(client, organizationId, environment);
  const subtype = input.subtype ?? SUBTYPES[input.type][0]!;
  if (!SUBTYPES[input.type].includes(subtype)) throw new EngineError("invalid_subtype", `A ${input.type} account can be: ${SUBTYPES[input.type].join(", ")}.`, 422);
  const normal = subtype === "contra_revenue" ? "debit" : NORMAL_BALANCE[input.type];
  const id = newId("ledgerAccount");
  try {
    await client.query(
      `INSERT INTO ledger_accounts (id, organization_id, environment, code, name, type, subtype, normal_balance, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, organizationId, environment, input.code, input.name, input.type, subtype, normal, input.description ?? null]
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new EngineError("account_code_taken", `Account code ${input.code} is already used.`, 409);
    throw error;
  }
  await audit(client, actor, { organizationId, environment, action: "ledger_account_created", objectType: "ledger_account", objectId: id, next: input });
  return (await client.query("SELECT * FROM ledger_accounts WHERE id = $1", [id])).rows[0] as Row;
}

export async function updateLedgerAccount(
  client: Client,
  organizationId: string,
  environment: Environment,
  accountId: string,
  input: { name?: string; code?: string; description?: string | null; archived?: boolean },
  actor: Actor
): Promise<Row> {
  const before = await accountById(client, organizationId, environment, accountId);
  if (input.archived && before.system_key) throw new EngineError("system_account", "Setra posts to this account automatically, so it can't be archived.", 409);
  if (input.archived && before.wallet_id) throw new EngineError("wallet_account", "This account mirrors a wallet. Remove the wallet instead.", 409);
  if (input.archived) {
    const bal = (await client.query<{ s: string }>("SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.status = 'posted'", [accountId])).rows[0]!.s;
    if (BigInt(bal) !== 0n) throw new EngineError("account_has_balance", "Move this account's balance to another account before archiving it.", 409);
  }
  try {
    await client.query(
      `UPDATE ledger_accounts SET name = COALESCE($2, name), code = COALESCE($3, code), description = CASE WHEN $5 THEN $4 ELSE description END,
         archived_at = CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`,
      [accountId, input.name ?? null, input.code ?? null, input.description ?? null, input.description !== undefined, input.archived ?? null]
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new EngineError("account_code_taken", `Account code ${input.code} is already used.`, 409);
    throw error;
  }
  await audit(client, actor, { organizationId, environment, action: "ledger_account_updated", objectType: "ledger_account", objectId: accountId, previous: { name: before.name, code: before.code, archived: before.archived_at !== null }, next: input });
  return (await client.query("SELECT * FROM ledger_accounts WHERE id = $1", [accountId])).rows[0] as Row;
}
