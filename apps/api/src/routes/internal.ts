import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { appEnv } from "@setra/config";
import { executionWatchlist, ExecutionEventsError, ingestExecutionBatch } from "@setra/engine";
import { ApiError } from "../lib/errors";
import { parse } from "../lib/route";

/**
 * Service-to-service endpoints for the Monad execution-events sidecar. Authenticated with a shared
 * secret (EXEC_EVENTS_INGEST_TOKEN); absent configuration disables them (404). Not part of the
 * public API or its OpenAPI document.
 */

const hex = (bytes?: number) => z.string().regex(bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]*$/);
const u64 = z.number().int().nonnegative();
/** 64-bit nanosecond timestamps arrive as decimal strings (they exceed JavaScript's exact integer range). */
const ns = z.string().regex(/^\d{1,20}$/, "Nanosecond timestamps are decimal strings");

const logSignal = z.object({
  kind: z.literal("log"),
  seqno: u64,
  chain_id: u64,
  block_number: u64,
  block_id: hex(32),
  block_hash: hex(32),
  block_timestamp: u64,
  transaction_hash: hex(32),
  transaction_index: u64,
  log_index: u64,
  address: hex(20),
  topics: z.array(hex(32)).min(1).max(4),
  data: hex().max(64 * 1024),
  executed_at_ns: ns,
  block_executed_at_ns: ns.optional(),
  emitted_at_ns: ns.optional()
});
const blockStateSignal = z.object({
  kind: z.literal("block_state"),
  seqno: u64,
  chain_id: u64,
  block_number: u64,
  block_id: hex(32).nullable(),
  state: z.enum(["voted", "finalized", "verified", "rejected"]),
  recorded_at_ns: ns,
  emitted_at_ns: ns.optional()
});
const gapSignal = z.object({
  kind: z.literal("gap"),
  reason: z.enum(["sequence_gap", "sequence_discontinuity", "payload_expired", "incomplete_block", "sidecar_start", "delivery_backlog"]),
  chain_id: u64.nullable(),
  last_complete_block: u64.nullable(),
  last_seqno: u64.nullable(),
  emitted_at_ns: ns.optional()
});
const batchSchema = z.object({
  chain_id: u64,
  sidecar_id: z.string().min(1).max(120),
  stats: z
    .object({
      events_consumed: u64.optional(),
      events_relevant: u64.optional(),
      payment_signals: u64.optional(),
      gaps: u64.optional(),
      last_seqno: u64.nullable().optional(),
      last_block_number: u64.nullable().optional()
    })
    .passthrough()
    .optional(),
  signals: z.array(z.discriminatedUnion("kind", [logSignal, blockStateSignal, gapSignal])).max(1000)
});

function authorize(request: FastifyRequest) {
  const expected = appEnv().EXEC_EVENTS_INGEST_TOKEN;
  if (!expected) throw new ApiError(404, "not_found", "Execution events ingestion is not enabled on this deployment.");
  const header = request.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(401, "unauthorized", "Invalid execution events token.");
}

const mapError = (error: unknown) => {
  if (error instanceof ExecutionEventsError) throw new ApiError(error.code === "network_not_monitored" ? 422 : 400, error.code, error.message);
  throw error;
};

export function internalRoutes(app: FastifyInstance) {
  app.post(
    "/v1/internal/execution-events",
    { bodyLimit: 2 * 1024 * 1024, config: { rateLimit: { max: 12_000, timeWindow: "1 minute" } }, schema: { hide: true } },
    async (request) => {
      authorize(request);
      const batch = parse(batchSchema, request.body, "body");
      return ingestExecutionBatch(batch as never).catch(mapError);
    }
  );

  app.get("/v1/internal/execution-events/watchlist", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } }, schema: { hide: true } }, async (request) => {
    authorize(request);
    const { chain_id } = parse(z.object({ chain_id: z.coerce.number().int().positive() }), request.query, "query");
    return executionWatchlist(chain_id).catch(mapError);
  });
}
