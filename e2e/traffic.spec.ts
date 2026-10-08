import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';

test('streets have moving traffic and pedestrians', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?tutorial=0&city=grid');
  await page.waitForFunction(() => (window as any).__qbus?.session);
  type Snap = { cars: { id: number; x: number; z: number }[]; peds: { x: number; z: number }[] };
  const snap = (): Promise<Snap> =>
    page.evaluate(() => {
      const { traffic, peds } = (window as any).__qbus.session;
      return {
        cars: traffic.cars.filter((c: any) => c.state === 'driving').map((c: any) => ({ id: c.id, x: c.pos.x, z: c.pos.z })),
        peds: peds.peds.map((p: any) => ({ x: p.pos.x, z: p.pos.z })),
      };
    });
  const a = await snap();
  expect(a.cars.length).toBeGreaterThanOrEqual(10);
  expect(a.peds.length).toBeGreaterThan(30);
  // Cars start from a standstill and headless WebGL runs the sim slowly, so poll.
  const movedCount = async () => {
    const b = await snap();
    return b.cars.filter((c) => {
      const o = a.cars.find((x) => x.id === c.id);
      return o && Math.hypot(o.x - c.x, o.z - c.z) > 5;
    }).length;
  };
  await expect.poll(movedCount, { timeout: 30_000 }).toBeGreaterThan(a.cars.length / 2);

  // Look at the nearest car from behind it, and down a street from above for pedestrians.
  await page.evaluate(() => {
    const { session, bus } = (window as any).__qbus;
    const t = bus.body.translation();
    const cars = session.traffic.cars.filter((c: any) => c.state === 'driving' && !c.turn);
    cars.sort((p: any, q: any) => Math.hypot(p.pos.x - t.x, p.pos.z - t.z) - Math.hypot(q.pos.x - t.x, q.pos.z - t.z));
    const c = cars[0];
    bus.reset({ x: c.pos.x - Math.cos(c.heading) * 22, y: 0, z: c.pos.z + Math.sin(c.heading) * 22, heading: c.heading });
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/40-traffic.png` });
  expect(errors).toEqual([]);
});
