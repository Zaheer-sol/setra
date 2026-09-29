/**
 * Monetary arithmetic. Setra never uses floating point for money:
 * amounts are integer base units (bigint) internally and decimal strings at API boundaries.
 */

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Parse a decimal string ("2000.50") into base units for a token with `decimals` places. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const value = amount.trim();
  if (!DECIMAL.test(value)) throw new MoneyError(`"${amount}" is not a valid decimal amount`);
  const [whole, fraction = ""] = value.split(".") as [string, string?];
  const frac = fraction ?? "";
  if (frac.length > decimals) {
    // Allow trailing zeros beyond precision ("1.500000000" for 6 decimals), reject real sub-unit precision.
    if (/[^0]/.test(frac.slice(decimals))) throw new MoneyError(`"${amount}" has more than ${decimals} decimal places`);
  }
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + (padded ? BigInt(padded) : 0n);
}

/** Format base units as an exact decimal string. `minFraction` pads the fraction (e.g. 2 for cents). */
export function fromBaseUnits(value: bigint | string, decimals: number, minFraction = 0): string {
  const units = typeof value === "string" ? BigInt(value) : value;
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = decimals > 0 ? (abs % base).toString().padStart(decimals, "0") : "";
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

/** Sum signed decimal balances exactly, including sub-cent values. */
export function sumDecimalAmounts(amounts: readonly string[], decimals = 6): string {
  const total = amounts.reduce((sum, amount) => {
    const negative = amount.startsWith("-");
    const units = toBaseUnits(negative ? amount.slice(1) : amount, decimals);
    return sum + (negative ? -units : units);
  }, 0n);
  return fromBaseUnits(total, decimals, 2);
}

/** Human display: "2,000.00". Exact, groups digits on the decimal string, never converts to Number. */
export function formatAmount(value: bigint | string, decimals: number, minFraction = 2): string {
  const exact = fromBaseUnits(value, decimals, minFraction);
  const negative = exact.startsWith("-");
  const [whole, fraction] = (negative ? exact.slice(1) : exact).split(".") as [string, string?];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function formatUsd(value: bigint | string, decimals: number): string {
  const formatted = formatAmount(value, decimals, 2);
  return formatted.startsWith("-") ? `-$${formatted.slice(1)}` : `$${formatted}`;
}

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
