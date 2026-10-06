import { test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CityData } from '../src/world/cityData';
import { groundHeightAt } from '../src/world/cityData';
import { buildRoadGraph, dirAt, edgeY, lanePoint } from '../src/world/roadGraph';

/**
 * Recon (not a pass/fail test): renders every lifted drivable edge of La Mariscal from the
 * driver's seat and a chase cam at its start, middle and end, by day and by night, saving PNGs
 * to e2e/screenshots/recon/ and counting "hole" pixels (nothing drawn: magenta with the sky
 * pass off) in the lower part of each view. Run: QBUS_PORT=5182 npx playwright test underpassRecon
 * Env RECON_TOD=day|night|sunset (default: day,night).
 */
const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = 1;
const graph = buildRoadGraph(city);
type View = { name: string; eye: number[]; at: number[] };
const views: View[] = [];
for (const e of graph.edges) {
  if (!e.drivable || !e.lift || !e.lift.some((l) => Math.abs(l) > 1)) continue;
  for (const [tag, u] of [['start', 0.12], ['mid', 0.5], ['end', 0.88]] as const) {
    const s = e.len * u;
    const p = lanePoint(e, s, 0);
    const d = dirAt(e.center, s);
    const y = edgeY(e, s) ?? groundHeightAt(city, p);
    const base = `e${e.id}-${e.road.replace(/[^A-Za-z0-9]+/g, '_')}-${tag}`;
    // Driver's seat of a bus (eye ~2.6 m), looking ahead and a little down.
    views.push({ name: `${base}-driver`, eye: [p.x, y + 2.6, p.z], at: [p.x + d.x * 20, y + 1.6, p.z + d.z * 20] });
    // Chase cam: 13 m behind, 5 m up, at a point 8 m ahead.
    views.push({ name: `${base}-chase`, eye: [p.x - d.x * 13, y + 5, p.z - d.z * 13], at: [p.x + d.x * 8, y + 1.2, p.z + d.z * 8] });
  }
}

for (const tod of (process.env.RECON_TOD ?? 'day,night').split(',')) {
  test(`underpass recon views (${tod})`, async ({ page }) => {
    test.setTimeout(900_000);
    const dir = `e2e/screenshots/recon/${tod}`;
    mkdirSync(dir, { recursive: true });
    await page.goto(`/?city=mariscal&play=1&mode=free&hills=1&tod=${tod}`);
    await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 180_000 });
    const report: string[] = [];
    for (let i = 0; i < views.length; i += 6) {
      const batch = views.slice(i, i + 6);
      const out = await page.evaluate((batch) => {
        const q = (window as any).__qbus;
        q.renderer.setAnimationLoop(null);
        const W = 640;
        const H = 360;
        const r = q.renderer;
        r.setPixelRatio(1);
        r.setSize(W, H, false);
        r.autoClear = true;
        const cam = q.rig.camera.clone();
        cam.fov = 70;
        cam.near = 0.1;
        cam.far = 600;
        cam.aspect = W / H;
        const gl = r.getContext();
        const buf = new Uint8Array(W * H * 4);
        const bg = (q as any).__bg ?? ((q as any).__bg = q.scene.background);
        const res: { name: string; holes: number; png: string }[] = [];
        for (const v of batch) {
          cam.position.set(v.eye[0], v.eye[1], v.eye[2]);
          cam.lookAt(v.at[0], v.at[1], v.at[2]);
          cam.updateProjectionMatrix();
          cam.updateMatrixWorld();
          // Hole pass: nothing drawn = magenta.
          q.scene.background = null;
          r.setClearColor(0xff00ff, 1);
          r.render(q.scene, cam);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          let n = 0;
          for (let y = 0; y < H * 0.45; y++)
            for (let x = 0; x < W; x++) {
              const k = (y * W + x) * 4;
              if (buf[k] > 240 && buf[k + 1] < 20 && buf[k + 2] > 240) n++;
            }
          // Picture pass, with the sky color behind.
          q.scene.background = bg;
          r.render(q.scene, cam);
          res.push({ name: v.name, holes: n, png: r.domElement.toDataURL('image/png') });
        }
        return res;
      }, batch);
      for (const o of out) {
        writeFileSync(`${dir}/${o.name}.png`, Buffer.from(o.png.split(',')[1], 'base64'));
        if (o.holes > 30) report.push(`${o.name}: ${o.holes} hole px in lower 45%`);
      }
    }
    writeFileSync(`${dir}/holes.txt`, report.join('\n') + '\n');
    console.log(`${tod}: ${views.length} views, ${report.length} with holes\n${report.join('\n')}`);
  });
}
