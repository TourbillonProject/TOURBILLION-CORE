import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Chromium with iPad (8th-gen class) viewport, touch and user agent. WebKit is
    // not installed in this environment — see docs/TESTING.md for the Safari caveat.
    { name: 'ipad-landscape', use: { ...devices['iPad (gen 7) landscape'], browserName: 'chromium' }, grepInvert: /@portrait/ },
    { name: 'ipad-portrait', use: { ...devices['iPad (gen 7)'], browserName: 'chromium' }, grep: /@portrait/ },
  ],
  webServer: {
    command: `npx tsx e2e/serve.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
    stdout: 'pipe',
  },
});
