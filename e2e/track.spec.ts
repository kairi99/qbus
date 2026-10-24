import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';
test.describe.configure({ timeout: 240_000 });

for (const track of ['papallacta', 'silante', 'rioverde']) test(`the ${track} track: free roam on the mountain road, rails and drops, start gantry`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?play=1&mode=free&city=${track}&tutorial=0&rain=0`);
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 90_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}/a0-${track}-start.png` });

  const onRoad = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { wheels: q.bus.wheelsOnGround, y: q.bus.roadHeight(), race: !!q.city.race };
  });
  expect(onRoad.race).toBe(true);
  expect(onRoad.wheels).toBe(4);
  // Teleports along the track (to s meters), looking ahead.
  const goTo = (s: number) =>
    page.evaluate((s) => {
      const q = (window as any).__qbus;
      const r = q.city.race;
      const i = Math.min(r.points.length - 2, Math.round(s / 3));
      const [a, b] = [r.points[i], r.points[i + 1]];
      q.bus.reset({ x: a.x, y: r.y[i], z: a.z, heading: Math.atan2(-(b.z - a.z), b.x - a.x) });
    }, s);
  // Straight stretches, then the sharpest bends (ravine edges on both sides).
  for (const s of [175, 900, 2400, 4200, 1640, 710, 1840, 3520]) {
    await goTo(s);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${shots}/a1-${track}-${s}.png` });
  }
  // Draw calls stay well under La Mariscal's chase view (~380): 52 to 155 measured by view.
  const perf = await page.evaluate(() => (window as any).__qbus.perf);
  expect(perf.calls).toBeLessThan(250);
  // Over the edge of an open drop: "¡Al barranco!", then back on the road behind it. The bus is
  // dropped onto the slope at the first spot along an open drop that is 10 m under the road.
  const placed = await page.evaluate(() => {
    const q = (window as any).__qbus;
    const r = q.city.race;
    for (const d of r.drops)
      for (let s = d.s0; s < d.s1; s += 3) {
        const i = Math.round(s / 3);
        const [a, b] = [r.points[i], r.points[i + 1]];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        const [dx, dz] = [(b.x - a.x) / l, (b.z - a.z) / l];
        for (let off = 8; off < 30; off += 2) {
          const p = { x: a.x - dz * off * d.side, z: a.z + dx * off * d.side };
          const g = q.groundAt(p);
          if (r.y[i] - g < 10) continue;
          q.bus.reset({ x: p.x, y: g, z: p.z, heading: Math.atan2(-dz, dx) });
          return true;
        }
      }
    return false;
  });
  expect(placed).toBe(true);
  // (Polled on the game's state: at a couple of frames a second the popup can come and go between polls.)
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.fall.falling), { timeout: 20_000 }).toBe(true);
  await page.screenshot({ path: `${shots}/a2-${track}-fell.png` });
  await expect
    .poll(async () => page.evaluate(() => { const q = (window as any).__qbus; return !q.fall.falling && q.bus.wheelsOnGround === 4; }), { timeout: 60_000 })
    .toBe(true);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/a3-${track}-respawned.png` });
  expect(errors).toEqual([]);
});

test('the Zona Rosa circuit: a race on Amazonas with the city around it, no mountain systems', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/?play=1&mode=race&city=zonarosa&tutorial=0&rain=0&rivals=1&traffic=1');
  await page.waitForFunction(() => (window as any).__qbus?.racing, null, { timeout: 90_000 });
  const info = await page.evaluate(() => {
    const q = (window as any).__qbus;
    const r = q.city.race;
    const p = q.bus.position();
    const c = r.circuit;
    // Where the bus is on the lap, and which street (the nearest road's name).
    return { laps: c.laps, lap: c.lap, start: r.start, finish: r.finish, p: { x: p.x, z: p.z }, line: r.points[r.cum.findIndex((v: number) => v >= r.start)], cars: q.session.traffic.cars?.length ?? 0, scale: q.city.terrain.scale, fog: q.scene.fog.far };
  });
  expect(info.laps).toBe(3);
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.wheelsOnGround), { timeout: 30_000 }).toBe(4);
  expect(info.cars).toBe(0);
  expect(info.scale).toBe(1);
  expect(info.fog).toBeLessThan(10_000);
  // On the grid, a few tens of meters behind the line.
  expect(Math.hypot(info.p.x - info.line.x, info.p.z - info.line.z)).toBeLessThan(60);
  await expect(page.locator('.rh-lap')).toContainText('Vuelta 1/3');
  await page.screenshot({ path: `${shots}/a4-zonarosa-grid.png` });
  // The dressing from the driver's side: the line's gantry, the chicane and Plaza Foch (the bus put on the lap there, facing along it).
  const at = (x: number, z: number, back: number) =>
    page.evaluate(
      ([x, z, back]) => {
        const q = (window as any).__qbus;
        const pts: { x: number; z: number }[] = q.city.race.circuit.data.points;
        let k = 0;
        pts.forEach((p, i) => {
          if (Math.hypot(p.x - x, p.z - z) < Math.hypot(pts[k].x - x, pts[k].z - z)) k = i;
        });
        const i = (k - Math.round(back / 2) + pts.length - 1) % (pts.length - 1);
        const [a, b] = [pts[i], pts[i + 1]];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        q.bus.reset({ x: a.x, y: q.groundAt(a) + 0.5, z: a.z, heading: Math.atan2(-(b.z - a.z) / l, (b.x - a.x) / l) });
      },
      [x, z, back],
    );
  // The mouth nearest the chicane, for the side-street crowd.
  const mouth: { x: number; z: number } = await page.evaluate(() => {
    const c = (window as any).__qbus.city.race.circuit.data;
    let acc = 0;
    const cum = c.points.map((p: any, i: number) => (acc += i ? Math.hypot(p.x - c.points[i - 1].x, p.z - c.points[i - 1].z) : 0));
    let best = { x: 0, z: 0, d: Infinity };
    for (const m of c.mouths) { const i = cum.findIndex((v: number) => v >= m.s); const p = c.points[i]; const d = Math.hypot(p.x - 325, p.z - -205); if (d < best.d) best = { x: p.x, z: p.z, d }; }
    return best;
  });
  const line = info.line;
  for (const [name, x, z, back] of [['z1-line', line.x, line.z, 30], ['z2-chicane', mouth.x, mouth.z, 12], ['z3-foch', 272, -94, 25]] as const) {
    await at(x, z, back);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${shots}/${name}.png` });
    const perf = await page.evaluate(() => (window as any).__qbus.perf);
    test.info().annotations.push({ type: `draw calls at ${name}`, description: `${perf.calls} calls, ${perf.triangles} triangles` });
  }
  // A lap: after GO the bus is put back along the lap in steps (the laps overlap, so the session finds the bus from where it was last
  // known: a jump to the line's own spot would read as the lead-in), the last one 40 m short of the line that closes lap 1.
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.racing.game.green), { timeout: 120_000 }).toBe(true);
  await page.keyboard.down('KeyW');
  for (const short of [700, 500, 300, 150, 40]) {
    const want = await page.evaluate((short) => {
      const q = (window as any).__qbus;
      const r = q.city.race;
      const i = r.cum.findIndex((v: number) => v >= r.start + r.circuit.lap - short);
      const [a, b] = [r.points[i - 1], r.points[i]];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      q.bus.reset({ x: a.x, y: q.groundAt(a) + 0.5, z: a.z, heading: Math.atan2(-(b.z - a.z) / l, (b.x - a.x) / l) });
      return r.circuit.lap - short;
    }, short);
    // Progress (m past the line) follows the bus to where it was put.
    await expect.poll(() => page.evaluate((w) => Math.abs((window as any).__qbus.racing.game.racers[0].s - w), want), { timeout: 60_000 }).toBeLessThan(60);
  }
  await expect(page.locator('.rh-lap')).toContainText('Vuelta 2/3', { timeout: 120_000 });
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: `${shots}/z4-lap2.png` });
  expect(errors).toEqual([]);
});
