/**
 * Backend load test: payment processing and accounting reports on a busy workspace.
 *
 *   npx tsx scripts/perf/load-test.ts            # seed once (if needed), then measure
 *   npx tsx scripts/perf/load-test.ts --reseed   # rebuild the seeded database first
 *   PERF_SCALE=0.25 npx tsx scripts/perf/load-test.ts --reseed   # smaller, faster data set
 *
 * Uses its own databases, setra_perf_base (seeded once) and setra_perf_run (a fresh copy of the base
 * for every run), so each measurement starts from identical data. It never touches setra_dev.
 * Connection details come from .env (DATABASE_URL / MIGRATION_DATABASE_URL), with the database
 * name swapped.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const BASE = "setra_perf_base";
const RUN = "setra_perf_run";
const SCALE = Number(process.env.PERF_SCALE ?? "1");
const PAID = Math.round(6000 * SCALE);
const OPEN = Math.round(2000 * SCALE);
const CUSTOMERS = Math.max(20, Math.round(300 * SCALE));
const MATCH_SAMPLES = Math.min(150, OPEN);
const DAY = 86_400_000;

const mode = process.argv[2];
if (mode === "seed") await seed();
else if (mode === "measure") await measure();
else await orchestrate();

// ── Orchestration ──────────────────────────────────────────────────────────────────────────────

function urlFor(base: string | undefined, db: string, name: string): string {
  if (!base) throw new Error(`${name} must be set in .env`);
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(process.env.MIGRATION_DATABASE_URL, "postgres", "MIGRATION_DATABASE_URL") });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function recreate(db: string, template?: string) {
  if (!db.startsWith("setra_perf_")) throw new Error(`refusing to recreate ${db}`);
  await admin(async (c) => {
    for (const name of [db, template].filter(Boolean)) await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
    await c.query(`DROP DATABASE IF EXISTS ${db}`);
    await c.query(`CREATE DATABASE ${db}${template ? ` TEMPLATE ${template}` : ""}`);
  });
}

function child(args: string[], db: string) {
  const env = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: urlFor(process.env.DATABASE_URL, db, "DATABASE_URL"),
    MIGRATION_DATABASE_URL: urlFor(process.env.MIGRATION_DATABASE_URL, db, "MIGRATION_DATABASE_URL")
  };
  const r = spawnSync("npx", ["tsx", ...args], { cwd: ROOT, env, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${args.join(" ")} failed`);
}

async function orchestrate() {
  process.loadEnvFile(resolve(ROOT, ".env"));
  const exists = await admin(async (c) => (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [BASE])).rowCount === 1);
  if (!exists || process.argv.includes("--reseed")) {
    console.log(`Seeding ${BASE}: ${CUSTOMERS} customers, ${PAID} paid invoices, ${OPEN} open invoices`);
    await recreate(BASE);
    child(["packages/database/src/migrate.ts"], BASE);
    child(["scripts/perf/load-test.ts", "seed"], BASE);
  }
  await recreate(RUN, BASE);
  // Apply migrations added since the base was seeded (new indexes), so the data stays identical.
  child(["packages/database/src/migrate.ts"], RUN);
  child(["scripts/perf/load-test.ts", "measure"], RUN);
}

// ── Seeding (runs against setra_perf_base) ─────────────────────────────────────────────────────

async function seed() {
  const { withGlobal, withTenant, closePools } = await import("@setra/database");
  const engine = await import("@setra/engine");
  engine.setLogger(engine.silentLogger);
  const started = Date.now();

  const user = await engine.createUser({ email: "perf@setra.test", name: "Perf Owner", password: "perf-password-not-secret" });
  const org = await engine.createOrganization({ name: "Perf Workspace", ownerUserId: user.id, ownerLabel: user.email });
  await withGlobal((c) => c.query("UPDATE organizations SET onboarding_completed_at = now() WHERE id = $1", [org.id]));
  const actor = { type: "user" as const, id: user.id, label: user.email };
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

  const customers = await withTenant(org.id, async (c) => {
    await engine.createWallet(c, org.id, "test", { name: "Main Receiving Wallet", network: "monad", address: addr(0xfeed), assets: ["USDC"] }, actor);
    const ids: string[] = [];
    for (let i = 0; i < CUSTOMERS; i++) {
      // Half the customers pay from a known wallet, half from unknown ones.
      const wallet = i % 2 === 0 ? [{ address: addr(0x100000 + i), network: "monad" as const, label: "Treasury" }] : [];
      ids.push((await engine.createCustomer(c, org.id, "test", { name: `Customer ${i}`, email: `c${i}@perf.test`, metadata: {}, wallet_addresses: wallet }, actor)).id);
    }
    return ids;
  });

  let n = 0;
  const invoice = async (c: any, issued: Date) => {
    const i = n++;
    const row = await engine.createInvoice(
      c,
      org.id,
      "test",
      { customer_id: customers[i % customers.length]!, number: `P-${i}`, amount: (50 + i * 1.37).toFixed(2), title: `Service ${i}`, currency: "USD", asset: "USDC", network: "monad", metadata: {} },
      actor
    );
    await c.query("UPDATE invoices SET issued_at = $1, created_at = $1 WHERE id = $2", [issued, row.id]);
    return row;
  };

  // A year of paid invoices, each paid a day after it was issued; one transaction per payment, as in
  // production.
  for (let done = 0; done < PAID; done++) {
    const issued = new Date(Date.now() - (365 - (done * 360) / PAID) * DAY);
    const inv = await withTenant(org.id, (c) => invoice(c, issued));
    await withTenant(org.id, (c) => engine.simulatePayment(c, org.id, "test", { scenario: "exact", invoice_id: inv.id, finalize: true }, actor, { at: new Date(issued.getTime() + DAY) }));
    if ((done + 1) % 500 === 0) console.log(`  paid invoices: ${done + 1}/${PAID} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  // Currently open invoices.
  for (let done = 0; done < OPEN; ) {
    await withTenant(org.id, async (c) => {
      for (let k = 0; k < 200 && done < OPEN; k++, done++) await invoice(c, new Date(Date.now() - 20 * DAY));
    });
  }
  const counts = await withTenant(org.id, async (c) => (await c.query("SELECT (SELECT count(*) FROM journal_entries)::int AS entries, (SELECT count(*) FROM journal_lines)::int AS lines, (SELECT count(*) FROM payments)::int AS payments")).rows[0]);
  console.log(`Seeded in ${((Date.now() - started) / 1000).toFixed(0)}s: ${counts.payments} payments, ${counts.entries} journal entries, ${counts.lines} journal lines`);
  await closePools();
}

// ── Measurement (runs against a fresh copy, setra_perf_run) ────────────────────────────────────

async function measure() {
  const { withSystem, withTenant, closePools } = await import("@setra/database");
  const engine = await import("@setra/engine");
  engine.setLogger(engine.silentLogger);
  const org = (await withSystem((c) => c.query("SELECT o.id, m.user_id FROM organizations o JOIN organization_members m ON m.organization_id = o.id WHERE o.name = 'Perf Workspace'"))).rows[0];
  const actor = { type: "user" as const, id: org.user_id, label: "perf" };
  const tenant = <T>(fn: (c: any) => Promise<T>) => withTenant(org.id as string, fn);
  const env = "test" as const;
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10);

  const stats = (ms: number[]) => {
    const s = [...ms].sort((a, b) => a - b);
    const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
  };
  const time = async (fn: () => Promise<unknown>) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };
  const rows: Array<[string, string]> = [];
  const report = async (name: string, fn: () => Promise<unknown>, runs = 5) => {
    await fn(); // warm-up
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) ms.push(await time(fn));
    const s = stats(ms);
    rows.push([name, `p50 ${s.p50.toFixed(0)} ms · max ${s.max.toFixed(0)} ms`]);
  };

  const cash = (await tenant((c) => c.query("SELECT a.id FROM ledger_accounts a WHERE a.environment = 'test' AND a.wallet_id IS NOT NULL LIMIT 1"))).rows[0]?.id as string;
  const cashLines = (await tenant((c) => c.query("SELECT count(*)::int AS n FROM journal_lines WHERE account_id = $1", [cash]))).rows[0].n as number;
  const allLines = (await tenant((c) => c.query("SELECT count(*)::int AS n FROM journal_lines"))).rows[0].n as number;

  await report("Trial balance", () => tenant((c) => engine.trialBalance(c, org.id, env, today)));
  await report("Profit and loss (12 months)", () => tenant((c) => engine.profitAndLoss(c, org.id, env, yearAgo, today)));
  await report("Balance sheet", () => tenant((c) => engine.balanceSheet(c, org.id, env, today)));
  await report("Cash flow (12 months)", () => tenant((c) => engine.cashFlow(c, org.id, env, yearAgo, today)), 3);
  await report("Receivables aging", () => tenant((c) => engine.receivablesAging(c, org.id, env, today)));
  await report("Books health", () => tenant((c) => engine.booksHealth(c, org.id, env)), 3);
  await report("General ledger, first page", () => tenant((c) => engine.generalLedger(c, org.id, env, { limit: 100 })));
  await report(`General ledger, deep page (offset ${Math.floor(allLines * 0.9)})`, () => tenant((c) => engine.generalLedger(c, org.id, env, { limit: 100, offset: Math.floor(allLines * 0.9) })));
  await report(`Wallet ledger with running balance, deep page (offset ${Math.floor(cashLines * 0.9)})`, () =>
    tenant((c) => engine.generalLedger(c, org.id, env, { accountId: cash, limit: 100, offset: Math.floor(cashLines * 0.9) }))
  );

  // Payment processing: a payment arrives for an open invoice while many others are open.
  const open = (await tenant((c) => c.query("SELECT id FROM invoices WHERE status = 'open' ORDER BY number"))).rows.map((r) => r.id as string);
  const step = Math.max(1, Math.floor(open.length / MATCH_SAMPLES));
  const payMs: number[] = [];
  for (let i = 0; i < open.length && payMs.length < MATCH_SAMPLES; i += step) {
    payMs.push(await time(() => tenant((c) => engine.simulatePayment(c, org.id, env, { scenario: "exact", invoice_id: open[i]!, finalize: true }, actor))));
  }
  const unknownMs: number[] = [];
  for (let i = 0; i < 30; i++) {
    unknownMs.push(await time(() => tenant((c) => engine.simulatePayment(c, org.id, env, { scenario: "unknown", amount: (7.01 + i).toFixed(2), finalize: true }, actor))));
  }
  const matched = (await tenant((c) => c.query("SELECT count(*)::int AS n FROM invoices WHERE status = 'paid' AND number LIKE 'P-%'"))).rows[0].n as number;
  const p = stats(payMs);
  const u = stats(unknownMs);
  rows.push([`Payment for an open invoice, ${open.length} open (${payMs.length} payments)`, `p50 ${p.p50.toFixed(0)} ms · p95 ${p.p95.toFixed(0)} ms · max ${p.max.toFixed(0)} ms`]);
  rows.push(["Unidentified payment (30 payments)", `p50 ${u.p50.toFixed(0)} ms · p95 ${u.p95.toFixed(0)} ms · max ${u.max.toFixed(0)} ms`]);

  console.log(`\nData: ${allLines} journal lines, ${cashLines} on the wallet account, ${open.length} open invoices; ${matched} invoices paid after the run.\n`);
  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [name, value] of rows) console.log(`${name.padEnd(width)}  ${value}`);
  await closePools();
}
