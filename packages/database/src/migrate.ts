import { loadEnvFile } from "./load-env";
import { migrate } from "./migrator";

loadEnvFile();
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATION_DATABASE_URL (schema owner) or DATABASE_URL.");
  process.exit(1);
}
await migrate(url);
