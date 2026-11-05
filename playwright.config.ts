import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const scratch = process.env.KIROCREW_SCRATCH ?? process.env.LAB_TEST_SCRATCH;
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  outputDir: scratch ? resolve(scratch, 'playwright-results') : '.lab/playwright-results',
  use: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } } : {}), baseURL: 'http://127.0.0.1:4173', trace: 'off', screenshot: 'only-on-failure', video: 'off', viewport: { width: 1440, height: 1100 } },
  webServer: {
    command: 'node node_modules/typescript/bin/tsc -p tsconfig.build.json && node node_modules/vite/bin/vite.js build apps/command-center && node tests/browser/start-fixture.mjs',
    url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 120000,
    env: { LAB_UI_FIXTURE: '1' },
  },
});
