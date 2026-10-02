import { loadEnvFile } from "../packages/database/src/load-env";

// Integration tests always run against the dedicated test database, never the development one.
loadEnvFile();
process.env.NODE_ENV = "test";
// Seti's optional language model stays off: tests must not depend on (or spend) a provider found in .env.
// Its behaviour is covered with a fake provider in apps/api/src/assistant/language-model.unit.test.ts.
delete process.env.LLM_API_KEY;
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://setra_app:setra_app@localhost:5432/setra_test";
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL ?? "postgresql://setra:setra@localhost:5432/setra_test";
process.env.SETRA_SERVICE = "setra-test";
process.env.WEBHOOK_ALLOW_PRIVATE_URLS = "true";
// The local devnet (Anvil) is enabled for tests. Its first deployed contract (mock USDC) lands at this
// deterministic address when deployed from Anvil's first dev account.
process.env.LOCAL_CHAIN_ENABLED = process.env.LOCAL_CHAIN_ENABLED ?? "true";
process.env.LOCAL_USDC_ADDRESS = process.env.LOCAL_USDC_ADDRESS ?? "0x5fbdb2315678afecb367f032d93f642f64180aa3";
process.env.EXEC_EVENTS_INGEST_TOKEN = process.env.EXEC_EVENTS_INGEST_TOKEN ?? "test-exec-events-token-0123456789abcdef";
