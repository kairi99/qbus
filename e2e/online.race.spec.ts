import { expect, test, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
// Two software-WebGL pages at once: a few frames a second each.
test.describe.configure({ timeout: 480_000 });

const q = (page: Page, fn: string) => page.evaluate(`(() => { const q = window.__qbus; return ${fn}; })()`);

test('two players race online: shared start, each sees the other, results from the room', async ({ browser }) => {
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
  const code = (await codeEl.textContent())!;
  await b.page.locator('input[name="code"]').fill(code);
  await b.page.getByRole('button', { name: 'Unirse' }).click();
  await expect(a.page.locator('.mn-seat[data-seat]')).toHaveCount(2);
  await a.page.locator('input[name="ai"][value="0"]').check();
  // The Silante has landslides, on by default: the lobby asks (guests see the answer) and the link carries it.
  await a.page.locator('input[name="track"][value="silante"]').check();
  await expect(a.page.locator('input[name="slides"][value="on"]')).toBeChecked();
  await expect(b.page.locator('.mn-sum')).toContainText('Derrumbes');
  // The host picks the light and the rain: the same for everyone, whatever each one's own Ajustes say.
  await a.page.locator('input[name="tod"][value="sunset"]').check();
  await a.page.locator('input[name="rain"][value="always"]').check();
  await expect(b.page.locator('.mn-sum')).toContainText('Atardecer');
  await expect(b.page.locator('.mn-sum')).toContainText('Siempre');
  await b.page.getByRole('button', { name: '¡Listo!' }).click();
  const start = a.page.getByRole('button', { name: '¡Arrancar!' });
  await expect(start).toBeEnabled();
  await start.click();

  // Both pages go to the game, wait for each other and get the same GO.
  for (const p of [a.page, b.page]) {
    await p.waitForURL(/mode=online/, { timeout: 30_000 });
    await expect.poll(() => q(p, '!!q?.online'), { timeout: 150_000 }).toBe(true);
  }
  for (const p of [a.page, b.page]) await expect.poll(() => q(p, 'q.racing.game.green'), { timeout: 60_000 }).toBe(true);
  const goA = (await q(a.page, 'q.online.goIn()')) as number;
  const goB = (await q(b.page, 'q.online.goIn()')) as number;
  expect(Math.abs(goA - goB)).toBeLessThan(3);
  // The landslides come from the room's seed and the race clock: both pages have the same sites, the same trigger times, and the same phases about now.
  const slidesOf = (p: Page) => q(p, 'JSON.stringify(q.racing.slideState())') as Promise<string>;
  const [sa, sb] = (await Promise.all([slidesOf(a.page), slidesOf(b.page)])).map((j) => JSON.parse(j) as { phase: string; s: number; side: number; trigger: number }[]);
  expect(sa.length).toBeGreaterThan(0);
  expect(sb.map(({ s, side, trigger }) => ({ s, side, trigger }))).toEqual(sa.map(({ s, side, trigger }) => ({ s, side, trigger })));
  const phases = (x: typeof sa) => x.map((v) => v.phase);
  expect(phases(sb)).toEqual(phases(sa));
  await expect(b.page.locator('.rh-place')).toContainText('/ 2');
  for (const p of [a.page, b.page]) {
    expect(await q(p, 'q.timeOfDay')).toBe('sunset');
    expect(await q(p, 'q.weather.state.rain')).toBeGreaterThan(0);
  }

  // Ana drives off: on Beto's screen her bus moves.
  const remoteX = () => q(b.page, '(() => { const t = q.online.remotes[0].remote.bus.body.translation(); return t.x + t.z; })()') as Promise<number>;
  const before = await remoteX();
  await a.page.keyboard.down('KeyW');
  await expect.poll(async () => Math.abs((await remoteX()) - before), { timeout: 90_000 }).toBeGreaterThan(5);
  // Beto sees Ana's name over her bus, in her color.
  expect(await q(b.page, '!!q.racing.tags?.of("Ana")?.visible')).toBe(true);
  await b.page.screenshot({ path: `${shots}/online-race-tags.png` });
  await a.page.screenshot({ path: `${shots}/online-race-host.png` });
  await b.page.screenshot({ path: `${shots}/online-race-guest.png` });

  // Ana over the line: her results card, Beto still out on the road ("en carrera").
  await a.page.evaluate(() => {
    const q = (window as any).__qbus;
    const r = q.city.race;
    const i = Math.round((r.finish - 60) / 3);
    const [p0, p1] = [r.points[i], r.points[i + 1]];
    q.bus.reset({ x: p0.x, y: r.y[i], z: p0.z, heading: Math.atan2(-(p1.z - p0.z), p1.x - p0.x) });
  });
  await expect(a.page.locator('.rh-results')).toBeVisible({ timeout: 150_000 });
  await expect(a.page.locator('.rh-results')).toContainText('en carrera');
  await expect(a.page.locator('.rh-results [data-act="lobby"]')).toBeVisible();
  await a.page.screenshot({ path: `${shots}/online-race-results.png` });
  // Beto's race knows Ana's real time.
  await expect.poll(() => q(b.page, 'q.racing.game.racers.find((r) => r.name === "Ana")?.time ?? null'), { timeout: 60_000 }).not.toBeNull();

  expect(errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
