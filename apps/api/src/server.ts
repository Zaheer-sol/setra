import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { appEnv, networks } from "@setra/config";
import { pool, withGlobal, withSystem } from "@setra/database";
import { newId } from "@setra/schemas";
import { REDACTED_KEYS } from "@setra/security";
import { registerAuth } from "./lib/auth";
import { errorHandler } from "./lib/errors";
import { registerIdempotency } from "./lib/idempotency";
import { authRoutes } from "./routes/auth";
import { customerRoutes } from "./routes/customers";
import { developerRoutes } from "./routes/developers";
import { invoiceRoutes } from "./routes/invoices";
import { inboundOrderRoutes, orderRoutes } from "./routes/orders";
import { organizationRoutes } from "./routes/organization";
import { paymentRoutes } from "./routes/payments";
import { executionStreams } from "@setra/engine";
import { internalRoutes } from "./routes/internal";
import { assistantRoutes } from "./routes/assistant";
import { publicRoutes } from "./routes/public";
import { reportingRoutes } from "./routes/reporting";
import { accountingRoutes } from "./routes/accounting";
import { walletRoutes } from "./routes/wallets";

export async function buildServer(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const env = appEnv();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]', ...REDACTED_KEYS.map((k) => `body.${k}`)], censor: "[redacted]" }
          },
    genReqId: () => newId("request"),
    requestIdHeader: "x-request-id",
    trustProxy: env.TRUST_PROXY === "true" ? true : env.TRUST_PROXY === "false" ? false : env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { strict: false } }
  });

  // Validation is done with zod inside each route; JSON schemas exist for OpenAPI only.
  app.setValidatorCompiler(() => () => true);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: "not_found", message: `No route for ${request.method} ${request.url}.`, request_id: request.id } }));

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    // Limit per credential when authenticated, per IP otherwise.
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      if (auth) return `key:${auth.slice(-16)}`;
      const session = request.cookies?.setra_session;
      return session ? `ses:${session.slice(-16)}` : `ip:${request.ip}`;
    },
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      error: { code: "rate_limited", message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`, request_id: request.id }
    })
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Setra API",
        version: "2026-10-01",
        description:
          "Stablecoin payment operations on Monad: invoices, payments, matching, exceptions, reconciliation, financial events and webhooks. Amounts are decimal strings. Test keys (sk_test_) operate on Monad testnet; live keys (sk_live_) on Monad mainnet."
      },
      servers: [{ url: "/", description: "This server" }],
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", description: "Setra API key: sk_test_… or sk_live_…" },
          session: { type: "apiKey", in: "cookie", name: "setra_session" }
        }
      },
      tags: [
        { name: "invoices" },
        { name: "payments" },
        { name: "exceptions" },
        { name: "customers" },
        { name: "wallets" },
        { name: "reporting" },
        { name: "financial-events" },
        { name: "webhooks" },
        { name: "payment-intents" },
        { name: "test-mode" },
        { name: "api-keys" },
        { name: "organization" },
        { name: "auth" },
        { name: "public" }
      ]
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list", deepLinking: true } });

  registerAuth(app);
  registerIdempotency(app);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });

  // Liveness: the process is up. Readiness: it can serve (database reachable).
  // /v1/health: whether the system is actually working (ingestion progressing, webhooks flowing).
  // Add ?strict=true for uptime monitors: any degraded check returns 503, which is an alert.
  app.get("/v1/health/live", { schema: { tags: ["organization"], summary: "Liveness probe" } }, async () => ({ status: "ok" }));
  app.get("/v1/health/ready", { schema: { tags: ["organization"], summary: "Readiness probe (database reachable)" } }, async (_request, reply) => {
    try {
      await pool().query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable", checks: { database: "unavailable" } });
    }
  });
  app.get("/v1/health", { schema: { tags: ["organization"], summary: "System health: database, ingestion per network, webhook delivery" } }, async (request, reply) => {
    const strict = ["1", "true"].includes(String((request.query as Record<string, string>)?.strict ?? ""));
    const checks: Record<string, unknown> = {};
    const problems: string[] = [];
    try {
      await pool().query("SELECT 1");
      checks.database = "ok";
    } catch {
      checks.database = "unavailable";
      problems.push("database");
    }
    try {
      const cursors = await withGlobal((c) => c.query("SELECT chain_id, stage, block_number, head_block_number, updated_at, last_error FROM chain_cursors ORDER BY chain_id, stage"));
      checks.ingestion = networks()
        .enabled()
        .map((n) => {
          const settled = cursors.rows.find((r) => Number(r.chain_id) === n.chainId && r.stage === "settled");
          const age = settled ? Date.now() - new Date(settled.updated_at).getTime() : null;
          const status = !settled || Number(settled.block_number) < 0 ? "not_started" : settled.last_error ? "error" : age! > 30_000 ? "delayed" : "ok";
          if (status !== "ok") problems.push(`ingestion:${n.key}:${status}`);
          return {
            network: n.key,
            chain_id: n.chainId,
            settled_block: settled && Number(settled.block_number) >= 0 ? String(settled.block_number) : null,
            head_block: settled?.head_block_number ? String(settled.head_block_number) : null,
            seconds_since_progress: age === null ? null : Math.round(age / 1000),
            last_error: settled?.last_error ?? null,
            status
          };
        });
    } catch {
      checks.ingestion = "unknown";
      problems.push("ingestion");
    }
    try {
      const w = (
        await withSystem((c) =>
          c.query(`SELECT
              count(*) FILTER (WHERE status IN ('pending','retrying') AND next_attempt_at <= now())::int AS due,
              COALESCE(EXTRACT(EPOCH FROM now() - min(next_attempt_at) FILTER (WHERE status IN ('pending','retrying') AND next_attempt_at <= now())), 0)::int AS oldest_due_seconds,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '1 hour')::int AS failed_last_hour,
              count(*) FILTER (WHERE status = 'delivered' AND delivered_at > now() - interval '1 hour')::int AS delivered_last_hour
            FROM webhook_deliveries`)
        )
      ).rows[0];
      // A due delivery waiting more than two minutes means the delivery worker isn't running.
      const status = w.oldest_due_seconds > 120 ? "stalled" : "ok";
      if (status !== "ok") problems.push(`webhooks:${status}`);
      checks.webhooks = { status, ...w };
    } catch {
      checks.webhooks = "unknown";
    }
    // Execution events are an acceleration, not a dependency: RPC ingestion covers everything, so an
    // offline or recovering sidecar is a warning, never a failure.
    const warnings: string[] = [];
    try {
      const streams = await executionStreams();
      checks.execution_events = { enabled: Boolean(env.EXEC_EVENTS_INGEST_TOKEN), streams };
      for (const st of streams) if (st.status !== "live") warnings.push(`execution_events:${st.network ?? st.chain_id}:${st.status}`);
    } catch {
      checks.execution_events = "unknown";
    }
    const ok = problems.length === 0;
    const code = checks.database !== "ok" || (strict && !ok) ? 503 : 200;
    return reply.code(code).send({ status: ok ? "ok" : "degraded", problems, warnings, version: "2026-10-01", time: new Date().toISOString(), checks });
  });

  authRoutes(app);
  organizationRoutes(app);
  walletRoutes(app);
  customerRoutes(app);
  invoiceRoutes(app);
  orderRoutes(app);
  // Its own scope: a JSON parser that keeps the raw body, for signature checks, without touching other routes.
  app.register(inboundOrderRoutes);
  paymentRoutes(app);
  reportingRoutes(app);
  accountingRoutes(app);
  developerRoutes(app);
  publicRoutes(app);
  internalRoutes(app);
  assistantRoutes(app);

  app.get("/openapi.json", { schema: { hide: true } as never }, async () => app.swagger());
  return app;
}
