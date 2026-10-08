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
  await page.goto('/?tutorial=0&city=mariscal');
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
  // Software WebGL runs the sim slower than real time: give it time rather than a fixed pace.
  await expect.poll(async () => (await bus(page)).speed, { timeout: 60_000 }).toBeGreaterThan(8);
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
  await page.goto('/?tutorial=0&play=1&city=mariscal&route=linea-katar-061');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const r = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { line: q.route.line, stops: q.session.game.route.length };
  });
  expect(r.line).toBe('KATAR-061');
  expect(r.stops).toBeGreaterThanOrEqual(15);
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.session.path?.points.length ?? 0), { timeout: 20_000 }).toBeGreaterThan(1);
  await page.screenshot({ path: `${shots}/52-mariscal-real-line.png` });
});


test('La Mariscal: Trolebús route starts at a median station; Metro entrances have riders', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?tutorial=0&play=1&city=mariscal&route=linea-c4');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const r = await page.evaluate(() => {
    const q = (window as any).__qbus;
    const first = q.session.game.route[0].stop;
    return { system: q.route.system, side: first.side, name: first.name, stations: q.city.stations.length, metro: q.city.metro.length };
  });
  expect(r.system).toBe('trolebus');
  expect(r.side).toBe('left');
  expect(r.stations).toBeGreaterThan(8);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/53-trolebus-start.png` });

  // Look at the first station from the side, then at a Metro entrance.
  const view = async (x: number, z: number, heading: number, back: number, up: number, file: string) => {
    await page.evaluate(
      ([x, z, heading, back, up]) => {
        const q = (window as any).__qbus;
        const y = q.groundAt({ x, z });
        const fx = Math.cos(heading);
        const fz = -Math.sin(heading);
        // From the right of the heading, looking across at the spot.
        q.rig.debugView = { pos: { x: x + fz * -back + fx * 6, y: y + up, z: z + fx * back + fz * 6 }, look: { x, y: y + 1.5, z } };
      },
      [x, z, heading, back, up],
    );
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/${file}` });
  };
  const st = await page.evaluate(() => (window as any).__qbus.city.stations.find((s: any) => s.system === 'trolebus' && s.width > 4));
  await view(st.pos.x, st.pos.z, st.heading, 26, 9, '54-trolebus-station.png');
  const eco = await page.evaluate(() => (window as any).__qbus.city.stations.find((s: any) => s.system === 'ecovia'));
  await view(eco.pos.x, eco.pos.z, eco.heading, 26, 9, '55-ecovia-station.png');
  const m = await page.evaluate(() => (window as any).__qbus.city.metro[0]);
  // Teleport the bus nearby so the crowd there is active.
  await page.evaluate(([x, z]) => {
    const q = (window as any).__qbus;
    q.bus.reset({ x: x + 40, y: q.groundAt({ x: x + 40, z }), z, heading: 0 });
  }, [m.pos.x, m.pos.z]);
  await view(m.pos.x, m.pos.z, m.heading + Math.PI / 2, 14, 5, '56-metro-entrance.png');
  const riders = await page.evaluate(() => (window as any).__qbus.session.metro.peds.length);
  expect(riders).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});

test('La Mariscal: the roadworks at the edge stop the bus, even on nitro', async ({ page }) => {
  await page.goto('/?tutorial=0&city=mariscal');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  // The widest street crossing the south edge; start 45 m inside, driving out.
  const start = await page.evaluate(() => {
    const q = (window as any).__qbus;
    const pa = q.city.playArea;
    let best: any = null;
    for (const r of q.city.roads)
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i];
        const b = r.points[i + 1];
        if ((a.z - pa.max.z) * (b.z - pa.max.z) < 0 && a.x > pa.min.x + 50 && a.x < pa.max.x - 50 && (!best || r.width > best.w)) {
          const u = (pa.max.z - a.z) / (b.z - a.z);
          // Unit vector along the street, pointing out of the play area (south, +z).
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const s = Math.sign(b.z - a.z);
          const d = { x: ((b.x - a.x) / len) * s, z: ((b.z - a.z) / len) * s };
          const cx = a.x + (b.x - a.x) * u;
          best = { x: cx - d.x * 45, z: pa.max.z - d.z * 45, w: r.width, heading: Math.atan2(-d.z, d.x) };
        }
      }
    q.bus.reset({ x: best.x, y: q.groundAt(best), z: best.z, heading: best.heading });
    return best;
  });
  expect(start).not.toBeNull();
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.speed), { timeout: 20_000 }).toBeGreaterThan(8);
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${shots}/57-roadworks.png` });
  await page.keyboard.up('KeyW');
  const z = await page.evaluate(() => (window as any).__qbus.bus.body.translation().z);
  const edge = await page.evaluate(() => (window as any).__qbus.city.playArea.max.z);
  expect(z).toBeLessThan(edge);
});
