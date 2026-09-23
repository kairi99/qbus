import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// The Playwright CDN download is unreliable here, so fall back to a manually fetched Chrome.
const localChrome = `${homedir()}/.cache/qbus-chrome/chrome-linux64/chrome`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: existsSync(localChrome) ? localChrome : undefined,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true },
});
