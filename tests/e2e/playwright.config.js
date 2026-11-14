// Playwright config for the PearlRate e2e suite.
//
//   cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test
//
// Env:
//   PW_CHROMIUM_PATH  use an existing Chromium/Chrome binary instead of the
//                     one `playwright install` downloads (handy on machines
//                     with a preinstalled browser).
//   PW_PORT           port for the bundled static server (default 4173).
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PW_PORT || 4173);
const CI = !!process.env.CI;

module.exports = defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: `node server.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !CI,
    timeout: 20_000,
  },
});
