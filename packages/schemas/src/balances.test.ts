import { describe, expect, it } from "vitest";
import { sumDecimalAmounts } from "./money";

describe("exact signed balance totals", () => {
  it("preserves sub-cent balances until after summation", () => {
    expect(sumDecimalAmounts(["0.004", "0.004", "0.004"])).toBe("0.012");
  });
  it("handles negative balances and cancellation", () => {
    expect(sumDecimalAmounts(["100.25", "-120.50"])).toBe("-20.25");
    expect(sumDecimalAmounts(["-0.000001", "0.000001"])).toBe("0.00");
  });
  it("does not lose precision beyond Number.MAX_SAFE_INTEGER", () => {
    expect(sumDecimalAmounts(["9007199254740993.000001", "0.000001"])).toBe("9007199254740993.000002");
  });
  it("returns zero for no accounts and rejects invalid balances", () => {
    expect(sumDecimalAmounts([])).toBe("0.00");
    expect(() => sumDecimalAmounts(["NaN"])).toThrow();
  });
});
