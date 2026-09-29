import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Marks calls the Setra Assistant makes to the API in-process (fastify.inject) on behalf of the
 * signed-in user. The token exists only in this process's memory, so an external request can't claim
 * to come from the assistant. Such calls are otherwise ordinary: same session, permissions,
 * validation, idempotency and audit; the audit label records the channel.
 */
export const ASSISTANT_TOKEN = randomBytes(32).toString("hex");

export function viaAssistant(request: FastifyRequest): boolean {
  const given = request.headers["x-setra-internal"];
  if (typeof given !== "string" || given.length !== ASSISTANT_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(ASSISTANT_TOKEN));
}
