import { expect, test, type Page } from '@playwright/test';

// Two software-WebGL pages at once: a few frames a second each.
test.describe.configure({ timeout: 600_000 });

// A page mid-navigation (menu -> game, a dev-server reload) has no context: polls read that as "not yet".
const q = (page: Page, fn: string) =>
  page.evaluate(`(() => { const q = window.__qbus; return ${fn}; })()`).catch((e: Error) => {
    if (/context was destroyed|navigation/i.test(e.message)) return undefined;
    throw e;
  });

test('a player\'s link drops, then his page reloads, mid-race: he gets his seat and his bus back, the host stays host', async ({ browser }) => {
  const errors: string[] = [];
  const open = async (name: string) => {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto('/');
    await page.getByRole('button', { name: 'En línea' }).click();
    await page.locator('input[name="name"]').fill(name);
    return { ctx, page };
  };
  const a = await open('Ana');
  const b = await open('Beto');
  await a.page.getByRole('button', { name: 'Crear sala' }).click();
  const codeEl = a.page.locator('[data-room-code]');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 20_000 });
  await b.page.locator('input[name="code"]').fill((await codeEl.textContent())!);
  await b.page.getByRole('button', { name: 'Unirse' }).click();
  await expect(a.page.locator('.mn-seat[data-seat]')).toHaveCount(2);
  await a.page.locator('input[name="ai"][value="1"]').check();
  await b.page.getByRole('button', { name: '¡Listo!' }).click();
  await a.page.getByRole('button', { name: '¡Arrancar!' }).click();
  for (const p of [a.page, b.page]) {
    await p.waitForURL(/mode=online/, { timeout: 30_000 });
    await expect.poll(() => q(p, '!!q?.online'), { timeout: 150_000 }).toBe(true);
  }
  for (const p of [a.page, b.page]) await expect.poll(() => q(p, 'q?.racing?.game?.green === true'), { timeout: 60_000 }).toBe(true);
  expect(await q(a.page, 'q.online.host')).toBe(true);
  expect(await q(b.page, 'q.online.host')).toBe(false);

  // Beto drives off, so there is progress to keep.
  await b.page.keyboard.down('KeyW');
  const betoS = () => q(b.page, 'q.racing.trackS(0)') as Promise<number>;
  const start = await betoS();
  await expect.poll(async () => (await betoS()) - start, { timeout: 90_000 }).toBeGreaterThan(15);
  // On Ana's screen his bus is live and solid.
  const seenSolid = () => q(a.page, '!q.online.remotes.find((r) => r.name === "Beto").remote.bus.ghost');
  await expect.poll(seenSolid, { timeout: 30_000 }).toBe(true);

  // 1. His link drops (a wifi blip): "Reconectando…", Ana sees a ghost, the page retries on its own and is solid again.
  // Retries fail (socket constructor throws) until Ana has seen the ghost: otherwise the quick reconnect can beat her poll.
  await b.page.evaluate(`(() => { const c = window.__qbus.online.conn; c.RealImpl = c.Impl; c.Impl = function () { throw new Error('link down'); }; c.ws.close(); })()`);
  await expect.poll(() => q(a.page, 'q.online.remotes.find((r) => r.name === "Beto").remote.bus.ghost'), { timeout: 30_000 }).toBe(true);
  await b.page.evaluate(`(() => { const c = window.__qbus.online.conn; c.Impl = c.RealImpl; })()`);
  await expect.poll(() => q(b.page, 'q.online.conn.state'), { timeout: 60_000 }).toBe('open');
  await expect.poll(seenSolid, { timeout: 60_000 }).toBe(true);
  await expect(b.page.locator('.rh-net')).toBeHidden();
  expect(await q(a.page, 'q.online.host')).toBe(true);

  const seatBefore = await q(b.page, 'q.online.conn.seat');
  // 2. His page reloads: back into the running race, near where his bus was, with the race's own clock.
  await b.page.keyboard.up('KeyW');
  const before = await betoS();
  expect(seatBefore).not.toBeNull();
  const raceTime = (await q(a.page, 'q.racing.game.time')) as number;
  await b.page.reload();
  await expect.poll(() => q(b.page, '!!q?.online'), { timeout: 150_000 }).toBe(true);
  await expect.poll(() => q(b.page, 'q.racing.game.green'), { timeout: 60_000 }).toBe(true);
  expect(await q(b.page, 'q.online.conn.seat')).toBe(seatBefore);
  expect(await q(b.page, 'q.racing.game.time')).toBeGreaterThan(raceTime);
  await expect.poll(async () => Math.abs((await betoS()) - before), { timeout: 30_000 }).toBeLessThan(60);
  // He is the same racer: Ana still has two humans and the AI, and sees him solid again, host unchanged.
  await expect.poll(seenSolid, { timeout: 90_000 }).toBe(true);
  expect(await q(a.page, 'q.online.host')).toBe(true);
  expect(await q(b.page, 'q.online.host')).toBe(false);
  await expect(a.page.locator('.rh-place')).toContainText('/ 3');
  // He races on from there.
  await b.page.keyboard.down('KeyW');
  await expect.poll(async () => (await betoS()) - before, { timeout: 120_000 }).toBeGreaterThan(20);
  await b.page.screenshot({ path: 'e2e/screenshots/online-reconnect-beto.png' });

  expect(errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
