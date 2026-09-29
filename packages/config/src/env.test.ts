import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appEnv, parseEncryptionKey } from "./env";

describe("parseEncryptionKey", () => {
  const key = randomBytes(32);

  it("accepts 64 hexadecimal characters as is", () => {
    expect(parseEncryptionKey(key.toString("hex"))).toBe(key.toString("hex"));
  });

  it("accepts base64 and base64url of 32 bytes, returning hex", () => {
    expect(parseEncryptionKey(key.toString("base64"))).toBe(key.toString("hex"));
    expect(parseEncryptionKey(key.toString("base64url"))).toBe(key.toString("hex"));
  });

  it("rejects anything that isn't exactly 32 bytes", () => {
    expect(parseEncryptionKey(undefined)).toBeUndefined();
    expect(parseEncryptionKey("")).toBeUndefined();
    expect(parseEncryptionKey(randomBytes(16).toString("hex"))).toBeUndefined();
    expect(parseEncryptionKey(randomBytes(31).toString("base64"))).toBeUndefined();
    expect(parseEncryptionKey(randomBytes(33).toString("base64"))).toBeUndefined();
    expect(parseEncryptionKey("not a key at all, just some words")).toBeUndefined();
  });

  it("lets production start with a base64 key and refuses a missing one", () => {
    const base = { NODE_ENV: "production", SESSION_SECRET: randomBytes(32).toString("base64"), DATABASE_URL: "postgresql://localhost/x" };
    expect(appEnv({ ...base, ENCRYPTION_KEY: key.toString("base64") }).encryptionKey).toBe(key.toString("hex"));
    expect(() => appEnv(base)).toThrow(/ENCRYPTION_KEY/);
  });
});
