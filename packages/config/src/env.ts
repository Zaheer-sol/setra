import { createHash } from "node:crypto";
import { z } from "zod";

const DEV_SESSION_SECRET = "development-only-session-secret-do-not-use-in-production";
const DEV_ENCRYPTION_KEY = "0".repeat(63) + "1";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  PUBLIC_APP_URL: z.string().url().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  /** Address the API listens on. "::" accepts IPv6 and IPv4, for hosts whose private network is IPv6 (Railway). */
  API_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1).optional(),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  SESSION_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  /** A key the host generates (render.yaml), used when ENCRYPTION_KEY isn't set to a valid key. */
  ENCRYPTION_KEY_GENERATED: z.string().optional(),
  /** Which proxy hops may set X-Forwarded-For (proxy-addr syntax). Default: only private/loopback peers, e.g. the web proxy. */
  TRUST_PROXY: z.string().default("loopback,linklocal,uniquelocal"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_ALLOW_PRIVATE_URLS: z.string().optional(),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_BACKFILL_SAFETY_BLOCKS: z.coerce.number().int().nonnegative().default(1500),
  /** Shared secret for the Monad execution-events sidecar (POST /v1/internal/execution-events). Unset disables the endpoint. */
  EXEC_EVENTS_INGEST_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32, "EXEC_EVENTS_INGEST_TOKEN must be at least 32 characters").optional()),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("Setra <no-reply@setra.local>")
});

export type AppEnv = z.infer<typeof schema> & {
  sessionSecret: string;
  encryptionKey: string;
  publicAppUrl: string;
  isProduction: boolean;
  allowPrivateWebhookUrls: boolean;
};

let cached: AppEnv | undefined;

/**
 * A 256-bit key as 64 hex characters, or as base64 (the format hosts like Render generate). Returns
 * it as hex, or undefined when it isn't exactly 32 bytes.
 */
export function parseEncryptionKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value;
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 ? bytes.toString("hex") : undefined;
}

/**
 * The key from a host-generated secret: used directly when it's already a 32-byte key, otherwise
 * derived with SHA-256 as long as it has at least 32 characters of generated randomness.
 */
export function generatedEncryptionKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return parseEncryptionKey(value) ?? (value.length >= 32 ? createHash("sha256").update(`setra-encryption-key:${value}`).digest("hex") : undefined);
}

/**
 * Validated runtime configuration. Development gets safe local defaults; production refuses to
 * start without real secrets so a misconfigured deploy fails loudly instead of running insecurely.
 */
export function appEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  if (cached && source === process.env) return cached;
  const parsed = schema.parse(source);
  const isProduction = parsed.NODE_ENV === "production";
  const sessionSecret = parsed.SESSION_SECRET && !parsed.SESSION_SECRET.startsWith("replace-") ? parsed.SESSION_SECRET : undefined;
  const encryptionKey = parseEncryptionKey(parsed.ENCRYPTION_KEY) ?? generatedEncryptionKey(parsed.ENCRYPTION_KEY_GENERATED);
  if (isProduction) {
    if (!sessionSecret || sessionSecret.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 random characters in production");
    if (!encryptionKey) throw new Error("ENCRYPTION_KEY must be 32 random bytes in production: 64 hexadecimal characters or base64");
    if (!parsed.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
  }
  const env: AppEnv = {
    ...parsed,
    sessionSecret: sessionSecret ?? DEV_SESSION_SECRET,
    encryptionKey: encryptionKey ?? DEV_ENCRYPTION_KEY,
    publicAppUrl: parsed.PUBLIC_APP_URL ?? parsed.WEB_ORIGIN,
    isProduction,
    allowPrivateWebhookUrls: parsed.WEBHOOK_ALLOW_PRIVATE_URLS ? ["1", "true"].includes(parsed.WEBHOOK_ALLOW_PRIVATE_URLS) : !isProduction
  };
  if (source === process.env) cached = env;
  return env;
}

export function resetAppEnv(): void {
  cached = undefined;
}
