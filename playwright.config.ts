import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 600_000,
  // Media tests are CPU-heavy (software decode in CI); running them in parallel skews the smoothness checks.
  workers: 1,
  use: { baseURL: 'http://localhost:4173', ...devices['iPhone 13'], browserName: 'chromium' },
  webServer: { command: 'npm run preview -- --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
});
