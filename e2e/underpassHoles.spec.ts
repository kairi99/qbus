import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CityData } from '../src/world/cityData';
import { inPlayArea } from '../src/world/cityData';
import { roadProfiles } from '../src/world/elevation';

/**
 * From inside every underpass, looking ahead, back and to both sides: below the horizon there
 * must be ground, road or wall, never a hole through to the sky (a see-through wall).
 */
test('underpasses have no see-through walls or gaps', async ({ page }) => {
  test.setTimeout(300_000);
  const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
  city.terrain!.scale = 1;
  const profiles = roadProfiles(city);
  const views: { name: string; eye: number[]; at: number[] }[] = [];
  city.roads.forEach((r, i) => {
    const p = profiles[i];
    if (!p || !r.lift!.some((l) => l < -2)) return;
    let next = 0;
    for (let k = 0; k < r.points.length - 1; k++) {
      if (p.cum[k] < next || r.lift![k] > -1.5 || !inPlayArea(city, r.points[k])) continue;
      next = p.cum[k] + 14;
      const [a, b] = [r.points[k], r.points[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const y = p.y[k] + 1.6;
      for (const [tag, dx, dz] of [['ahead', d.x, d.z], ['back', -d.x, -d.z], ['left', d.z, -d.x], ['right', -d.z, d.x]] as const)
        views.push({ name: `${r.name} #${i} at (${a.x.toFixed(0)}, ${a.z.toFixed(0)}) looking ${tag}`, eye: [a.x, y, a.z], at: [a.x + dx * 10, y - 0.3, a.z + dz * 10] });
    }
  });
  expect(views.length).toBeGreaterThan(100);

  await page.goto('/?city=mariscal&play=1&mode=free&hills=1');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  const holes = await page.evaluate((views) => {
    const q = (window as any).__qbus;
    q.renderer.setAnimationLoop(null);
    const W = 256;
    const H = 144;
    const cam = q.rig.camera.clone();
    cam.fov = 75;
    cam.near = 0.1;
    cam.far = 400;
    cam.aspect = W / H;
    const r = q.renderer;
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.autoClear = true;
    // Magenta where nothing is drawn (no sky pass here).
    r.setClearColor(0xff00ff, 1);
    q.scene.background = null;
    const gl = r.getContext();
    const buf = new Uint8Array(W * H * 4);
    const out: string[] = [];
    for (const v of views) {
      cam.position.set(v.eye[0], v.eye[1], v.eye[2]);
      cam.lookAt(v.at[0], v.at[1], v.at[2]);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      r.render(q.scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let n = 0;
      // The lower rows of the image (readPixels starts at the bottom).
      for (let y = 0; y < H * 0.45; y++)
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (buf[i] > 240 && buf[i + 1] < 20 && buf[i + 2] > 240) n++;
        }
      if (n > 20) out.push(`${v.name}: ${n} px`);
    }
    return out;
  }, views);
  expect(holes).toEqual([]);
});
