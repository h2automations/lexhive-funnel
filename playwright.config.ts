import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * End-to-end tests for the deployed LexHive funnel.
 *
 * Environment is read from:
 *   1. the real environment (CI / shell), which always wins
 *   2. the .env.e2e file in the repo root (see .env.e2e.example)
 *
 * No credential is ever written into a test file. OPS_KEY is read from the
 * environment only, and the authenticated /ops assertions self-skip when it is
 * absent.
 */
function loadE2eEnvFile() {
  const file = path.resolve(process.cwd(), '.env.e2e');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    const [, key, value] = match;
    if (process.env[key] !== undefined) continue; // real env wins
    const unwrapped = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    process.env[key] = unwrapped;
  }
}

loadE2eEnvFile();

export default defineConfig({
  testDir: './tests',
  // A submission writes real rows to the shared production Postgres. Tests run
  // serially in one worker so generated leads cannot interleave mid-funnel.
  fullyParallel: false,
  workers: 1,
  // Retries only in CI: local runs fail loudly on the first flake rather than
  // hiding it. Trace is collected on first retry, so it still exists exactly
  // when the retry machinery needs it.
  retries: process.env.CI ? 2 : 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: (process.env.BASE_URL || 'https://lexhive.vercel.app').replace(/\/+$/, ''),
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    locale: 'en-US',
    testIdAttribute: 'id',
    // Watching a run is how you notice the things assertions do not cover —
    // a screen that flashes, a target that is hard to hit. E2E_SLOW_MO puts a
    // pause between actions so a headed run is followable in real time.
    launchOptions: { slowMo: Number(process.env.E2E_SLOW_MO || 0) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
});