import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const PORT = 8787;
let child: ChildProcess | null = null;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function setup(): Promise<void> {
  if (await healthy()) throw new Error(`something already listens on :${PORT}`);
  child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: resolve(__dirname, '../../server'),
    env: { ...process.env, CI: '1', BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if (await healthy()) return;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await teardown();
  throw new Error(`wrangler dev did not come up:\n${log.slice(-2000)}`);
}

export async function teardown(): Promise<void> {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  child = null;
}
