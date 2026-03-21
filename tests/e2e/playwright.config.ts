import * as path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const ROOT = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `cd ${ROOT}/packages/web && bun run build && bunx vite preview --port 4173`,
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },

  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
});
