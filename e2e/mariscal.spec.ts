import { test, expect, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
const bus = (page: Page) =>
  page.evaluate(() => {
    const { bus } = (window as any).__qbus;
    const t = bus.body.translation();
    return { speed: bus.speed as number, wheels: bus.wheelsOnGround as number, x: t.x, y: t.y, z: t.z, heading: bus.heading as number };
  });

test('La Mariscal: loads real streets with hills, bus drives, traffic runs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto('/?city=mariscal');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const loadMs = Date.now() - t0;
  console.log(`MARISCAL load ${loadMs} ms`);
  const info = await page.evaluate(() => {
    const { city, session } = (window as any).__qbus;
    return { name: city.name, terrain: !!city.terrain, scale: city.terrain?.scale, cars: session.traffic.cars.filter((c: any) => c.state === 'driving').length };
  });
  expect(info.name).toBe('La Mariscal');
  expect(info.terrain).toBe(true);
  expect(info.cars).toBeGreaterThan(8);

  await expect.poll(async () => (await bus(page)).wheels, { timeout: 20_000 }).toBe(4);
  const start = await bus(page);
  expect(start.y).toBeGreaterThan(5); // sitting on real elevation, not y = 0
  await page.screenshot({ path: `${shots}/50-mariscal-start.png` });

  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await bus(page)).speed, { timeout: 30_000 }).toBeGreaterThan(8);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: `${shots}/51-mariscal-driving.png` });

  // Overview from above the spawn, looking along the avenue.
  await page.evaluate(() => {
    const { rig } = (window as any).__qbus;
    rig.overview = true;
  });
  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await bus(page)).wheels, { timeout: 20_000 }).toBe(4);
  expect(errors).toEqual([]);
});

test('La Mariscal: a real bus line route plays with GPS guidance', async ({ page }) => {
  await page.goto('/?play=1&city=mariscal&route=linea-catar-061');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const r = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { line: q.route.line, stops: q.session.game.route.length };
  });
  expect(r.line).toBe('CATAR-061');
  expect(r.stops).toBeGreaterThanOrEqual(15);
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.session.path?.points.length ?? 0), { timeout: 20_000 }).toBeGreaterThan(1);
  await page.screenshot({ path: `${shots}/52-mariscal-real-line.png` });
});

