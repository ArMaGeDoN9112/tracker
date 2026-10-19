import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'https://localhost:5173', ignoreHTTPSErrors: true, trace: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [
    {
      command: `"${fileURLToPath(new URL(process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python', import.meta.url))}" -m scripts.e2e_server`,
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      port: 8000,
      reuseExistingServer: false,
    },
    { command: 'npm run dev', url: 'https://localhost:5173', ignoreHTTPSErrors: true, reuseExistingServer: false },
  ],
})
