import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant } from "@setra/database";
import { sha256Hex } from "@setra/security";
import { ApiError } from "./errors";

declare module "fastify" {
  interface FastifyRequest {
    idempotency?: { key: string; organizationId: string; environment: "test" | "live" };
  }
  interface FastifyContextConfig {
    idempotent?: boolean;
  }
}

/**
 * Idempotency-Key support for creating POSTs (Stripe-style).
 *  - Same key + same request → the original response is replayed (Idempotent-Replayed: true).
 *  - Same key + different request → 422, so a key can't accidentally mean two things.
 *  - Same key while the first request is still running → 409, retry later.
 * Keys are scoped to organization + environment and kept for 24 hours.
 */
export function registerIdempotency(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || !request.routeOptions.config?.idempotent) return;
    const header = request.headers["idempotency-key"];
    if (!header || !request.principal?.organizationId) return;
    const key = String(header);
    if (key.length < 8 || key.length > 255) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 8–255 characters.");
    const { organizationId, environment } = request.principal as { organizationId: string; environment: "test" | "live" };
    const fingerprint = sha256Hex(`${request.method} ${request.routeOptions.url} ${JSON.stringify(request.body ?? {})}`);

    const existing = await withTenant(organizationId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (organization_id, environment, key, request_fingerprint, state) VALUES ($1,$2,$3,$4,'processing')
         ON CONFLICT (organization_id, environment, key) DO NOTHING RETURNING key`,
        [organizationId, environment, key, fingerprint]
      );
      if (inserted.rows[0]) return null;
      return (await client.query("SELECT * FROM idempotency_keys WHERE organization_id = $1 AND environment = $2 AND key = $3", [organizationId, environment, key])).rows[0];
    });

    if (!existing) {
      request.idempotency = { key, organizationId, environment };
      return;
    }
    if (existing.request_fingerprint !== fingerprint) {
      throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request.");
    }
    if (existing.state === "processing") {
      throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed. Retry shortly.");
    }
    reply.header("idempotent-replayed", "true");
    return reply.code(existing.response_status).send(existing.response_body);
  });

  app.addHook("onSend", async (request: FastifyRequest, reply, payload) => {
    const ctx = request.idempotency;
    if (!ctx) return payload;
    request.idempotency = undefined;
    const status = reply.statusCode;
    await withTenant(ctx.organizationId, async (client) => {
      if (status >= 500) {
        // Server errors are not cached, so the client can safely retry with the same key.
        await client.query("DELETE FROM idempotency_keys WHERE organization_id = $1 AND environment = $2 AND key = $3", [ctx.organizationId, ctx.environment, ctx.key]);
        return;
      }
      let body: unknown = null;
      try {
        body = typeof payload === "string" ? JSON.parse(payload) : payload;
      } catch {
        body = null;
      }
      await client.query(
        "UPDATE idempotency_keys SET state = 'completed', response_status = $4, response_body = $5 WHERE organization_id = $1 AND environment = $2 AND key = $3",
        [ctx.organizationId, ctx.environment, ctx.key, status, JSON.stringify(body)]
      );
    });
    return payload;
  });
}
