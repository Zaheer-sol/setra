/**
 * Isolated stack for the on-chain end-to-end test: a real EVM node (Anvil) with a real ERC-20 and the
 * real SetraPaymentIntent contract, a dedicated database, and Setra's real API, worker and web app.
 * Nothing is simulated: payments are signed transactions that the worker ingests from the node.
 *
 *   npx playwright test -c playwright.onchain.config.ts
 *
 * Writes the chain details to e2e/onchain/.stack.json for the test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../../packages/database/src/migrator";
import { startDevChain } from "../../packages/devchain/src";

const ROOT = join(import.meta.dirname, "../..");
const PORTS = { chain: 8547, api: 4102, web: 3102 };
const OWNER = process.env.E2E_OWNER_URL ?? "postgresql://setra:setra@localhost:5432";
const DB = "setra_e2e";

const children: ChildProcess[] = [];
const stop = (code = 0) => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
};
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());

// Fresh database every run.
const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
await admin.connect();
await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid()`);
await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
await admin.query(`CREATE DATABASE ${DB} OWNER setra`);
await admin.end();

const chain = await startDevChain({ port: PORTS.chain });
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  NODE_ENV: "development",
  LOG_LEVEL: "warn",
  DATABASE_URL: `postgresql://setra_app:setra_app@localhost:5432/${DB}`,
  MIGRATION_DATABASE_URL: `${OWNER}/${DB}`,
  API_PORT: String(PORTS.api),
  WEB_ORIGIN: `http://localhost:${PORTS.web}`,
  PUBLIC_APP_URL: `http://localhost:${PORTS.web}`,
  API_INTERNAL_URL: `http://localhost:${PORTS.api}`,
  WEBHOOK_ALLOW_PRIVATE_URLS: "true",
  WORKER_POLL_MS: "500",
  MONAD_ENABLED: "false",
  MONAD_TESTNET_ENABLED: "false",
  LOCAL_CHAIN_ENABLED: "true",
  LOCAL_CHAIN_RPC_URL: chain.rpcUrl,
  LOCAL_USDC_ADDRESS: chain.usdc,
  LOCAL_PAYMENT_INTENT_ADDRESS: chain.intentContract,
  LOCAL_CHAIN_CONFIRMATIONS: "1",
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_TELEMETRY_DISABLED: "1"
};
Object.assign(process.env, env);
await migrate(env.MIGRATION_DATABASE_URL!, () => undefined);

writeFileSync(
  join(import.meta.dirname, ".stack.json"),
  JSON.stringify({ rpcUrl: chain.rpcUrl, usdc: chain.usdc, intentContract: chain.intentContract, api: env.API_INTERNAL_URL, web: env.WEB_ORIGIN }, null, 2)
);

const run = (name: string, cmd: string, args: string[], cwd = ROOT) => {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  child.on("exit", (code) => {
    if (code && code !== 143) {
      console.error(`[${name}] exited with ${code}`);
      stop(1);
    }
  });
  children.push(child);
};
run("api", "npx", ["tsx", "apps/api/src/main.ts"]);
run("worker", "npx", ["tsx", "apps/worker/src/main.ts"]);
run("web", "npx", ["next", "dev", "--port", String(PORTS.web)], join(ROOT, "apps/web"));
console.log(`on-chain e2e stack: chain ${chain.rpcUrl}, api :${PORTS.api}, web :${PORTS.web}, db ${DB}`);
await new Promise(() => undefined);
