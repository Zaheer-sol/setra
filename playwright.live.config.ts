import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in live Monad testnet end-to-end (real funds on testnet). Uses the running dev stack.
 * Skipped unless E2E_TESTNET_PAYER_KEY and E2E_TESTNET_MERCHANT are set. See e2e/live/testnet.spec.ts.
 */
export default defineConfig({
  testDir: "e2e/live",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", viewport: { width: 1440, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }]
});
