import { test, expect, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
test.describe.configure({ timeout: 240_000 });

/** Puts the bus down at the bottom of the Patria/12 de Octubre underpass's basin, facing along the road. */
async function intoUnderpass(page: Page) {
  await page.evaluate(() => {
    const { basins, bus } = (window as any).__qbus;
    const basin = basins.reduce((m: any, b: any) => (Math.hypot(b.strips[0].a.x + 65, b.strips[0].a.z - 743) < Math.hypot(m.strips[0].a.x + 65, m.strips[0].a.z - 743) ? b : m));
    const low = basin.strips.reduce((m: any, s: any) => (Math.min(s.ya, s.yb) < Math.min(m.ya, m.yb) ? s : m));
    bus.reset({ x: low.a.x, y: basin.floor, z: low.a.z, heading: Math.atan2(-(low.b.z - low.a.z), low.b.x - low.a.x) });
  });
}

test('a downpour: rain falls, the road is slippery, the underpasses flood and slow the bus', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&mode=free&city=mariscal&tutorial=0&rain=2');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { rain: q.weather.state.rain, grip: q.bus.grip, streaks: q.scene.children.some((o: any) => o.isLineSegments && o.visible) };
  });
  expect(state.rain).toBe(1);
  expect(state.grip).toBeLessThan(0.75);
  expect(state.streaks).toBe(true);
  await page.screenshot({ path: `${shots}/95-rain-street.png` });

  // A flooded underpass: the water stands over its floor, the bus wades and crawls.
  await page.evaluate(() => ((window as any).__qbus.weather.state.flood = 0.6));
  await intoUnderpass(page);
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.wade), { timeout: 30_000 }).toBeGreaterThan(0.2);
  expect(await page.evaluate(() => (window as any).__qbus.scene.getObjectByName('floodwater').visible)).toBe(true);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000);
  const kmh = await page.evaluate(() => Math.abs((window as any).__qbus.bus.speed) * 3.6);
  await page.screenshot({ path: `${shots}/96-rain-flooded-underpass.png` });
  await page.keyboard.up('KeyW');
  expect(kmh).toBeLessThan(30);
  expect(errors).toEqual([]);
});

test('night rain, and no rain with ?rain=0', async ({ page }) => {
  await page.goto('/?play=1&mode=free&city=mariscal&tutorial=0&rain=1&tod=night');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shots}/97-rain-night.png` });
  await page.goto('/?play=1&mode=free&city=mariscal&tutorial=0&rain=0');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).__qbus.weather.state.rain)).toBe(0);
  expect(await page.evaluate(() => (window as any).__qbus.bus.grip)).toBe(1);
});
