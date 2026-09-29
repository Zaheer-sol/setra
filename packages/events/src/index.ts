import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_EVENT_NAMES, type FinancialEventType } from "@setra/schemas";

/**
 * Financial event envelopes and webhook signing.
 *
 * Signature scheme (documented in docs/webhooks.md):
 *   X-Setra-Timestamp: <unix seconds>
 *   X-Setra-Signature: v1=<hex hmac-sha256(secret, "<timestamp>.<raw body>")>[,v1=<previous secret>]
 * During secret rotation both the new and previous secret sign the payload, so receivers can roll
 * over without downtime. Receivers must reject timestamps outside a tolerance window (default 5 min).
 */

export const API_VERSION = "2026-10-01";
export const EVENT_SCHEMA_VERSION = "1.0";
export const EVENT_VERSION = 1;

export interface WebhookEnvelope<T = unknown> {
  id: string; // financial event id (fevt_…) or test id
  object: "event";
  type: string; // payment.matched, …
  api_version: string;
  created_at: string;
  livemode: boolean;
  data: T;
}

export function webhookEventName(type: FinancialEventType): string {
  return WEBHOOK_EVENT_NAMES[type];
}

export function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export function signatureHeader(secrets: string[], timestamp: number, rawBody: string): string {
  return secrets.map((s) => `v1=${sign(s, timestamp, rawBody)}`).join(",");
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  now?: number; // ms
}

/**
 * Verify a Setra webhook. Constant-time comparison; rejects stale or future timestamps.
 * This is the same function published in @setra/sdk for merchants.
 */
export function verifySignature(secret: string, rawBody: string, timestampHeader: string | undefined, signatureHeaderValue: string | undefined, options: VerifyOptions = {}): boolean {
  if (!timestampHeader || !signatureHeaderValue) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) return false;
  const tolerance = options.toleranceSeconds ?? 300;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > tolerance) return false;
  const expected = Buffer.from(sign(secret, timestamp, rawBody), "hex");
  return signatureHeaderValue
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const candidate = Buffer.from(part.slice(3), "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}

/**
 * Retry schedule: exponential backoff with full jitter, capped at 6 hours.
 * Attempt 1 → ~30s, 2 → ~1m, 3 → ~2m … 10 → capped. Total window ≈ 1.5 days with the default 10 attempts.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = 30_000 * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, 6 * 60 * 60 * 1000);
  return Math.round(capped / 2 + random() * (capped / 2));
}

/**
 * Every non-2xx response is retried (receivers often deploy a fix mid-incident), except 410 Gone,
 * which a receiver returns to say "stop sending to this endpoint".
 */
export function isRetryableStatus(status: number | null): boolean {
  return status !== 410;
}
