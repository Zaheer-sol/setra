import type { Client } from "@setra/database";
import { BUSINESS_EVENT_NAMES, newId, type BusinessEventType, type Environment } from "@setra/schemas";
import { enqueueWebhooks } from "../financial-events";
import { money } from "./reports";

type Row = Record<string, any>;

/**
 * Record business activity that isn't a payment (bills, expenses, journal entries) as a financial
 * event, with the same idempotency and webhook delivery as payment events.
 */

export async function emitBusinessEvent(
  client: Client,
  input: { organizationId: string; environment: Environment; type: BusinessEventType; dedupeKey: string; amount: bigint; vendorId?: string | null; customerId?: string | null; journalEntryId?: string | null; data: Record<string, unknown> }
): Promise<string> {
  const existing = (await client.query("SELECT id FROM financial_events WHERE organization_id = $1 AND dedupe_key = $2", [input.organizationId, input.dedupeKey])).rows[0] as Row | undefined;
  if (existing) return existing.id;
  const id = newId("financialEvent");
  const now = new Date();
  const data = {
    id,
    object: "financial_event",
    type: input.type,
    livemode: input.environment === "live",
    amount: money(input.amount),
    currency: "USD",
    journal_entry_id: input.journalEntryId ?? null,
    ...input.data,
    evidence: { rule_version: "accounting-v1.0", journal_entry_id: input.journalEntryId ?? null },
    occurred_at: now.toISOString(),
    created_at: now.toISOString()
  };
  await client.query(
    `INSERT INTO financial_events (id, organization_id, environment, type, dedupe_key, customer_id, vendor_id, journal_entry_id, amount, rule_version, data, occurred_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accounting-v1.0',$10,$11,$11)`,
    [id, input.organizationId, input.environment, input.type, input.dedupeKey, input.customerId ?? null, input.vendorId ?? null, input.journalEntryId ?? null, input.amount.toString(), JSON.stringify(data), now]
  );
  await enqueueWebhooks(client, { organizationId: input.organizationId, environment: input.environment, eventId: id, eventType: BUSINESS_EVENT_NAMES[input.type], data, createdAt: now });
  return id;
}
