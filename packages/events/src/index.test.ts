import { describe, expect, it } from "vitest";
import { isRetryableStatus, retryDelayMs, sign, signatureHeader, verifySignature } from "./index";

const body = JSON.stringify({ id: "fevt_1", type: "payment.matched", data: { amount: "2000.00" } });
const now = 1_760_000_000_000;
const ts = Math.floor(now / 1000);

describe("webhook signatures", () => {
  it("verifies a valid signature", () => {
    const header = signatureHeader(["whsec_new"], ts, body);
    expect(verifySignature("whsec_new", body, String(ts), header, { now })).toBe(true);
  });

  it("rejects a tampered body (forgery)", () => {
    const header = signatureHeader(["whsec_new"], ts, body);
    expect(verifySignature("whsec_new", body.replace("2000.00", "20000.00"), String(ts), header, { now })).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = signatureHeader(["whsec_other"], ts, body);
    expect(verifySignature("whsec_new", body, String(ts), header, { now })).toBe(false);
  });

  it("rejects replays outside the tolerance window", () => {
    const old = ts - 301;
    const header = signatureHeader(["whsec_new"], old, body);
    expect(verifySignature("whsec_new", body, String(old), header, { now })).toBe(false);
  });

  it("rejects a signature bound to a different timestamp", () => {
    const header = `v1=${sign("whsec_new", ts - 10, body)}`;
    expect(verifySignature("whsec_new", body, String(ts), header, { now })).toBe(false);
  });

  it("accepts either secret during rotation", () => {
    const header = signatureHeader(["whsec_new", "whsec_old"], ts, body);
    expect(verifySignature("whsec_new", body, String(ts), header, { now })).toBe(true);
    expect(verifySignature("whsec_old", body, String(ts), header, { now })).toBe(true);
  });

  it("rejects missing headers and garbage", () => {
    expect(verifySignature("s", body, undefined, "v1=00", { now })).toBe(false);
    expect(verifySignature("s", body, String(ts), "v2=abc", { now })).toBe(false);
    expect(verifySignature("s", body, "nan", "v1=abc", { now })).toBe(false);
  });
});

describe("retry policy", () => {
  it("backs off exponentially with a cap", () => {
    expect(retryDelayMs(1, () => 1)).toBe(30_000);
    expect(retryDelayMs(2, () => 1)).toBe(60_000);
    expect(retryDelayMs(3, () => 0)).toBe(60_000);
    expect(retryDelayMs(30, () => 1)).toBe(6 * 60 * 60 * 1000);
  });
  it("retries every failure except 410 Gone", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(null)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(400)).toBe(true);
    expect(isRetryableStatus(410)).toBe(false);
  });
});
