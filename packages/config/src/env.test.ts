import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appEnv, generatedEncryptionKey, parseEncryptionKey } from "./env";

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

  it("ignores surrounding whitespace from a pasted key", () => {
    expect(parseEncryptionKey(` ${key.toString("hex")}\n`)).toBe(key.toString("hex"));
  });

  it("lets production start with a base64 key and refuses a missing one", () => {
    const base = { NODE_ENV: "production", SESSION_SECRET: randomBytes(32).toString("base64"), DATABASE_URL: "postgresql://localhost/x" };
    expect(appEnv({ ...base, ENCRYPTION_KEY: key.toString("base64") }).encryptionKey).toBe(key.toString("hex"));
    expect(() => appEnv(base)).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("generatedEncryptionKey", () => {
  const base = { NODE_ENV: "production", SESSION_SECRET: randomBytes(32).toString("base64"), DATABASE_URL: "postgresql://localhost/x" };

  it("uses a generated 32-byte key directly and derives one from any other long random secret", () => {
    const key = randomBytes(32);
    expect(generatedEncryptionKey(key.toString("base64"))).toBe(key.toString("hex"));
    const derived = generatedEncryptionKey(randomBytes(48).toString("base64"));
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(generatedEncryptionKey("too short")).toBeUndefined();
  });

  it("is the fallback when ENCRYPTION_KEY is blank or invalid, and never overrides a valid one", () => {
    const generated = randomBytes(32).toString("base64");
    const explicit = randomBytes(32).toString("hex");
    expect(appEnv({ ...base, ENCRYPTION_KEY: "", ENCRYPTION_KEY_GENERATED: generated }).encryptionKey).toBe(generatedEncryptionKey(generated));
    expect(appEnv({ ...base, ENCRYPTION_KEY: "replace-with-64-hex-characters", ENCRYPTION_KEY_GENERATED: generated }).encryptionKey).toBe(generatedEncryptionKey(generated));
    expect(appEnv({ ...base, ENCRYPTION_KEY: explicit, ENCRYPTION_KEY_GENERATED: generated }).encryptionKey).toBe(explicit);
  });
});
