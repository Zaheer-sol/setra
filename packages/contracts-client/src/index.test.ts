import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";
import { computeIntentId, intentReference, PAYMENT_INTENT_ABI } from "./index";

const artifact = join(__dirname, "../../../contracts/out/SetraPaymentIntent.sol/SetraPaymentIntent.json");

describe("contracts-client", () => {
  it("computes a stable, opaque reference", () => {
    expect(intentReference("pi_01")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(intentReference("pi_01")).toBe(intentReference("pi_01"));
    expect(intentReference("pi_01")).not.toBe(intentReference("pi_02"));
  });

  it("changes the intent id when any term, chain or contract changes", () => {
    const base = {
      merchant: "0x00000000000000000000000000000000000000aa",
      token: "0x00000000000000000000000000000000000000bb",
      amount: 2_000_000_000n,
      expiresAt: 1_760_000_000n,
      ref: intentReference("pi_01")
    } as const;
    const id = computeIntentId(10143, "0x00000000000000000000000000000000000000cc", base);
    expect(computeIntentId(143, "0x00000000000000000000000000000000000000cc", base)).not.toBe(id);
    expect(computeIntentId(10143, "0x00000000000000000000000000000000000000dd", base)).not.toBe(id);
    expect(computeIntentId(10143, "0x00000000000000000000000000000000000000cc", { ...base, amount: 1n })).not.toBe(id);
  });

  it.skipIf(!existsSync(artifact))("matches the compiled contract ABI", () => {
    const compiled = JSON.parse(readFileSync(artifact, "utf8")).abi as Array<AbiFunction | AbiEvent>;
    for (const item of PAYMENT_INTENT_ABI) {
      const match = compiled.find((c) => c.type === item.type && c.name === item.name);
      expect(match, item.name).toBeDefined();
      if (item.type === "event") expect(toEventSelector(match as AbiEvent)).toBe(toEventSelector(item as unknown as AbiEvent));
      else expect(toFunctionSelector(match as AbiFunction)).toBe(toFunctionSelector(item as unknown as AbiFunction));
    }
  });
});
