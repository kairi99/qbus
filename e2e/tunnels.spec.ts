import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';
test.describe.configure({ timeout: 300_000 });

/** Río Verde's tunnels and waterfalls: the bore reads as a closed tunnel (lamps, no sky or terrain holes), portals, falls. */
test('rioverde: inside the tunnels, at the portals and at a waterfall', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&mode=free&city=rioverde&tutorial=0&rain=0');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  const tunnels: { s0: number; s1: number }[] = await page.evaluate(() => (window as any).__qbus.city.race.tunnels);
  expect(tunnels).toHaveLength(4);
  const goTo = (s: number, lane = 2.1) =>
    page.evaluate(
      ([s, lane]) => {
        const q = (window as any).__qbus;
        const r = q.city.race;
        const i = Math.min(r.points.length - 2, Math.round(s / 3));
        const [a, b] = [r.points[i], r.points[i + 1]];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        const [dx, dz] = [(b.x - a.x) / l, (b.z - a.z) / l];
        q.bus.reset({ x: a.x - dz * lane, y: r.y[i], z: a.z + dx * lane, heading: Math.atan2(-dz, dx) });
      },
      [s, lane],
    );
  let n = 0;
  for (const t of tunnels) {
    n++;
    for (const [tag, s] of [
      ['before', t.s0 - 30],
      ['mouth', t.s0 + 6],
      ['mid', (t.s0 + t.s1) / 2],
      ['out', t.s1 - 8],
      ['after', t.s1 + 25],
    ] as const) {
      await goTo(s);
      await page.waitForTimeout(1600);
      await page.screenshot({ path: `${shots}/t${n}-${tag}.png` });
      if (tag === 'mid' || tag === 'mouth') {
        const perf = await page.evaluate(() => (window as any).__qbus.perf);
        test.info().annotations.push({ type: `draw calls ${tag} of tunnel ${n}`, description: `${perf.calls} calls, ${perf.triangles} triangles` });
        expect(perf.calls).toBeLessThan(250);
      }
    }
  }
  // Each waterfall and each bridge: from the road, a little before the nearest point.
  const near: { name: string; s: number }[] = await page.evaluate(() => {
    const r = (window as any).__qbus.city.race;
    const out: { name: string; s: number }[] = [];
    for (const w of r.scenery.waterfalls ?? []) {
      const p = w.points[0];
      let best = Infinity;
      let s = 0;
      r.points.forEach((q: any, i: number) => {
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < best) [best, s] = [d, r.cum[i]];
      });
      out.push({ name: w.name ?? 'falls', s });
    }
    for (const b of r.bridges ?? []) out.push({ name: 'bridge', s: (b.s0 + b.s1) / 2 });
    return out;
  });
  let k = 0;
  for (const w of near) {
    k++;
    await goTo(Math.max(10, w.s - 30));
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${shots}/f${k}-${w.name.replace(/\W+/g, '-')}.png` });
  }
  expect(errors).toEqual([]);
});
