import { describe, expect, it } from "vitest";
import { formatAmount, formatUsd, fromBaseUnits, MoneyError, toBaseUnits } from "./money";
import { hasPrefix, newId } from "./ids";

describe("toBaseUnits", () => {
  it("parses whole and fractional amounts exactly", () => {
    expect(toBaseUnits("2000", 6)).toBe(2_000_000_000n);
    expect(toBaseUnits("2000.00", 6)).toBe(2_000_000_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(toBaseUnits("1500.5", 6)).toBe(1_500_500_000n);
  });

  it("handles values far beyond Number.MAX_SAFE_INTEGER", () => {
    expect(toBaseUnits("123456789012345678901234567890.123456", 6)).toBe(123456789012345678901234567890123456n);
  });

  it("accepts trailing zeros past precision but rejects real sub-unit precision", () => {
    expect(toBaseUnits("1.5000000000", 6)).toBe(1_500_000n);
    expect(() => toBaseUnits("1.0000001", 6)).toThrow(MoneyError);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "-1", "1e6", "01", "1.", ".5", "1,000", "NaN", " 1 2"]) {
      expect(() => toBaseUnits(bad, 6), bad).toThrow(MoneyError);
    }
  });

  it("supports 0 and 18 decimals", () => {
    expect(toBaseUnits("7", 0)).toBe(7n);
    expect(toBaseUnits("1.000000000000000001", 18)).toBe(1_000_000_000_000_000_001n);
  });

  it("never loses precision where floats would (0.1 + 0.2)", () => {
    expect(toBaseUnits("0.1", 6) + toBaseUnits("0.2", 6)).toBe(toBaseUnits("0.3", 6));
  });
});

describe("formatting", () => {
  it("round-trips", () => {
    for (const v of ["0", "1", "0.000001", "2000", "1500.5", "98740.123456"]) {
      expect(fromBaseUnits(toBaseUnits(v, 6), 6)).toBe(v);
    }
  });
  it("pads cents and groups thousands", () => {
    expect(formatAmount(2_000_000_000n, 6)).toBe("2,000.00");
    expect(formatAmount("740000000", 6)).toBe("740.00");
    expect(formatUsd(-500_000_000n, 6)).toBe("-$500.00");
    expect(formatAmount(1n, 6)).toBe("0.000001");
  });
});

describe("ids", () => {
  it("are prefixed, unique and time-ordered", () => {
    const a = newId("invoice", 1_700_000_000_000);
    const b = newId("invoice", 1_700_000_000_001);
    expect(hasPrefix(a, "invoice")).toBe(true);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => newId("payment"))).size).toBe(1000);
  });
});
