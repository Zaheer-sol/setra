import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z, type ZodType } from "zod";
import { withTenant, type Client } from "@setra/database";
import type { Environment } from "@setra/schemas";
import { hashIp } from "@setra/security";
import { appEnv } from "@setra/config";
import { ApiError, forbidden } from "./errors";
import { viaAssistant } from "./internal";
import { actorOf, can, type Permission, type Principal } from "./principal";
import type { Actor } from "@setra/engine";

/**
 * A typed route: zod validates input (and feeds OpenAPI), the principal is resolved and checked
 * against a permission, and the handler receives a tenant-scoped context. Handlers never see
 * another organization's rows because every query runs inside withTenant().
 */

export interface Ctx<B, Q, P> {
  request: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: P;
  principal: Principal;
  organizationId: string;
  environment: Environment;
  actor: Actor;
  /** Run in a tenant-scoped transaction (row-level security enforced). */
  tx<T>(fn: (client: Client) => Promise<T>): Promise<T>;
}

interface Def<B extends ZodType, Q extends ZodType, P extends ZodType> {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  url: string;
  summary: string;
  tags: string[];
  permission: Permission;
  body?: B;
  query?: Q;
  params?: P;
  /** Console-only routes reject API keys (key management, members…). */
  sessionOnly?: boolean;
  /** POSTs that create resources honor Idempotency-Key. */
  idempotent?: boolean;
  rateLimit?: { max: number; timeWindow: string };
  /** Larger request bodies for uploads (bytes). */
  bodyLimit?: number;
  handler: (ctx: Ctx<z.infer<B>, z.infer<Q>, z.infer<P>>) => Promise<unknown>;
}

const toSchema = (schema: ZodType | undefined) => (schema ? (z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>) : undefined);

export function parse<T extends ZodType>(schema: T, value: unknown, where: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(
      422,
      "validation_error",
      result.error.issues[0] ? `${result.error.issues[0].path.join(".") || where}: ${result.error.issues[0].message}` : "The request is invalid.",
      result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }
  return result.data;
}

export function route<B extends ZodType = ZodType, Q extends ZodType = ZodType, P extends ZodType = ZodType>(app: FastifyInstance, def: Def<B, Q, P>) {
  const options: RouteShorthandOptions = {
    schema: {
      summary: def.summary,
      tags: def.tags,
      ...(def.body ? { body: toSchema(def.body) } : {}),
      ...(def.query ? { querystring: toSchema(def.query) } : {}),
      ...(def.params ? { params: toSchema(def.params) } : {}),
      security: def.sessionOnly ? [{ session: [] }] : [{ bearer: [] }, { session: [] }]
    } as never,
    config: { idempotent: def.idempotent ?? false, ...(def.rateLimit ? { rateLimit: def.rateLimit } : {}) }
  };
  app.route({
    method: def.method,
    url: def.url,
    ...options,
    ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
    handler: async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ApiError(401, "unauthenticated", "Sign in, or send a Setra API key as `Authorization: Bearer sk_…`.");
      if (def.sessionOnly && principal.kind !== "user") throw forbidden("This endpoint is only available in the Setra console.");
      if (!principal.organizationId) throw new ApiError(409, "workspace_required", "Create or choose a workspace first.");
      if (!can(principal, def.permission)) throw forbidden(principal.kind === "api_key" ? "This API key is read-only." : undefined);
      const organizationId = principal.organizationId;
      const body = def.body ? parse(def.body, request.body, "body") : (undefined as never);
      const query = def.query ? parse(def.query, request.query, "query") : (undefined as never);
      const params = def.params ? parse(def.params, request.params, "path") : (undefined as never);
      let actor = actorOf(principal, request.id, hashIp(request.ip, appEnv().sessionSecret));
      if (viaAssistant(request)) {
        // An action the user took through the Setra Assistant: same actor, channel recorded.
        const messageId = String(request.headers["x-setra-assistant-message"] ?? "").slice(0, 64);
        actor = { ...actor, label: `${actor.label ?? "user"} via Setra Assistant`, requestId: messageId ? `assistant:${messageId}` : actor.requestId };
      }
      const result = await def.handler({
        request,
        reply,
        body,
        query,
        params,
        principal,
        organizationId,
        environment: principal.environment,
        actor,
        tx: (fn) => withTenant(organizationId, fn)
      });
      if (reply.sent) return reply;
      return result;
    }
  });
}

export const idParam = z.object({ id: z.string().min(3).max(64) });
