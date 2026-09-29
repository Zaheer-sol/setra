import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadNetworks } from "@setra/config";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Apply pending SQL migrations in order, each in its own transaction, then sync the network
 * registry. Must run as the schema owner (MIGRATION_DATABASE_URL), not the application role.
 */
export async function migrate(url: string, log: (message: string) => void = console.log): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727372)"); // one migrator at a time
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }
    await syncNetworks(client);
    log("network registry synced");
  } finally {
    await client.query("SELECT pg_advisory_unlock(727372)").catch(() => undefined);
    await client.end();
  }
}

/** Upsert chains and assets from the code registry. Existing rows referenced by history are never deleted. */
export async function syncNetworks(client: pg.Client | pg.PoolClient, env: Record<string, string | undefined> = process.env): Promise<void> {
  for (const network of loadNetworks(env)) {
    await client.query(
      `INSERT INTO networks(chain_id, key, family, environment, name, settlement, enabled, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (chain_id) DO UPDATE SET key=excluded.key, family=excluded.family, environment=excluded.environment,
         name=excluded.name, settlement=excluded.settlement, enabled=excluded.enabled, updated_at=now()`,
      [network.chainId, network.key, network.family, network.environment, network.name, JSON.stringify(network.settlement), network.enabled]
    );
    for (const asset of network.assets) {
      await client.query(
        `INSERT INTO assets(id, chain_id, address, symbol, name, decimals, peg_currency, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (id) DO UPDATE SET address=excluded.address, symbol=excluded.symbol, name=excluded.name,
           decimals=excluded.decimals, peg_currency=excluded.peg_currency, enabled=true`,
        [asset.id, network.chainId, asset.address, asset.symbol, asset.name, asset.decimals, asset.pegCurrency]
      );
    }
  }
}

/** Drop and recreate the public schema. Development and test databases only. */
export async function resetSchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;");
  } finally {
    await client.end();
  }
}
