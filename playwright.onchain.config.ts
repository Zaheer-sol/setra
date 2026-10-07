import { defineConfig, devices } from "@playwright/test";

/**
 * On-chain end-to-end: real signed ERC-20 transactions on a local EVM node (Anvil), ingested by
 * Setra's real worker, driven through the real web app. See e2e/onchain/stack.ts.
 *
 *   npx playwright test -c playwright.onchain.config.ts
 */
export default defineConfig({
  testDir: "e2e/onchain",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3102", trace: "retain-on-failure", viewport: { width: 1440, height: 900 } },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.E2E_BROWSER_CHANNEL === "chrome" ? { channel: "chrome" as const } : {}),
        viewport: { width: 1440, height: 900 }
      }
    }
  ],
  webServer: {
    command: "npx tsx e2e/onchain/stack.ts",
    url: "http://localhost:3102/login",
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe"
  }
});
