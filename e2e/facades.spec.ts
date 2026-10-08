import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Free roam on La Mariscal starts on Ignacio de Veintimilla beside a row of one-storey shops,
 * whose signs used to flicker into the cornice (coplanar quads). Screenshots of the spawn
 * (chase cam) and a close-up of the nearest one-storey shop's signs, by day and at night, for a
 * look; the geometry itself is checked in `tests/facades.test.ts`.
 */
const dir = 'e2e/screenshots';
const frames = (page: Page, n: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        let k = 0;
        const f = () => (++k >= n ? done() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );

for (const tod of ['day', 'night'])
  test(`facades: shop signs at the free-roam spawn (${tod})`, async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(dir, { recursive: true });
    await page.goto(`/?play=1&mode=free&city=mariscal&tutorial=0&tod=${tod}`);
    await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
    await frames(page, 10);
    await page.locator('#game').screenshot({ path: `${dir}/facades-spawn-${tod}.png` });

    // The nearest low building with a street in front: look at its front from the sidewalk edge.
    const view = await page.evaluate(() => {
      const { bus, city, groundAt } = (window as any).__qbus;
      const t = bus.body.translation();
      const mid = (f: { x: number; z: number }[]) => ({ x: f.reduce((s, p) => s + p.x, 0) / f.length, z: f.reduce((s, p) => s + p.z, 0) / f.length });
      let best: { c: { x: number; z: number }; d: number } | null = null;
      for (const b of city.buildings) {
        if (b.height > 4 || b.height < 2.5) continue;
        const c = mid(b.footprint);
        const d = Math.hypot(c.x - t.x, c.z - t.z);
        if (d < 60 && (!best || d < best.d)) best = { c, d };
      }
      if (!best) return null;
      const k = 9 / best.d; // 9 m from the building's middle, toward the bus
      const pos = { x: best.c.x + (t.x - best.c.x) * k, z: best.c.z + (t.z - best.c.z) * k };
      const y = groundAt(pos);
      return { pos: { ...pos, y: y + 1.8 }, look: { x: best.c.x, y: y + 2.4, z: best.c.z } };
    });
    expect(view).not.toBeNull();
    await page.addStyleTag({ content: '#hud { display: none !important; }' });
    await page.evaluate((v) => ((window as any).__qbus.rig.debugView = v), view);
    await frames(page, 3);
    await page.locator('#game').screenshot({ path: `${dir}/facades-signs-${tod}.png` });
  });
