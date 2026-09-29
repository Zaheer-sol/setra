import pg from "pg";

// numeric(78,0) money columns must never become JS numbers. Keep them as strings; callers use BigInt.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);
// bigint block numbers: keep as strings too (they can exceed 2^53 on some chains).
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);
// Calendar dates (accounting dates, due dates) stay "YYYY-MM-DD". Parsing them as local-midnight JS
// Dates shifts them by a day in any timezone ahead of UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export type Client = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

const pools = new Map<string, pg.Pool>();

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and start Postgres with `docker compose up -d`.");
  return url;
}

export function pool(url = databaseUrl()): pg.Pool {
  let p = pools.get(url);
  if (!p) {
    p = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_SIZE ?? 10),
      statement_timeout: 20_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: process.env.SETRA_SERVICE ?? "setra"
    });
    p.on("error", (error) => console.error(JSON.stringify({ level: "error", message: "postgres pool error", error: error.message })));
    pools.set(url, p);
  }
  return p;
}

export interface TxOptions {
  /** Tenant scope for row-level security. */
  organizationId?: string;
  /** Cross-tenant system access (worker scans only). */
  system?: boolean;
}

/**
 * Run `fn` in a transaction. Tenant-scoped transactions set app.organization_id so PostgreSQL
 * row-level security enforces isolation even if a query forgets its WHERE clause.
 */
export async function transaction<T>(options: TxOptions, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id', $1, true), set_config('app.system', $2, true)", [
      options.organizationId ?? "",
      options.system ? "on" : "off"
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const withTenant = <T>(organizationId: string, fn: (client: Client) => Promise<T>) => transaction({ organizationId }, fn);
export const withSystem = <T>(fn: (client: Client) => Promise<T>) => transaction({ system: true }, fn);
/** Non-tenant tables only (users, sessions, networks). RLS-protected tables return nothing here. */
export const withGlobal = <T>(fn: (client: Client) => Promise<T>) => transaction({}, fn);

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

/** True when a query failed because of a unique constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}
