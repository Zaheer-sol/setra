import { loadEnvFile } from "../packages/database/src/load-env";
import { migrate, resetSchema } from "../packages/database/src/migrator";

export default async function setup() {
  loadEnvFile();
  const url = process.env.TEST_MIGRATION_DATABASE_URL ?? "postgresql://setra:setra@localhost:5432/setra_test";
  if (!/setra_test/.test(url)) throw new Error(`Refusing to reset a non-test database: ${url}`);
  process.env.LOCAL_CHAIN_ENABLED = process.env.LOCAL_CHAIN_ENABLED ?? "true";
  process.env.LOCAL_USDC_ADDRESS = process.env.LOCAL_USDC_ADDRESS ?? "0x5fbdb2315678afecb367f032d93f642f64180aa3";
  await resetSchema(url);
  await migrate(url, () => undefined);
}
