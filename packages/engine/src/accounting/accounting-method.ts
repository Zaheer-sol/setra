import { type Client } from "@setra/database";
import { type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { booksSettings } from "./chart";

/** Switch between accrual and cash basis. Only possible before anything is posted, so history never changes meaning. */
export async function setAccountingMethod(client: Client, organizationId: string, environment: Environment, method: "accrual" | "cash", actor: Actor): Promise<void> {
  const before = await booksSettings(client, organizationId, environment);
  if (before.method === method) return;
  const posted = (await client.query("SELECT 1 FROM journal_entries WHERE organization_id = $1 AND environment = $2 LIMIT 1", [organizationId, environment])).rows[0];
  if (posted) throw new EngineError("books_in_use", "The accounting method can only be changed before any entries are posted. Changing it later would change the meaning of past entries.", 409);
  await client.query("UPDATE accounting_settings SET method = $3, updated_at = now() WHERE organization_id = $1 AND environment = $2", [organizationId, environment, method]);
  await audit(client, actor, { organizationId, environment, action: "accounting_method_changed", objectType: "organization", objectId: organizationId, previous: { method: before.method }, next: { method } });
}
