import type { Actor } from "@setra/engine";
import type { Environment, Role } from "@setra/schemas";
import { forbidden } from "./errors";

/** The authenticated caller. Every request resolves to exactly one organization and one environment. */
export type Principal =
  | {
      kind: "user";
      userId: string;
      email: string;
      name: string;
      sessionId: string;
      organizationId: string | null;
      role: Role | null;
      environment: Environment;
    }
  | {
      kind: "api_key";
      apiKeyId: string;
      organizationId: string;
      environment: Environment;
      scope: "read_write" | "read_only";
      name: string;
    };

export type Permission =
  | "read"
  | "customers:write"
  | "invoices:write"
  | "wallets:write"
  | "exceptions:resolve"
  | "webhooks:write"
  | "api_keys:write"
  | "api_keys:write_live"
  | "members:write"
  | "organization:write"
  | "simulate"
  /** See the books: ledger, journal, reports. */
  | "financials:read"
  /** Draft manual journal entries; record vendors, bills, expenses; classify transactions. */
  | "financials:write"
  /** Approve and post: journal entries, bills, expenses, bill payments, reversals. */
  | "financials:approve"
  /** Chart of accounts, accounting periods, accounting method, repairing the books. */
  | "financials:manage";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["read", "customers:write", "invoices:write", "wallets:write", "exceptions:resolve", "webhooks:write", "api_keys:write", "api_keys:write_live", "members:write", "organization:write", "simulate", "financials:read", "financials:write", "financials:approve", "financials:manage"],
  admin: ["read", "customers:write", "invoices:write", "wallets:write", "exceptions:resolve", "webhooks:write", "api_keys:write", "api_keys:write_live", "members:write", "organization:write", "simulate", "financials:read", "financials:write", "financials:approve", "financials:manage"],
  operator: ["read", "customers:write", "invoices:write", "exceptions:resolve", "simulate", "financials:read", "financials:write"],
  // An outside accountant or bookkeeper: the books, invoices and exceptions; not wallets, developer
  // settings, API keys, members or workspace settings.
  accountant: ["read", "invoices:write", "exceptions:resolve", "financials:read", "financials:write", "financials:approve", "financials:manage"],
  // Developers build integrations; they don't see the company's books.
  developer: ["read", "customers:write", "invoices:write", "webhooks:write", "api_keys:write", "simulate"],
  viewer: ["read", "financials:read"]
};

/** What an API key may do. Keys never manage keys, members or organization settings. */
const KEY_PERMISSIONS: Record<"read_write" | "read_only", Permission[]> = {
  // Keys can read the books and record facts, but approving and posting stays with people.
  read_write: ["read", "customers:write", "invoices:write", "wallets:write", "exceptions:resolve", "webhooks:write", "simulate", "financials:read", "financials:write"],
  read_only: ["read", "financials:read"]
};

export function can(principal: Principal, permission: Permission): boolean {
  if (principal.kind === "api_key") return KEY_PERMISSIONS[principal.scope].includes(permission);
  if (!principal.role) return false;
  return ROLE_PERMISSIONS[principal.role].includes(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function actorOf(principal: Principal, requestId: string, ipHash: string | null): Actor {
  return principal.kind === "user"
    ? { type: "user", id: principal.userId, label: principal.email, requestId, ipHash }
    : { type: "api_key", id: principal.apiKeyId, label: principal.name, requestId, ipHash };
}

/** Throw a 403 with a plain explanation unless the caller has the permission. */
export function requirePermission(principal: Principal, permission: Parameters<typeof can>[1], message: string) {
  if (!can(principal, permission)) throw forbidden(message);
}
