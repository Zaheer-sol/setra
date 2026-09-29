import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appEnv } from "@setra/config";
import { withGlobal, withSystem, withTenant } from "@setra/database";
import { newId, type Environment, type Role } from "@setra/schemas";
import { hashIp, randomToken, sha256Hex } from "@setra/security";
import { ApiError } from "./errors";
import type { Principal } from "./principal";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const SESSION_COOKIE = "setra_session";
const SESSION_DAYS = 14;

/** API keys: `sk_test_…` / `sk_live_…`, 32 random bytes. Only a SHA-256 hash is stored; the secret is shown once. */
export function generateApiKey(environment: Environment) {
  const secret = `sk_${environment}_${randomToken(32)}`;
  return { secret, hash: sha256Hex(secret), prefix: `${secret.slice(0, 12)}…${secret.slice(-4)}` };
}

export async function resolvePrincipal(request: FastifyRequest): Promise<Principal | undefined> {
  const authorization = request.headers.authorization;
  if (authorization) {
    const match = /^Bearer\s+(sk_(test|live)_[A-Za-z0-9_-]{20,})$/.exec(authorization.trim());
    if (!match) throw new ApiError(401, "invalid_api_key", "The Authorization header must be `Bearer sk_test_…` or `Bearer sk_live_…`.");
    const hash = sha256Hex(match[1]!);
    const key = await withSystem(async (client) => {
      const r = await client.query(
        "SELECT id, organization_id, environment, scope, name, last_used_at FROM api_keys WHERE secret_hash = $1 AND revoked_at IS NULL",
        [hash]
      );
      const row = r.rows[0];
      if (row && (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000)) {
        await client.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]);
      }
      return row;
    });
    if (!key) throw new ApiError(401, "invalid_api_key", "This API key is invalid or has been revoked.");
    return { kind: "api_key", apiKeyId: key.id, organizationId: key.organization_id, environment: key.environment, scope: key.scope, name: key.name };
  }

  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return undefined;
  const session = await withGlobal(async (client) => {
    const r = await client.query(
      `SELECT s.id, s.organization_id, s.environment, s.last_seen_at, u.id AS user_id, u.email, u.name
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256Hex(token)]
    );
    const row = r.rows[0];
    if (row && Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
      await client.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [row.id]);
    }
    return row;
  });
  if (!session) return undefined;
  let role: Role | null = null;
  let organizationId: string | null = session.organization_id;
  if (organizationId) {
    const membership = await withTenant(organizationId, (client) =>
      client.query<{ role: Role }>("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2", [organizationId, session.user_id])
    );
    role = membership.rows[0]?.role ?? null;
    if (!role) organizationId = null; // membership removed since the session chose this org
  }
  return {
    kind: "user",
    userId: session.user_id,
    email: session.email,
    name: session.name,
    sessionId: session.id,
    organizationId,
    role,
    environment: session.environment
  };
}

export async function createSession(request: FastifyRequest, reply: FastifyReply, userId: string, organizationId: string | null): Promise<void> {
  const token = randomToken(32);
  const env = appEnv();
  await withGlobal((client) =>
    client.query(
      `INSERT INTO sessions (id, user_id, token_hash, organization_id, environment, expires_at, ip_hash, user_agent)
       VALUES ($1,$2,$3,$4,'test', now() + make_interval(days => $5), $6, $7)`,
      [newId("session"), userId, sha256Hex(token), organizationId, SESSION_DAYS, hashIp(request.ip, env.sessionSecret), String(request.headers["user-agent"] ?? "").slice(0, 300)]
    )
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: SESSION_DAYS * 24 * 60 * 60
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Registers principal resolution and CSRF protection.
 * Cookie-authenticated state changes must come from the console's origin. API-key requests are
 * not ambient credentials and are exempt.
 */
export function registerAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    // Service endpoints (the execution-events sidecar) use their own shared-secret check and never
    // carry tenant credentials.
    if (request.url.startsWith("/v1/internal/")) return;
    request.principal = await resolvePrincipal(request);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const cookieAuth = !request.headers.authorization && Boolean(request.cookies?.[SESSION_COOKIE]);
    if (mutating && cookieAuth) {
      const allowed = new URL(appEnv().WEB_ORIGIN).origin;
      const origin = request.headers.origin ?? (request.headers.referer ? new URL(request.headers.referer).origin : undefined);
      if (origin !== allowed) throw new ApiError(403, "csrf_rejected", "This request didn't come from the Setra console.");
    }
  });
}
