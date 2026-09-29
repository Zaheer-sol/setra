import { loadEnvFile } from "./load-env";
import { resetSchema } from "./migrator";

/** Development only: drop and recreate the public schema. Refuses to run in production. */
loadEnvFile();
if (process.env.NODE_ENV === "production") {
  console.error("db:reset is disabled when NODE_ENV=production.");
  process.exit(1);
}
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
await resetSchema(url);
console.log("schema reset");
