import { defineConfig } from '@playwright/test';
import path from 'node:path';
import base from './playwright.config';

const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';

// Same browser scenarios against actual dist + FastAPI, without Vite's dev server.
export default defineConfig({
  ...base,
  webServer: {
    command: `"${python}" -m uvicorn backend.app.main:app --host 127.0.0.1 --port 5174`,
    url: 'http://127.0.0.1:5174/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      SPACE_DB_PATH: path.resolve(`tmp/e2e-production/run-${process.pid}/space.db`),
      SPACE_ADMIN_PASSWORD: 'atlas-local-test-password',
    },
  },
});
