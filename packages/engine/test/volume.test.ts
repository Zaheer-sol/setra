import { afterAll, describe, expect, it } from "vitest";
import { closePools, withTenant } from "../../database/src";
import { ingestObservation } from "../src";
import { invoice, randomAddress, transfer, usd, workspace } from "../../../test/fixtures";

/**
 * Volume: one merchant with many open invoices receiving many payments. Guards against matching or
 * feed queries degrading with the size of the open-invoice set.
 */
const N = Number(process.env.VOLUME_N ?? 400);

afterAll(closePools);

describe(`volume (${N} open invoices, ${N} payments)`, () => {
  it("matches every payment correctly and keeps per-payment cost flat", async () => {
    const ws = await workspace();
    const amount = (i: number) => `${100 + i}.${String(i % 100).padStart(2, "0")}`;
    const names = ["Acme Ltd", "Nova Systems", "Studio Ten"];
    for (let i = 0; i < N; i++) await invoice(ws, names[i % 3]!, amount(i));

    const timings: number[] = [];
    for (let i = 0; i < N; i++) {
      // Two thirds from known customer wallets, one third from unknown senders (exact unique amount).
      const from = i % 3 === 2 ? randomAddress() : ws.customers[names[i % 3]!]!.address!;
      const t = performance.now();
      await withTenant(ws.orgId, (c) => ingestObservation(c, ws.wallet, transfer(ws, usd(amount(i)), from), "settled"));
      timings.push(performance.now() - t);
    }

    const r = await withTenant(ws.orgId, (c) =>
      c.query(`SELECT (SELECT count(*)::int FROM invoices WHERE status = 'paid') AS paid,
                      (SELECT count(*)::int FROM exceptions WHERE status = 'open') AS open_exceptions,
                      (SELECT count(*)::int FROM payments) AS payments`)
    );
    expect(r.rows[0]).toEqual({ paid: N, open_exceptions: 0, payments: N });

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = avg(timings.slice(0, 50));
    const last = avg(timings.slice(-50));
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    console.log(`volume: avg first 50 ${first.toFixed(1)}ms, last 50 ${last.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, total ${(timings.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s`);
    expect(last).toBeLessThan(Math.max(first * 3, 60)); // no quadratic blow-up as invoices accumulate

    const feed = await withTenant(ws.orgId, async (c) => {
      const t = performance.now();
      await c.query("SELECT * FROM payments WHERE organization_id = $1 AND environment = 'test' ORDER BY id DESC LIMIT 50", [ws.orgId]);
      return performance.now() - t;
    });
    expect(feed).toBeLessThan(100);
  }, 600_000);
});
