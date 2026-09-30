import { loadEnvFile } from "./load-env";
import { migrate } from "./migrator";

loadEnvFile();
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATION_DATABASE_URL (schema owner) or DATABASE_URL.");
  process.exit(1);
}
await migrate(url);

// Managed Postgres hands out one superuser, and a superuser bypasses row-level security. When
// APP_DB_PASSWORD is set, enable the restricted setra_app role (created by the migrations) with that
// password, so the application can connect as it instead.
if (process.env.APP_DB_PASSWORD) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const sql = (await client.query<{ sql: string }>("SELECT format('ALTER ROLE setra_app WITH LOGIN PASSWORD %L', $1::text) AS sql", [process.env.APP_DB_PASSWORD])).rows[0]!.sql;
    await client.query(sql);
    console.log("application role enabled");
  } finally {
    await client.end();
  }
}
