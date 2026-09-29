import { withSystem } from "@setra/database";
import { newId } from "@setra/schemas";
import { log } from "./context";

/**
 * Periodic maintenance. Expiry changes status only for invoices with no payment applied; a partially
 * paid invoice stays partially paid. Nothing here deletes financial history.
 */
export async function runHousekeeping(): Promise<{ expiredInvoices: number; expiredIntents: number; purgedIdempotencyKeys: number }> {
  return withSystem(async (client) => {
    const invoices = await client.query(
      `UPDATE invoices SET status = 'expired', updated_at = now()
        WHERE status = 'open' AND amount_paid = 0 AND expires_at IS NOT NULL AND expires_at < now() RETURNING id, organization_id, environment`
    );
    for (const inv of invoices.rows) {
      await client.query(
        `INSERT INTO audit_logs (id, organization_id, environment, actor_type, actor_id, actor_label, action, object_type, object_id, previous_state, new_state)
         VALUES ($1,$2,$3,'system','setra','Setra','invoice_expired','invoice',$4,'{"status":"open"}','{"status":"expired"}')`,
        [newId("auditLog"), inv.organization_id, inv.environment, inv.id]
      );
    }
    const intents = await client.query(`UPDATE payment_intents SET status = 'expired', updated_at = now() WHERE status = 'open' AND expires_at < now()`);
    const keys = await client.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    if (invoices.rowCount) log().info("invoices_expired", { count: invoices.rowCount });
    return { expiredInvoices: invoices.rowCount ?? 0, expiredIntents: intents.rowCount ?? 0, purgedIdempotencyKeys: keys.rowCount ?? 0 };
  });
}
