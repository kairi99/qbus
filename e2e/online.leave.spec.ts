import { expect, test, type Page } from '@playwright/test';

// Two software-WebGL pages at once: a few frames a second each.
test.describe.configure({ timeout: 480_000 });

const q = (page: Page, fn: string) => page.evaluate(`(() => { const q = window.__qbus; return ${fn}; })()`);

test('a player closes the page mid-race: ghost (his seat is kept); the host finishes, the final results hold him as "retirado"', async ({ browser }) => {
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
  await a.page.locator('input[name="ai"][value="0"]').check();
  await b.page.getByRole('button', { name: '¡Listo!' }).click();
  await expect(a.page.getByRole('button', { name: '¡Arrancar!' })).toBeEnabled();
  await a.page.getByRole('button', { name: '¡Arrancar!' }).click();
  for (const p of [a.page, b.page]) {
    await p.waitForURL(/mode=online/, { timeout: 30_000 });
    await expect.poll(() => q(p, '!!q?.online'), { timeout: 150_000 }).toBe(true);
  }
  for (const p of [a.page, b.page]) await expect.poll(() => q(p, 'q.racing.game.green'), { timeout: 60_000 }).toBe(true);
  expect(await q(a.page, '!!q.racing.tags?.of("Beto")')).toBe(true);

  // Beto closes his tab: on Ana's screen his bus turns ghost, with the tag saying so. His seat is kept for the whole race (he may come back).
  await b.page.close();
  await expect.poll(() => q(a.page, 'q.online.remotes[0].remote.bus.ghost'), { timeout: 30_000 }).toBe(true);
  expect(await q(a.page, '!!q.racing.tags.of("Beto")')).toBe(true);
  await expect(a.page.locator('.rh-net')).toBeHidden();

  // Ana still finishes; the room's final results hold Beto as out.
  await a.page.evaluate(() => {
    const q = (window as any).__qbus;
    const r = q.city.race;
    const i = Math.round((r.finish - 60) / 3);
    const [p0, p1] = [r.points[i], r.points[i + 1]];
    q.bus.reset({ x: p0.x, y: r.y[i], z: p0.z, heading: Math.atan2(-(p1.z - p0.z), p1.x - p0.x) });
  });
  await a.page.keyboard.down('KeyW');
  await expect(a.page.locator('.rh-results')).toBeVisible({ timeout: 150_000 });
  // The room waits 90 s past the first finish for a seat that never came back.
  await expect(a.page.locator('.rh-results')).toContainText('retirado', { timeout: 150_000 });

  expect(errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
