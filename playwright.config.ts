import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real web console and hosted payment page against the real API.
 * Start the stack first (`npm run dev`), or let Playwright start it.
 */
export default defineConfig({
  testDir: "e2e",
  // On-chain tests run against their own isolated stack: playwright.onchain.config.ts
  testIgnore: ["onchain/**", "live/**"],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 }
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.E2E_BROWSER_CHANNEL === "chrome" ? { channel: "chrome" as const } : {}), viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        { command: "npm run dev -w @setra/api", url: "http://localhost:4000/v1/health", reuseExistingServer: true, timeout: 120_000 },
        { command: "npm run dev -w @setra/web", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 180_000 }
      ]
});
