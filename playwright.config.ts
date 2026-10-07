import { defineConfig, devices } from "@playwright/test";

const webPort = process.env.E2E_WEB_PORT ?? "3000";
const apiPort = process.env.E2E_API_PORT ?? "4000";
const localBaseUrl = `http://localhost:${webPort}`;

/**
 * End-to-end tests drive the real web console and hosted payment page against the real API.
 * Start the stack first (`npm run dev`), or let Playwright start it. E2E_WEB_PORT and
 * E2E_API_PORT keep the isolated test stack usable when the normal development ports are busy.
 */
export default defineConfig({
  testDir: "e2e",
  // On-chain tests run against their own isolated stack: playwright.onchain.config.ts
  testIgnore: ["onchain/**", "live/**"],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? localBaseUrl,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 }
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.E2E_BROWSER_CHANNEL === "chrome" ? { channel: "chrome" as const } : {}), viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: `API_PORT=${apiPort} WEB_ORIGIN=${localBaseUrl} PUBLIC_APP_URL=${localBaseUrl} npm run dev -w @setra/api`,
          url: `http://localhost:${apiPort}/v1/health`,
          reuseExistingServer: true,
          timeout: 120_000
        },
        {
          command: `API_INTERNAL_URL=http://localhost:${apiPort} npx next start apps/web --port ${webPort}`,
          url: `${localBaseUrl}/login`,
          reuseExistingServer: true,
          timeout: 120_000
        }
      ]
});
