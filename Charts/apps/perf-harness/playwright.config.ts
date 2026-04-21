import { defineConfig } from '@playwright/test';

const rawPort = Number.parseInt(process.env.PERF_PORT ?? '4174', 10);
const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 4174;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL,
  },
  webServer: {
    command: 'npm run preview',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
        },
      },
    },
  ],
});
