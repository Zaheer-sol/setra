/** Formatting helpers. Amounts arrive from the API as exact decimal strings and are never parsed to floats. */

export function money(decimal: string | null | undefined, opts: { currency?: boolean; sign?: boolean } = {}): string {
  if (decimal === null || decimal === undefined) return "-";
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fraction.replace(/0+$/, "").padEnd(2, "0");
  const body = `${opts.currency === false ? "" : "$"}${grouped}.${frac}`;
  return `${negative ? "−" : opts.sign ? "+" : ""}${body}`;
}

/** Split for display: ["$2,000", ".00"]. */
export function moneyParts(decimal: string | null | undefined): [string, string] {
  const m = money(decimal);
  const i = m.lastIndexOf(".");
  return i === -1 ? [m, ""] : [m.slice(0, i), m.slice(i)];
}

export function tokenAmount(decimal: string | null | undefined, symbol?: string | null): string {
  if (decimal === null || decimal === undefined) return "-";
  return `${money(decimal, { currency: false })}${symbol ? ` ${symbol}` : ""}`;
}

export function shortAddress(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return "-";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;
export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds <= 0 ? "just now" : "in a moment";
  const table: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
    [2629800, "week"],
    [31557600, "month"],
    [Infinity, "year"]
  ];
  let prev = 1;
  for (const [limit, unit] of table) {
    if (abs < limit) return rtf ? rtf.format(Math.round(seconds / prev), unit) : date.toLocaleString();
    prev = limit;
  }
  return date.toLocaleDateString();
}

export function dateShort(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function compare(a: string, b: string): number {
  // Compare two non-negative decimal strings exactly.
  const [aw = "0", af = ""] = a.split(".");
  const [bw = "0", bf = ""] = b.split(".");
  if (aw.length !== bw.length) return aw.length - bw.length;
  if (aw !== bw) return aw < bw ? -1 : 1;
  const len = Math.max(af.length, bf.length);
  const ap = af.padEnd(len, "0");
  const bp = bf.padEnd(len, "0");
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}

/** Ratio for progress bars only (display, never accounting). */
export function ratio(part: string, whole: string): number {
  const p = Number(part);
  const w = Number(whole);
  return w > 0 ? Math.max(0, Math.min(1.2, p / w)) : 0;
}

/** Exact decimal arithmetic for previews: "12.50" ↔ 12500000n at 6 decimals. Returns null for invalid input. */
export function toUnits(decimal: string, decimals = 6): bigint | null {
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m || (m[2]?.length ?? 0) > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

export function fromUnits(units: bigint, decimals = 6): string {
  const base = 10n ** BigInt(decimals);
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units / base}.${frac.padEnd(2, "0")}`;
}

/** A calendar date ("2026-09-30") shown as-is, never shifted by the viewer's timezone. */
export function calendarDate(value: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!value) return "-";
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: opts.year || y !== new Date().getFullYear() ? "numeric" : undefined });
}

/** Today as YYYY-MM-DD in the viewer's calendar. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
