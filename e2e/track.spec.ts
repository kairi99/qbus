import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';
test.describe.configure({ timeout: 240_000 });

for (const track of ['papallacta', 'silante']) test(`the ${track} track: free roam on the mountain road, rails and drops, start gantry`, async ({ page }) => {
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
