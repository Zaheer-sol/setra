import type { Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";

/** Who is performing an action. Every write that changes business state records one. */
export interface Actor {
  type: "user" | "api_key" | "system";
  id?: string | null;
  label?: string | null;
  requestId?: string | null;
  ipHash?: string | null;
}

export const SYSTEM: Actor = { type: "system", id: "setra", label: "Setra" };

export type LogFields = Record<string, unknown>;
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const write = (level: string) => (event: string, fields: LogFields = {}) =>
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ time: new Date().toISOString(), level, service: process.env.SETRA_SERVICE ?? "setra", event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  );

export const consoleLogger: Logger = { info: write("info"), warn: write("warn"), error: write("error") };
export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let activeLogger: Logger = consoleLogger;
export function setLogger(logger: Logger): void {
  activeLogger = logger;
}
export function log(): Logger {
  return activeLogger;
}

export interface AuditEntry {
  organizationId: string;
  environment?: Environment | null;
  action: string;
  objectType: string;
  objectId: string;
  previous?: unknown;
  next?: unknown;
}

/** Append an audit record. Audit logs are append-only at the database level. */
export async function audit(client: Client, actor: Actor, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, organization_id, environment, actor_type, actor_id, actor_label, action, object_type, object_id, previous_state, new_state, request_id, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      newId("auditLog"),
      entry.organizationId,
      entry.environment ?? null,
      actor.type,
      actor.id ?? null,
      actor.label ?? null,
      entry.action,
      entry.objectType,
      entry.objectId,
      entry.previous === undefined ? null : JSON.stringify(entry.previous, bigintReplacer),
      entry.next === undefined ? null : JSON.stringify(entry.next, bigintReplacer),
      actor.requestId ?? null,
      actor.ipHash ?? null
    ]
  );
}

export const bigintReplacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "EngineError";
  }
}
