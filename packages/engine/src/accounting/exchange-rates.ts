import type { Client } from "@setra/database";
import { newId } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { LEDGER_DECIMALS } from "./chart";

type Row = Record<string, any>;

/**
 * Exchange rates. Setra never invents one: a rate is either entered by the business (with a date
 * and an optional note) or published by a named source (European Central Bank reference rates,
 * fetched by the worker when enabled). The rate used is written on every journal line it values.
 */

/** How far back a rate may be used. Published rates skip weekends; a business may set monthly rates. */
export const RATE_MAX_AGE_DAYS = 31;

const RATE_SCALE = 10n ** 18n;

export interface Rate {
  base: string;
  quote: string;
  rate: string;
  rateDate: string;
  source: "manual" | "ecb";
}

/** Parse a positive decimal rate string into an 18-decimal integer. */
export function scaleRate(rate: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(rate)) throw new EngineError("invalid_rate", "Enter the rate as a decimal number, like 1.0842.", 422);
  const [w, f = ""] = rate.split(".");
  const v = BigInt(w!) * RATE_SCALE + BigInt((f + "0".repeat(18)).slice(0, 18));
  if (v <= 0n) throw new EngineError("invalid_rate", "A rate must be greater than zero.", 422);
  return v;
}

/**
 * The rate to value `base` in `quote` on `date`: the business's own rate if it has one within the
 * allowed age, otherwise the most recent published rate within it. Null when there's none.
 */

export async function rateFor(client: Client, organizationId: string, base: string, quote: string, date: string): Promise<Rate | null> {
  if (base === quote) return { base, quote, rate: "1", rateDate: date, source: "manual" };
  const row = (
    await client.query(
      `SELECT base, quote, rate::text AS rate, rate_date::text AS rate_date, source FROM fx_rates
        WHERE base = $1 AND quote = $2 AND rate_date <= $3::date AND rate_date > $3::date - $5::int
          AND (organization_id = $4 OR organization_id IS NULL)
        ORDER BY (organization_id IS NULL), rate_date DESC LIMIT 1`,
      [base, quote, date, organizationId, RATE_MAX_AGE_DAYS]
    )
  ).rows[0] as Row | undefined;
  return row ? { base: row.base, quote: row.quote, rate: row.rate, rateDate: row.rate_date, source: row.source } : null;
}

/** Convert an amount in `decimals` base units at `rate` into ledger micro-units, rounding half up. */
export function convert(baseUnits: bigint, decimals: number, rate: string): bigint {
  const scaled = scaleRate(rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate);
  const num = baseUnits * scaled * 10n ** BigInt(LEDGER_DECIMALS);
  const den = 10n ** BigInt(decimals) * RATE_SCALE;
  return (num + den / 2n) / den;
}

export const rateSource = (r: Rate) => (r.base === r.quote ? `peg:${r.quote}` : `${r.source}:${r.base}/${r.quote}@${r.rate}:${r.rateDate}`);

export async function requireRate(client: Client, organizationId: string, base: string, quote: string, date: string): Promise<Rate> {
  const r = await rateFor(client, organizationId, base, quote, date);
  if (!r) throw new EngineError("no_valuation", `No ${base} to ${quote} rate on or within ${RATE_MAX_AGE_DAYS} days before ${date}. Add one under Books → Exchange rates, then run Repair.`, 422);
  return r;
}

export async function setRate(client: Client, organizationId: string, input: { base: string; quote?: string; rate_date: string; rate: string; note?: string | null }, actor: Actor): Promise<Row> {
  const base = input.base.toUpperCase();
  const quote = (input.quote ?? "USD").toUpperCase();
  if (base === quote) throw new EngineError("invalid_rate", "The two currencies must differ.", 422);
  scaleRate(input.rate);
  const row = (
    await client.query(
      `INSERT INTO fx_rates (id, organization_id, base, quote, rate_date, rate, source, note, created_by_label) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8)
       ON CONFLICT (COALESCE(organization_id, ''), base, quote, rate_date, source) DO UPDATE SET rate = EXCLUDED.rate, note = EXCLUDED.note, created_by_label = EXCLUDED.created_by_label
       RETURNING id, base, quote, rate_date::text, rate::text, source, note`,
      [newId("fxRate"), organizationId, base, quote, input.rate_date, input.rate, input.note ?? null, actor.label ?? null]
    )
  ).rows[0] as Row;
  await audit(client, actor, { organizationId, action: "fx_rate_set", objectType: "fx_rate", objectId: row.id, next: { base, quote, rate_date: input.rate_date, rate: input.rate } });
  return row;
}

export async function listRates(client: Client, organizationId: string, opts: { base?: string; limit?: number } = {}): Promise<Row[]> {
  return (
    await client.query(
      `SELECT id, base, quote, rate_date::text, rate::text, source, note, created_by_label, created_at, organization_id IS NULL AS published FROM fx_rates
        WHERE (organization_id = $1 OR organization_id IS NULL) AND ($2::text IS NULL OR base = $2) ORDER BY rate_date DESC, base LIMIT $3`,
      [organizationId, opts.base ?? null, opts.limit ?? 200]
    )
  ).rows as Row[];
}

/** Store published rates (worker, system context). Idempotent per source, pair and date. */
export async function recordPublishedRates(client: Client, source: "ecb", rates: Array<{ base: string; quote: string; rate_date: string; rate: string }>): Promise<number> {
  let n = 0;
  for (const r of rates) {
    const res = await client.query(
      `INSERT INTO fx_rates (id, organization_id, base, quote, rate_date, rate, source) VALUES ($1, NULL, $2, $3, $4, $5, $6)
       ON CONFLICT (COALESCE(organization_id, ''), base, quote, rate_date, source) DO NOTHING`,
      [newId("fxRate"), r.base, r.quote, r.rate_date, r.rate, source]
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/**
 * Parse the ECB daily reference-rate XML (rates are quoted per 1 EUR) into rates for EUR in the
 * given quote currency. Only pairs involving EUR are derived; nothing is triangulated silently.
 */

export function parseEcbDaily(xml: string, quotes: string[] = ["USD"]): Array<{ base: string; quote: string; rate_date: string; rate: string }> {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) return [];
  const out: Array<{ base: string; quote: string; rate_date: string; rate: string }> = [];
  for (const q of quotes) {
    const m = new RegExp(`currency=['"]${q}['"]\\s+rate=['"]([0-9.]+)['"]`).exec(xml);
    if (m) out.push({ base: "EUR", quote: q, rate_date: date, rate: m[1]! });
  }
  return out;
}
