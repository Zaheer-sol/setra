import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { EngineError } from "@setra/engine";

/** Consistent error envelope: { error: { code, message, request_id, details? } }. Stack traces never leave the server. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export const notFound = (what = "resource") => new ApiError(404, "not_found", `No such ${what}.`);
export const forbidden = (message = "Your role doesn't allow this action.") => new ApiError(403, "forbidden", message);

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  const requestId = request.id;
  if (error instanceof ApiError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message, request_id: requestId, ...(error.details ? { details: error.details } : {}) } });
  }
  if (error instanceof EngineError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message, request_id: requestId } });
  }
  const fe = error as FastifyError;
  if (fe.statusCode === 429) {
    return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests. Slow down and retry shortly.", request_id: requestId } });
  }
  if (fe.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || fe.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || fe.statusCode === 400 || fe.statusCode === 415) {
    return reply.code(fe.statusCode ?? 400).send({ error: { code: "invalid_request", message: "The request body could not be parsed. Send JSON with Content-Type: application/json.", request_id: requestId } });
  }
  if (fe.statusCode === 413) {
    return reply.code(413).send({ error: { code: "payload_too_large", message: "The request body is too large.", request_id: requestId } });
  }
  request.log.error({ err: { message: error.message, name: error.name, stack: error.stack } }, "unhandled error");
  return reply.code(500).send({ error: { code: "internal_error", message: "Something went wrong on our side. Your records are unchanged. Retry with the same Idempotency-Key.", request_id: requestId } });
}
