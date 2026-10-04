import { defineConfig, devices } from "@playwright/test";

// Distinctive default so E2E does not collide with a dev server the developer
// happens to be running on 3000/3100. Override with PORT=... when needed.
const PORT = Number(process.env.E2E_PORT ?? 3187);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `${baseURL}/api/health`,
    // Always boot our own server: reusing whatever happens to hold the port
    // silently tests someone else's app (or a stale build) instead of this one.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MOCK_GITHUB: "1",
      PUBLIC_BASE_URL: baseURL,
      DATA_DIR: ".data/e2e",
      // Raised so audit cases cannot starve each other; the limiter itself is
      // unit-tested in tests/unit/ratelimit.test.ts.
      RATE_LIMIT_SCAN_POINTS: "200",
      RATE_LIMIT_API_POINTS: "500",
    },
  },
});
