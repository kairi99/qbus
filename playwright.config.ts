import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// The Playwright CDN download is unreliable here, so fall back to a manually fetched Chrome.
// Parallel checkouts (git worktrees) each run their own dev server: QBUS_PORT picks its port.
const port = Number(process.env.QBUS_PORT ?? 5173);
const localChrome = `${homedir()}/.cache/qbus-chrome/chrome-linux64/chrome`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  // WebGL here is software-rendered (CPU-bound): parallel workers just starve each other.
  workers: 1,
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: existsSync(localChrome) ? localChrome : undefined,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: { command: `npx vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: true },
});
