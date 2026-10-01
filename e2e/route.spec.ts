import { test, expect, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
const state = (page: Page) =>
  page.evaluate(() => {
    const g = (window as any).__qbus.session.game;
    return { active: g.activeIndex, onBoard: g.onBoard.length, cents: g.cents, delivered: g.delivered, over: g.over, time: g.timeLeft };
  });

/** Teleport to just before the active stop, facing along it, so the bus rolls to a stop inside the zone. */
const parkAtActive = (page: Page) =>
  page.evaluate(() => {
    const { session, bus } = (window as any).__qbus;
    const { zone, stop } = session.game.activeStop;
    const t = (window as any).__qbus.city.terrain;
    bus.reset({ x: zone.x, y: t ? (window as any).__qbus.groundAt(zone) : 0, z: zone.z, heading: stop.heading });
  });

// The Trolebús route boards at median stations, through the left door.
const SHIFTS: [string, string][] = [
  ['grid', '/?city=grid'],
  ['mariscal', '/?city=mariscal'],
  ['trolebus', '/?play=1&city=mariscal&route=linea-c4'],
];

for (const [city, url] of SHIFTS) test(`a shift on ${city}: start, pick up, drop off, results, restart`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await page.waitForTimeout(800);
  await expect(page.locator('.gh-prompt')).toBeVisible();
  await page.screenshot({ path: `${shots}/30-route-start-${city}.png` });

  // Clock starts on throttle.
  // Hold until a frame has seen it: first frames can be slow while shaders compile.
  await page.keyboard.down('KeyW');
  await expect(page.locator('.gh-prompt')).toBeHidden({ timeout: 20_000 });
  await page.keyboard.up('KeyW');
  const s0 = await state(page);
  expect(s0.time).toBeLessThan(90);

  // Serve stops until someone has been dropped off.
  let served = 0;
  while ((await state(page)).delivered === 0 && served < 8) {
    const before = (await state(page)).active;
    await page.evaluate(() => ((window as any).__qbus.session.game.timeLeft = 90));
    await parkAtActive(page);
    await expect.poll(async () => (await state(page)).active, { timeout: 20_000 }).not.toBe(before);
    served++;
    if (served === 1) {
      expect((await state(page)).onBoard).toBeGreaterThan(0);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/31-boarding-${city}.png` });
    }
  }
  const s1 = await state(page);
  expect(s1.delivered).toBeGreaterThan(0);
  expect(s1.cents).toBeGreaterThanOrEqual(35 * s1.delivered);
  await page.screenshot({ path: `${shots}/32-dropoff-${city}.png` });

  // Drive away a bit in chase view to show the arrow and marker.
  await page.evaluate(() => {
    const { session, bus } = (window as any).__qbus;
    const { zone, stop } = session.game.activeStop;
    const p = { x: zone.x - Math.cos(stop.heading) * 45, z: zone.z + Math.sin(stop.heading) * 45 };
    bus.reset({ ...p, y: (window as any).__qbus.groundAt(p), heading: stop.heading });
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${shots}/33-arrow-${city}.png` });

  // Time runs out -> results; Enter -> new shift.
  await page.evaluate(() => ((window as any).__qbus.session.game.timeLeft = 0.2));
  await expect(page.locator('[data-k="results"]')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${shots}/34-results-${city}.png` });
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-k="results"]')).toBeHidden();
  const s2 = await state(page);
  expect(s2.over).toBe(false);
  expect(s2.cents).toBe(0);
  expect(errors).toEqual([]);
});
