/**
 * Geometry and colliders of every underpass and bridge: nothing solid in a bus's way on any
 * lane, no lips or holes in the road surface, the terrain heightfield kept under the asphalt in
 * cuts, and what's drawn matches what's solid beside the lanes. See README.md.
 */
import { beforeAll, describe, expect } from 'vitest';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { groundHeightAt } from '../../src/world/cityData';
import { profileAt, roadProfiles } from '../../src/world/elevation';
import { dirAt, edgeY, lanePoint } from '../../src/world/roadGraph';
import { type Passage, routePath } from './catalog';
import { check, known } from './known';
import { DrawnSoup, SMALL_SOLIDS, solidLooking } from './meshes';
import { fmt, intrusions, rayDistance, surfaceBelow, yawPitchRoll } from './probe';
import { type Built, buildAll, cityAndCatalog } from './setup';
import { GEOMETRY } from './thresholds';

// Observed on the harness's first run (2026-10-06, La Mariscal at DEFAULT_HILLS), updated after
// the collision fixes of 2026-10-07 (what's left): the test's own findings. Delete an entry once
// its bug is fixed (the it.fails turns red to tell you).
known({
  "swept bus volume is clear on every lane bridge Av. Patria @(-658,290): Av. Patria [e167→e517]":
    "1 found: e517 Av. Patria lane 1 s 49–50: 0.27 m deep at (-588.5, 346.4, y 24.04) shape 9",
  "road surface has no lips, holes or height mismatches bridge Av. Patria @(-658,290): Av. Patria [e167→e517]":
    "3 found: lip 0.09 m at (-634.6, 324.7, y 28.89); lip 0.15 m at (-634.0, 325.1, y 28.74)",
  "drawn walls and solid walls agree beside the lanes bridge Av. Patria @(-658,290): Av. Patria [e167→e517]":
    "31 found: drawn but not solid: e167 lane 0 s 0 2 m up looking left from (-696.6, 233.7, y 24.81): drawn at 6.20 m, solid none; drawn but not solid: e167 lane 0 s 2 2 m up looking left from (-695.8, 235.6, y 24.84): drawn at 6.23 m, solid none",
  "swept bus volume is clear on every lane bridge Av. Patria @(-658,290): Av. Patria → Alfredo Perez Guerrero [e575→e895]":
    "1 found: e575 Av. Patria lane 1 s 82–86: 0.16 m deep at (-587.5, 339.1, y 24.12) shape 9",
  "road surface has no lips, holes or height mismatches bridge Av. Patria @(-658,290): Av. Patria → Alfredo Perez Guerrero [e575→e895]":
    "11 found: surface off the graph height by -0.30 m on e700 Av. Patria lane 2 at (-490.1, 394.0, y 24.14); surface off the graph height by -0.47 m on e700 Av. Patria lane 3 at (-492.7, 396.6, y 24.14)",
  "swept bus volume is clear on every lane cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e276→e276]":
    "4 found: e276 Av. 10 de Agosto lane 2 s 61–61: 0.06 m deep at (-192.2, -820.0, y 17.85) shape 6; e276 Av. 10 de Agosto lane 2 s 71–71: 0.15 m deep at (-188.2, -829.0, y 16.67) shape 6",
  "road surface has no lips, holes or height mismatches cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e276→e276]":
    "1 found: surface off the graph height by 0.29 m on e276 Av. 10 de Agosto lane 2 at (-202.9, -792.2, y 20.40)",
  "road surface has no lips, holes or height mismatches cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e564→e564]":
    "3 found: surface off the graph height by 0.35 m on e564 Av. 10 de Agosto lane 0 at (-210.1, -805.0, y 21.32); surface off the graph height by -0.87 m on e564 Av. 10 de Agosto lane 2 at (-204.3, -800.1, y 21.40)",
  "road surface has no lips, holes or height mismatches cut Av. 12 de Octubre @(-43,733): sin nombre [e585→e524]":
    "6 found: lip 0.15 m at (-4.3, 700.4, y 16.01); lip 0.08 m at (-4.8, 700.6, y 15.86)",
  "road surface has no lips, holes or height mismatches cut Av. 12 de Octubre @(-43,733): Av. 12 de Octubre [e586→e156]":
    "8 found: lip 0.06 m at (-2.1, 705.1, y 16.03); lip 0.15 m at (-2.1, 705.1, y 16.03)",
  "road surface has no lips, holes or height mismatches cut Av. 12 de Octubre @(-43,733): sin nombre [e588→e160]":
    "8 found: lip 0.06 m at (-127.7, 792.8, y 22.39); lip 0.09 m at (-127.2, 792.6, y 22.43)",
  "road surface has no lips, holes or height mismatches cut Av. 12 de Octubre @(-43,733): Av. 12 de Octubre [e589→e241]":
    "10 found: surface off the graph height by 0.43 m on e589 Av. 12 de Octubre lane 1 at (-115.3, 776.9, y 20.57); lip 0.06 m at (-128.2, 789.3, y 22.50)",
  "road surface has no lips, holes or height mismatches cut José Riofrío @(-867,851): sin nombre [e297→e297]":
    "2 found: lip 0.13 m at (-788.8, 830.0, y 25.88); lip 0.12 m at (-788.4, 829.8, y 25.76)",
  "road surface has no lips, holes or height mismatches cut sin nombre @(-652,321): sin nombre [e197→e199]":
    "6 found: surface off the graph height by -0.30 m on e700 Av. Patria lane 2 at (-490.1, 394.0, y 24.14); surface off the graph height by -0.47 m on e700 Av. Patria lane 3 at (-492.7, 396.6, y 24.14)",
  "drawn walls and solid walls agree beside the lanes cut sin nombre @(-652,321): sin nombre [e197→e199]":
    "8 found: drawn but not solid: e197 lane 0 s 88 0.6 m up looking right from (-590.2, 341.4, y 22.84): drawn at 2.56 m, solid 8.62 m; drawn but not solid: e197 lane 0 s 88 0.6 m up looking left from (-590.2, 341.4, y 22.84): drawn at 2.48 m, solid none",
  "road surface has no lips, holes or height mismatches cut sin nombre @(-876,-220): sin nombre [e516→e516]":
    "6 found: surface off the graph height by 0.27 m on e516 sin nombre lane 2 at (-845.3, -320.0, y 27.72); lip 0.10 m at (-862.0, -249.6, y 23.13)",
});

/** Approach/exit stretch next to the structure included in the checks (ramp ends, joints). */
const JOINT_REACH = 25;
/** Most findings listed per test (the count is always given). */
const LIST = 8;

const base = cityAndCatalog();
const { city, graph, structures } = base;
let built: Built;
let heightfield: RAPIER_T.Collider;
beforeAll(async () => {
  built = await buildAll(base);
  built.world.forEachCollider((c) => {
    if (c.shapeType() === 7) heightfield = c;
  });
}, 120_000);

const ref = (e: (typeof graph.edges)[number], s: number) => edgeY(e, s) ?? groundHeightAt(city, lanePoint(e, Math.max(0, Math.min(e.len, s)), 0));

/** Edge stretches to check for a passage: its edges, plus the joint ends of the approach and exit. */
function stretches(p: Passage): { edge: number; s0: number; s1: number }[] {
  const out = p.edges.map((id) => ({ edge: id, s0: 0, s1: graph.edges[id].len }));
  const before = p.route[p.first - 1];
  const after = p.route[p.first + p.edges.length];
  if (before !== undefined) out.unshift({ edge: before, s0: Math.max(0, graph.edges[before].len - JOINT_REACH), s1: graph.edges[before].len });
  if (after !== undefined) out.push({ edge: after, s0: 0, s1: Math.min(graph.edges[after].len, JOINT_REACH) });
  return out;
}

function report(found: string[]): string {
  return `${found.length} found:\n${found.slice(0, LIST).join('\n')}${found.length > LIST ? '\n...' : ''}`;
}

for (const st of structures.filter((x) => x.passages.length))
  describe(st.id, () => {
    for (const p of st.passages) {
      check(`swept bus volume is clear on every lane ${p.id}`, () => {
        const { BUS_WIDTH: W, BUS_HEIGHT: H, BUS_CLEAR, STEP } = GEOMETRY;
        const found: string[] = [];
        for (const { edge, s0, s1 } of stretches(p)) {
          const e = graph.edges[edge];
          for (let k = 0; k < e.lanes; k++) {
            let run: { from: number; to: number; depth: number; at: string } | null = null;
            const flush = () => run && found.push(`e${edge} ${e.road} lane ${k} s ${run.from.toFixed(0)}–${run.to.toFixed(0)}: ${run.depth.toFixed(2)} m deep at ${run.at}`);
            for (let s = s0 + 0.5; s <= s1 - 0.5; s += STEP) {
              const q = lanePoint(e, s, k);
              const d = dirAt(e.center, s);
              const y = ref(e, s);
              const pitch = Math.atan2(ref(e, s + 2) - ref(e, s - 2), 4);
              const hits = intrusions(built.world, { x: q.x, y: y + BUS_CLEAR + H / 2, z: q.z }, yawPitchRoll(Math.atan2(-d.z, d.x), pitch), { x: 0.5, y: H / 2, z: W / 2 });
              if (hits.length) {
                const w = hits.reduce((a, b) => (a.depth > b.depth ? a : b));
                if (run && s - run.to <= STEP + 1e-6) {
                  run.to = s;
                  if (w.depth > run.depth) (run.depth = w.depth), (run.at = `${fmt(w.point)} shape ${w.shape}`);
                } else {
                  flush();
                  run = { from: s, to: s, depth: w.depth, at: `${fmt(w.point)} shape ${w.shape}` };
                }
              }
            }
            flush();
          }
        }
        expect(found, report(found)).toEqual([]);
      });

      check(`road surface has no lips, holes or height mismatches ${p.id}`, () => {
        const found: string[] = [];
        // Along the edges (all lanes): physical road vs the graph's height, and holes.
        for (const { edge, s0, s1 } of stretches(p)) {
          const e = graph.edges[edge];
          for (let k = 0; k < e.lanes; k++) {
            let worst: { off: number; at: string } | null = null;
            for (let s = s0; s <= s1; s += 0.5) {
              const q = lanePoint(e, s, k);
              const y = ref(e, s);
              const h = surfaceBelow(built.world, q, y + 1.5, 4);
              if (h === null) found.push(`hole: nothing under e${edge} lane ${k} at ${fmt({ ...q, y })}`);
              else if (Math.abs(h - y) > GEOMETRY.SURFACE_TOL && (!worst || Math.abs(h - y) > Math.abs(worst.off))) worst = { off: h - y, at: fmt({ ...q, y }) };
            }
            if (worst) found.push(`surface off the graph height by ${worst.off.toFixed(2)} m on e${edge} ${e.road} lane ${k} at ${worst.at}`);
          }
        }
        // Along the curb lane's path straight through (junction crossings included): lips.
        const route = p.route.slice(Math.max(0, p.first - 1), p.first + p.edges.length + 1);
        const path = routePath(graph, route);
        const pts: { x: number; z: number }[] = [];
        for (let i = 0; i < path.points.length - 1; i++) {
          const [a, b] = [path.points[i], path.points[i + 1]];
          const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 0.5));
          for (let j = 0; j < n; j++) pts.push({ x: a.x + ((b.x - a.x) * j) / n, z: a.z + ((b.z - a.z) * j) / n });
        }
        let prevY = ref(graph.edges[route[0]], 0);
        const hs: (number | null)[] = pts.map((q) => {
          // Look down from just above the last height (under any deck or roof above).
          const h = surfaceBelow(built.world, q, prevY + 1.2, 3);
          if (h !== null) prevY = h;
          return h;
        });
        for (let i = 1; i < hs.length - 1; i++) {
          const [a, b, c] = [hs[i - 1], hs[i], hs[i + 1]];
          if (a === null || b === null || c === null) continue;
          const kink = Math.abs(a - 2 * b + c);
          if (kink > GEOMETRY.LIP_M) found.push(`lip ${kink.toFixed(2)} m at ${fmt({ ...pts[i], y: b })}`);
        }
        expect(found, report(found)).toEqual([]);
      });

      check(`drawn walls and solid walls agree beside the lanes ${p.id}`, () => {
        const xs = p.route.flatMap((id) => graph.edges[id].center.pts.map((q) => q.x));
        const zs = p.route.flatMap((id) => graph.edges[id].center.pts.map((q) => q.z));
        const pad = GEOMETRY.SIDE_REACH + 15;
        const soup = new DrawnSoup(built.scene, { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, z0: Math.min(...zs) - pad, z1: Math.max(...zs) + pad }, solidLooking);
        const found: string[] = [];
        const tol = GEOMETRY.PARITY_TOL;
        for (const { edge, s0, s1 } of stretches(p)) {
          const e = graph.edges[edge];
          for (const k of new Set([0, e.lanes - 1]))
            for (let s = s0; s <= s1; s += 2) {
              const q = lanePoint(e, s, k);
              const d = dirAt(e.center, s);
              const y = ref(e, s);
              for (const h of [0.6, 2.0])
                for (const [side, dx, dz] of [
                  ['right', -d.z, d.x],
                  ['left', d.z, -d.x],
                ] as const) {
                  const o = { x: q.x, y: y + h, z: q.z };
                  const phys = rayDistance(built.world, o, { x: dx, z: dz }, GEOMETRY.SIDE_REACH);
                  if (phys && SMALL_SOLIDS.has(phys.shape)) continue;
                  const drawn = soup.ray(o, { x: dx, y: 0, z: dz }, GEOMETRY.SIDE_REACH);
                  const where = `e${edge} lane ${k} s ${s.toFixed(0)} ${h} m up looking ${side} from ${fmt({ ...q, y })}`;
                  if (drawn !== null && (phys === null || phys.d > drawn + tol)) found.push(`drawn but not solid: ${where}: drawn at ${drawn.toFixed(2)} m, solid ${phys ? `${phys.d.toFixed(2)} m` : 'none'}`);
                  else if (phys !== null && (drawn === null || drawn > phys.d + tol)) found.push(`solid but not drawn: ${where}: solid (shape ${phys.shape}) at ${phys.d.toFixed(2)} m, drawn ${drawn !== null ? `${drawn.toFixed(2)} m` : 'none'}`);
                }
            }
        }
        expect(found, report(found)).toEqual([]);
      });
    }

    if (st.kind === 'cut')
      check(`terrain heightfield stays under the asphalt ${st.id}`, () => {
        const profiles = roadProfiles(city);
        const found: string[] = [];
        for (const i of st.roads) {
          const r = city.roads[i];
          const prof = profiles[i]!;
          for (let k = 0; k < r.points.length - 1; k++) {
            const [a, b] = [r.points[k], r.points[k + 1]];
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            for (let t = 0; t < len; t += 2) {
              const at = profileAt(prof, prof.cum[k] + t);
              if (at.lift > -1.2) continue; // ramp ends follow the ground anyway
              const dx = (b.x - a.x) / len;
              const dz = (b.z - a.z) / len;
              for (let o = -r.width / 2; o <= r.width / 2 + 1e-6; o += r.width / 4) {
                const q = { x: a.x + dx * t - dz * o, z: a.z + dz * t + dx * o };
                const hf = surfaceBelow(built.world, q, at.y + 40, 80, (c) => c.handle === heightfield.handle);
                if (hf !== null && hf > at.y + GEOMETRY.HEIGHTFIELD_ABOVE) found.push(`#${i} ${r.name}: heightfield ${(hf - at.y).toFixed(2)} m above the asphalt at ${fmt({ ...q, y: at.y })}`);
              }
            }
          }
        }
        expect(found, report(found)).toEqual([]);
      });
  });
