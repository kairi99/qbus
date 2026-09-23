import { test, expect, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
const busState = (page: Page) =>
  page.evaluate(() => {
    const { bus } = (window as any).__qbus;
    return { speed: bus.speed as number, heading: bus.heading as number, ...bus.body.translation() };
  });

test('boots, drives, steers and toggles camera', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?city=grid');
  await page.waitForFunction(() => (window as any).__qbus);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/01-start.png` });

  const start = await busState(page);
  // Poll instead of fixed sleeps: software WebGL here runs at ~5 fps, which slows the simulation.
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await busState(page)).speed, { timeout: 20_000 }).toBeGreaterThan(5);
  await page.screenshot({ path: `${shots}/02-driving.png` });

  await page.keyboard.down('KeyA');
  await expect.poll(async () => (await busState(page)).heading - start.heading, { timeout: 20_000 }).toBeGreaterThan(0.2);
  await page.keyboard.up('KeyA');

  await page.keyboard.press('KeyC');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/03-cockpit.png` });
  await page.keyboard.up('KeyW');

  expect(errors).toEqual([]);
});

test('city views', async ({ page }) => {
  await page.goto('/?city=grid');
  await page.waitForFunction(() => (window as any).__qbus);
  const place = (x: number, z: number, heading: number) =>
    page.evaluate(([x, z, heading]) => (window as any).__qbus.bus.reset({ x, y: 0, z, heading }), [x, z, heading]);
  const city = await page.evaluate(() => {
    const c = (window as any).__qbus.city;
    return { ramp: c.features.find((f: any) => f.kind === 'ramp'), stop: c.stops[0], spawn: c.spawn };
  });
  // Down Av. Amazonas.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/10-avenue.png` });
  // Facing a ramp.
  const r = city.ramp;
  await place(r.pos.x - Math.cos(r.heading) * 22, r.pos.z + Math.sin(r.heading) * 22, r.heading);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${shots}/11-ramp.png` });
  // Pulling up to a bus stop.
  const s = city.stop;
  await place(s.pos.x - Math.cos(s.heading) * 20 - Math.sin(s.heading) * 4, s.pos.z + Math.sin(s.heading) * 20 - Math.cos(s.heading) * 4, s.heading);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${shots}/12-stop.png` });
});

test('R rescues a bus stuck off-road back onto the street', async ({ page }) => {
  await page.goto('/?city=grid');
  await page.waitForFunction(() => (window as any).__qbus);
  // Drop the bus tilted in the middle of a block, among buildings.
  await page.evaluate(() => {
    const { bus, city } = (window as any).__qbus;
    const b = city.blocks.find((b: any) => b.kind === 'sidewalk').footprint;
    bus.reset({ x: (b[0].x + b[1].x) / 2 + 3, y: 0, z: (b[0].z + b[2].z) / 2, heading: 0.4 });
    bus.body.setRotation({ x: 0.5, y: 0, z: 0, w: 0.866 }, true);
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(1500);
  const s = await page.evaluate(() => {
    const { bus, city } = (window as any).__qbus;
    const t = bus.body.translation();
    const onRoad = city.roads.some((r: any) => {
      const [a, b] = r.points;
      const along = a.x === b.x ? Math.abs(t.x - a.x) : Math.abs(t.z - a.z);
      return along < r.width / 2;
    });
    const q = bus.body.rotation();
    return { onRoad, upright: 1 - 2 * (q.x * q.x + q.z * q.z), heading: bus.heading, wheels: bus.wheelsOnGround };
  });
  expect(s.onRoad).toBe(true);
  expect(s.upright).toBeGreaterThan(0.95);
  expect(s.wheels).toBe(4);
  // Aligned with the grid: heading is a multiple of 90°.
  expect(Math.abs(Math.sin(2 * s.heading))).toBeLessThan(0.05);
  await page.screenshot({ path: `${shots}/20-after-reset.png` });
});

test('Q looks back at the bus while held', async ({ page }) => {
  await page.goto('/?city=grid');
  await page.waitForFunction(() => (window as any).__qbus);
  const camAhead = () =>
    page.evaluate(() => {
      const { bus, rig } = (window as any).__qbus;
      const t = bus.body.translation();
      const h = bus.heading;
      const c = rig.camera.position;
      return (c.x - t.x) * Math.cos(h) - (c.z - t.z) * Math.sin(h);
    });
  await page.waitForTimeout(800);
  expect(await camAhead()).toBeLessThan(0); // chase camera behind the bus
  await page.keyboard.down('KeyQ');
  await expect.poll(camAhead, { timeout: 10_000 }).toBeGreaterThan(8);
  await page.screenshot({ path: `${shots}/21-look-back.png` });
  await page.keyboard.up('KeyQ');
  await expect.poll(camAhead, { timeout: 10_000 }).toBeLessThan(0);
});

