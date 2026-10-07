import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { catalog, loadCity } from '../tests/underpass/catalog';
import { buildRoadGraph, dirAt, edgeLift, edgeY, lanePoint } from '../src/world/roadGraph';
import { groundHeightAt } from '../src/world/cityData';
import { RENDER } from '../tests/underpass/thresholds';

/**
 * Every passage through every underpass and bridge in the catalog (tests/underpass/catalog.ts),
 * seen from the driver's seat and the chase camera (where the game puts them for the "popular"
 * bus), and from the seat looking to both sides: below the horizon there must be ground, road or
 * wall, never nothing (magenta here: no sky pass). Saves the views at each passage's deepest/highest
 * point, and every view with a hole, to e2e/screenshots/underpasses/ for human review.
 *
 * Known holes are listed in KNOWN_HOLES (view name → what was seen); the test fails on any other.
 */
const KNOWN_HOLES: Record<string, string> = {
  // (The first run's slit to the sky in the side of the main 12 de Octubre cut at (-28, 730) is
  // fixed: the cut's wall now stands under the S→N link where that ramp rises alongside it.)
};

const OUT = 'e2e/screenshots/underpasses';
/** Popular bus: seat and chase camera offsets as in CameraRig (see src/camera/cameraRig.ts). */
const RIDE = 1.53; // chassis center over the road when settled
const SEAT = { fwd: 11 / 2 - 1.6, up: 3.0 * 0.32, left: 2.5 / 2 - 0.75 };
const CHASE = { back: 11 * 1.3, up: 7 };

interface View {
  name: string;
  file?: string;
  eye: number[];
  at: number[];
  big?: boolean;
}

test('underpasses and bridges: no holes from the seat or the chase camera', async ({ page }) => {
  test.setTimeout(900_000);
  const city = loadCity('mariscal', 1);
  const graph = buildRoadGraph(city);
  const views: View[] = [];
  const slug = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 90);
  for (const st of catalog(city, graph))
    for (const p of st.passages) {
      const sign = st.kind === 'cut' ? -1 : 1;
      const pts: { edge: number; s: number; extreme: boolean }[] = [];
      for (const id of p.edges) {
        const e = graph.edges[id];
        for (let s = RENDER.STEP / 2; s < e.len; s += RENDER.STEP) if (edgeLift(e, s) * sign > 1.5) pts.push({ edge: id, s, extreme: false });
      }
      pts.push({ edge: p.extreme.edge, s: p.extreme.s, extreme: true });
      for (const { edge, s, extreme } of pts) {
        const e = graph.edges[edge];
        const q = lanePoint(e, s, 0);
        const d = dirAt(e.center, s);
        const y = (edgeY(e, s) ?? groundHeightAt(city, q)) + RIDE;
        const left = { x: d.z, z: -d.x };
        const seat = [q.x + d.x * SEAT.fwd + left.x * SEAT.left, y + SEAT.up, q.z + d.z * SEAT.fwd + left.z * SEAT.left];
        const tag = `${p.id} e${edge} s ${s.toFixed(0)} (${q.x.toFixed(0)}, ${q.z.toFixed(0)})`;
        const file = extreme ? `${OUT}/${slug(p.id)}` : undefined;
        views.push({ name: `${tag} seat ahead`, file: file && `${file}-seat.png`, big: extreme, eye: seat, at: [seat[0] + d.x * 20, seat[1] - 0.6, seat[2] + d.z * 20] });
        views.push({
          name: `${tag} chase`,
          file: file && `${file}-chase.png`,
          big: extreme,
          eye: [q.x - d.x * CHASE.back, y + CHASE.up, q.z - d.z * CHASE.back],
          at: [q.x + d.x * 10, y + 1, q.z + d.z * 10],
        });
        for (const [side, sx, sz] of [['left', left.x, left.z], ['right', -left.x, -left.z]] as const)
          views.push({ name: `${tag} seat ${side}`, eye: seat, at: [seat[0] + sx * 10, seat[1] - 0.3, seat[2] + sz * 10] });
      }
    }
  expect(views.length).toBeGreaterThan(50);
  mkdirSync(OUT, { recursive: true });

  await page.goto('/?city=mariscal&play=1&mode=free&hills=1');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  const results = await page.evaluate(
    ({ views, holePx }) => {
      const q = (window as any).__qbus;
      q.renderer.setAnimationLoop(null);
      const r = q.renderer;
      const cam = q.rig.camera.clone();
      cam.fov = 75;
      cam.near = 0.1;
      cam.far = 400;
      r.setPixelRatio(1);
      r.autoClear = true;
      // Magenta where nothing is drawn (no sky pass here).
      r.setClearColor(0xff00ff, 1);
      q.scene.background = null;
      const gl = r.getContext();
      const out: { name: string; px: number; png?: string }[] = [];
      for (const v of views) {
        const [W, H] = v.big ? [640, 360] : [256, 144];
        r.setSize(W, H, false);
        cam.aspect = W / H;
        cam.position.set(v.eye[0], v.eye[1], v.eye[2]);
        cam.lookAt(v.at[0], v.at[1], v.at[2]);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        r.render(q.scene, cam);
        const buf = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let n = 0;
        // The lower rows of the image (readPixels starts at the bottom), scaled to 256 px wide.
        for (let y = 0; y < H * 0.45; y++)
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (buf[i] > 240 && buf[i + 1] < 20 && buf[i + 2] > 240) n++;
          }
        const px = Math.round((n * 256 * 144) / (W * H));
        const keep = v.file || px > holePx;
        out.push({ name: v.name, px, png: keep ? r.domElement.toDataURL('image/png') : undefined });
      }
      return out;
    },
    { views, holePx: RENDER.HOLE_PX },
  );

  const holes: string[] = [];
  results.forEach((res, i) => {
    const v = views[i];
    const file = v.file ?? (res.px > RENDER.HOLE_PX ? `${OUT}/hole-${slug(v.name)}.png` : undefined);
    if (file && res.png) writeFileSync(file, Buffer.from(res.png.split(',')[1], 'base64'));
    if (res.px > RENDER.HOLE_PX && !KNOWN_HOLES[v.name]) holes.push(`${v.name}: ${res.px} px`);
  });
  const fixed = Object.keys(KNOWN_HOLES).filter((name) => !results.some((r) => r.name === name && r.px > RENDER.HOLE_PX));
  console.log(`${views.length} views, ${results.filter((r) => r.px > RENDER.HOLE_PX).length} with holes; screenshots in ${OUT}/`);
  expect(holes, 'new holes').toEqual([]);
  expect(fixed, 'known holes that are gone: delete them from KNOWN_HOLES').toEqual([]);
});
