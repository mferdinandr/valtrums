import { defineConfig } from "@playwright/test";

/**
 * Browser tests run in the user's installed Brave (a Chromium browser), so no browser download is needed.
 * Override the binary with BRAVE_PATH. The app talks only to a FIXTURE read service started from
 * e2e/fixture-read-api.mjs (the real read code over in-memory data); nothing here touches a live network.
 */
const BRAVE = process.env.BRAVE_PATH ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const API_PORT = 18790;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    browserName: "chromium",
    // Headless by default. E2E_HEADED=1 opens a visible Brave window; E2E_SLOWMO=<ms> slows each step down to watch.
    headless: !process.env.E2E_HEADED,
    launchOptions: { executablePath: BRAVE, slowMo: Number(process.env.E2E_SLOWMO ?? 0), args: ["--no-first-run", "--no-default-browser-check", "--disable-brave-update"] },
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "./e2e/.results",
  webServer: [
    { command: "node e2e/fixture-read-api.mjs", url: `http://127.0.0.1:${API_PORT}/session/config`, reuseExistingServer: false, timeout: 30_000, env: { FIXTURE_READ_PORT: String(API_PORT) } },
    {
      // A production build: the dev server did not hydrate in Brave (its HMR websocket is refused).
      command: `pnpm exec next build && pnpm exec next start -p ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/arena`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        NEXT_PUBLIC_ARENA_READ_DEPLOYMENT: "arena-fixture-v1", NEXT_PUBLIC_ARENA_READ_PROTOCOL: "lifecycle-v2",
        NEXT_PUBLIC_ARENA_CONTRACT_ID: "arena.testnet", NEXT_PUBLIC_NEAR_NETWORK: "testnet", ARENA_READ_API_URL: `http://127.0.0.1:${API_PORT}`,
      },
    },
  ],
});
