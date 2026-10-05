import { test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Performance harness (not part of the normal suite: run with QBUS_PERF=<tag>).
 * Loads La Mariscal on a fixed route, then from fixed camera views records draw calls,
 * triangles and per-frame JS time (`__qbus.perf`), and screenshots the canvas with traffic,
 * people and markers hidden so two runs can be pixel-diffed for visual parity.
 * Writes e2e/screenshots/perf-<tag>.json and perf-<tag>-<view>.png.
 */
const tag = process.env.QBUS_PERF;
test.skip(!tag, 'set QBUS_PERF=<tag> to run the perf harness');

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

/** Averages `__qbus.perf` over n frames. */
const sample = (page: Page, n: number) =>
  page.evaluate(
    (n) =>
      new Promise<Record<string, number>>((done) => {
        const perf = (window as any).__qbus.perf;
        const sum: Record<string, number> = { sim: 0, frame: 0, render: 0, calls: 0, triangles: 0, backdropCalls: 0 };
        let k = 0;
        let last = performance.now();
        let wall = 0;
        const f = () => {
          const now = performance.now();
          wall += now - last;
          last = now;
          for (const key of Object.keys(sum)) sum[key] += perf[key];
          if (++k >= n) {
            for (const key of Object.keys(sum)) sum[key] = Math.round((sum[key] / n) * 100) / 100;
            sum.wallMs = Math.round(wall / n);
            return done(sum);
          }
          requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      }),
    n,
  );

test('perf: La Mariscal draw calls, triangles, frame time, startup', async ({ page }) => {
  test.setTimeout(900_000);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  await page.goto('/?play=1&city=mariscal&route=linea-catar-061&hills=1');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  const loadMs = Date.now() - t0;
  await frames(page, 20);

  const startup = await page.evaluate(() => {
    const m = Object.fromEntries(performance.getEntriesByType('mark').map((e) => [e.name, Math.round(e.startTime)]));
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const js = res.filter((r) => /\.(js|ts|json|wasm)(\?|$)/.test(r.name));
    return { marks: m, resources: js.length, bytes: js.reduce((s, r) => s + (r.decodedBodySize || 0), 0) };
  });

  const scene = await page.evaluate(() => {
    const { scene, backdrop, renderer } = (window as any).__qbus;
    const count = (root: any) => {
      let meshes = 0;
      let tris = 0;
      let shadowCasters = 0;
      const mats = new Set();
      const geos = new Set();
      root.traverse((o: any) => {
        if (!o.isMesh) return;
        meshes++;
        if (o.castShadow) shadowCasters++;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => mats.add(m));
        geos.add(o.geometry);
        const g = o.geometry;
        const n = Number.isFinite(g.drawRange.count) ? g.drawRange.count : g.index ? g.index.count : g.attributes.position.count;
        tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
      });
      return { meshes, materials: mats.size, geometries: geos.size, triangles: Math.round(tris), shadowCasters };
    };
    return { city: count(scene), backdrop: count(backdrop), programs: renderer.info.programs.length, memory: { ...renderer.info.memory } };
  });

  // Live chase camera first (traffic visible), then fixed views with everything moving hidden.
  await frames(page, 10);
  const profile = process.env.QBUS_PROFILE ? await page.context().newCDPSession(page) : null;
  if (profile) {
    await profile.send('Profiler.enable');
    await profile.send('Profiler.setSamplingInterval', { interval: 200 });
    await profile.send('Profiler.start');
  }
  const chase = await sample(page, 10);
  if (profile) {
    const { profile: prof } = await profile.send('Profiler.stop');
    writeFileSync(`${dir}/perf-${tag}.cpuprofile`, JSON.stringify(prof));
  }
  // Same frames without redrawing the shadow map: the difference is the shadow pass.
  await page.evaluate(() => ((window as any).__qbus.renderer.shadowMap.autoUpdate = false));
  await frames(page, 2);
  const noShadow = await sample(page, 3);
  await page.evaluate(() => ((window as any).__qbus.renderer.shadowMap.autoUpdate = true));
  (chase as any).shadowCalls = Math.round(chase.calls - noShadow.calls);
  console.log('chase', JSON.stringify(chase), 'load', loadMs);

  await page.addStyleTag({ content: '#hud { display: none !important; }' });
  await page.evaluate(() => {
    const { session } = (window as any).__qbus;
    const hide = (o: any) => o && (o.visible = false);
    for (const { mesh } of session.trafficView.meshes.values()) hide(mesh);
    for (const v of [session.pedView, session.metroView]) hide(v.body), hide(v.head);
    hide(session.marker.root);
    hide(session.arrow.root);
    // Waiting passengers depend on a time-based seed.
    session.passengers.clear();
    session.passengers.showWaiting = () => {};
  });

  const views = await page.evaluate(() => {
    const { bus, city } = (window as any).__qbus;
    const t = bus.body.translation();
    const h = bus.heading;
    const f = { x: Math.cos(h), z: -Math.sin(h) };
    const at = (along: number, up: number, side = 0) => ({ x: t.x + f.x * along - f.z * side, y: t.y + up, z: t.z + f.z * along + f.x * side });
    const virgen = (city.landmarks ?? []).find((l: any) => l.kind === 'virgen');
    return {
      street: { pos: at(-14, 4), look: at(40, 1) },
      side: { pos: at(5, 2, -25), look: at(5, 2, 20) },
      oblique: { pos: at(-160, 110), look: at(120, 0) },
      top: { pos: at(0, 420, 1), look: at(0, 0) },
      horizon: { pos: at(0, 30), look: virgen ? { x: virgen.pos.x, y: t.y + 60, z: virgen.pos.z } : at(1000, 30) },
    };
  });

  const results: Record<string, unknown> = {};
  for (const [name, view] of Object.entries(views)) {
    await page.evaluate((v) => ((window as any).__qbus.rig.debugView = v), view);
    await frames(page, 2);
    results[name] = await sample(page, 4);
    console.log(name, JSON.stringify(results[name]));
    await page.locator('#game').screenshot({ path: `${dir}/perf-${tag}-${name}.png` });
  }
  const out = { tag, loadMs, startup, scene, chase, views: results };
  writeFileSync(`${dir}/perf-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
