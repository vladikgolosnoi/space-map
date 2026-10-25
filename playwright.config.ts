import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// A fresh DB/media root per run prevents leftovers from failed/interrupted tests from leaking into later scenarios.
const backendPort = 8001;
const frontendPort = 5174;
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testMatch: [
        '**/desktop.spec.ts',
        '**/panorama.spec.ts',
        '**/plan.spec.ts',
        '**/publication.spec.ts',
        '**/offline.spec.ts',
        '**/pwa.spec.ts',
        '**/mobile-product.spec.ts',
        '**/accounts.spec.ts',
        '**/visual-layout.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile-chromium',
      testMatch: '**/mobile.spec.ts',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        deviceScaleFactor: 1,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: [
    {
      command: `"${python}" -m uvicorn backend.app.main:app --host 127.0.0.1 --port ${backendPort}`,
      url: `http://127.0.0.1:${backendPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        SPACE_DB_PATH: path.resolve(`tmp/e2e/run-${process.pid}/space.db`),
        SPACE_ADMIN_PASSWORD: 'atlas-local-test-password',
      },
    },
    {
      command: `npm run dev -- --port ${frontendPort}`,
      url: `http://127.0.0.1:${frontendPort}/map/demo`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_TARGET: `http://127.0.0.1:${backendPort}` },
    },
  ],
});
