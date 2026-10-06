/**
 * Navigation and reset checks around every lifted edge:
 *  1. Navigator.locate from a bus driving each lifted edge (pose y + 1.5 as in session code,
 *     passing the bus center height minus 1.5): does it pick the edge the bus is on? Also without y.
 *  2. snapToRoad (the R reset) from a bus on each lifted edge: does it land on the same road, at
 *     about the same height, and clear of the ramp?  And from a bus stopped on the street crossing
 *     over/under (does the reset drop it into the cut, or lift it onto the deck?).
 *  3. Stops, props, humps, trees within 10 m of a lifted road's asphalt.
 * Usage: npx tsx tools/underpass-recon/nav.ts
 */
import { readFileSync } from 'node:fs';
import { type CityData, groundHeightAt, terrainAt } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph, edgeLift, edgeY, lanePoint, dirAt } from '../../src/world/roadGraph';
import { Navigator } from '../../src/gameplay/navigation';
import { snapToRoad } from '../../src/world/roadSnap';
import { profileAt, projectOnRoad, roadProfiles } from '../../src/world/elevation';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const graph = buildRoadGraph(city);
const nav = new Navigator(graph);
const ground = (p: { x: number; z: number }) => groundHeightAt(city, p);
const profiles = roadProfiles(city);
const f = (p: { x: number; z: number }) => `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;

const lifted = graph.edges.filter((e) => e.drivable && e.lift && e.lift.some((l) => Math.abs(l) > 1));
console.log('== 1. locate on lifted edges ==');
let bad = 0;
for (const e of lifted) {
  for (let s = 2; s < e.len - 2; s += 2) {
    const p = lanePoint(e, s, 0);
    const d = dirAt(e.center, s);
    const heading = Math.atan2(-d.z, d.x);
    const y = edgeY(e, s)!;
    const spot = nav.locate(p, heading, y, ground);
    const plain = nav.locate(p, heading);
    const okY = spot && (spot.edge === e.id || Math.abs((edgeY(graph.edges[spot.edge], spot.s) ?? ground(p)) - y) < 1);
    const okPlain = plain && (plain.edge === e.id || Math.abs((edgeY(graph.edges[plain.edge], plain.s) ?? ground(p)) - y) < 1);
    if (!okY) {
      bad++;
      const o = graph.edges[spot!.edge];
      console.log(`WITH-Y  edge ${e.id} ${e.road} s ${s} ${f(p)} lift ${edgeLift(e, s).toFixed(2)} y ${y.toFixed(2)} -> edge ${o.id} ${o.road} y ${(edgeY(o, spot!.s) ?? ground(p)).toFixed(2)}`);
    }
    if (!okPlain && Math.abs(edgeLift(e, s)) > 2) {
      const o = graph.edges[plain!.edge];
      console.log(`NO-Y    edge ${e.id} ${e.road} s ${s} ${f(p)} lift ${edgeLift(e, s).toFixed(2)} -> edge ${o.id} ${o.road} y ${(edgeY(o, plain!.s) ?? ground(p)).toFixed(2)} (callers without y: guidance picks the wrong level)`);
    }
  }
}
console.log(`locate with y: ${bad} wrong picks`);

console.log('\n== 2. snapToRoad (R reset) ==');
const roadAt = (pos: { x: number; z: number }, y: number) => {
  let best = { ri: -1, d: Infinity, y: 0 };
  city.roads.forEach((r, ri) => {
    const pr = projectOnRoad(r, pos);
    if (pr.d > r.width / 2 + 0.5) return;
    const prof = profiles[ri];
    const ry = prof ? profileAt(prof, pr.s).y : terrainAt(city, pos);
    const dd = Math.abs(ry - y);
    if (dd < best.d) best = { ri, d: dd, y: ry };
  });
  return best;
};
for (const e of lifted) {
  for (let s = 3; s < e.len - 3; s += 6) {
    const p = lanePoint(e, s, 0);
    const d = dirAt(e.center, s);
    const heading = Math.atan2(-d.z, d.x);
    const y = edgeY(e, s)!;
    const r = snapToRoad(city, p, heading, y);
    const moved = Math.hypot(r.pos.x - p.x, r.pos.z - p.z);
    const there = roadAt(r.pos, r.y);
    const lvl = Math.abs(r.y - y);
    // Where the reset puts the bus: is the surface really there? (another road at a different level there is fine if we're on ours)
    const sameRoad = there.ri === e.roadIndex;
    if (lvl > 1.5 || moved > 12 || !sameRoad || there.d > 0.3)
      console.log(`reset on edge ${e.id} ${e.road} s ${s} ${f(p)} y ${y.toFixed(2)} -> ${f(r.pos)} y ${r.y.toFixed(2)} (moved ${moved.toFixed(1)} m, dy ${(r.y - y).toFixed(2)}) on road #${there.ri} ${city.roads[there.ri]?.name} (surface off by ${there.d.toFixed(2)})`);
  }
}
// From the street above/below each crossing: grid of points over each lifted road at ground height + 1.5 (bus on the street above).
console.log('-- resets from the street crossing over/under --');
for (const e of lifted) {
  const k = e.lift!.reduce((b, l, i) => (Math.abs(l) > Math.abs(e.lift![b]) ? i : b), 0);
  const p = e.center.pts[k];
  const g = ground(p);
  const y = edgeY(e, e.center.cum[k])!;
  const other = e.lift![k] < 0 ? g : g; // the street level
  for (const h of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const r = snapToRoad(city, p, h, other);
    if (Math.abs(r.y - other) > 2) console.log(`reset from street level at ${f(p)} (ground ${g.toFixed(2)}, ${e.road} below/above at ${y.toFixed(2)}), heading ${h.toFixed(2)} -> ${f(r.pos)} y ${r.y.toFixed(2)}: changed level`);
  }
}

console.log('\n== 2b. reset from the street directly over/under each crossing ==');
{
  const seen = new Set<string>();
  for (const e of lifted)
    for (let i = 0; i < e.center.pts.length; i++) {
      if (Math.abs(e.lift![i]) < 4) continue;
      const p = e.center.pts[i];
      const ey = e.y![i];
      city.roads.forEach((r, ri) => {
        if (ri === e.roadIndex) return;
        const pr = projectOnRoad(r, p);
        if (pr.d > r.width / 2 - 1) return;
        const prof = profiles[ri];
        const ry = prof ? profileAt(prof, pr.s).y : terrainAt(city, p);
        if (Math.abs(ry - ey) < 3) return;
        const key = `${ri}:${e.roadIndex}`;
        if (seen.has(key)) return;
        seen.add(key);
        for (const h of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const snap = snapToRoad(city, p, h, ry);
          const ok = Math.abs(snap.y - ry) < 1.5;
          console.log(`${ok ? 'ok ' : 'BAD'} bus on ${r.name} #${ri} (y ${ry.toFixed(2)}) over/under ${e.road} edge ${e.id} (y ${ey.toFixed(2)}) at ${f(p)} heading ${h.toFixed(2)} -> ${f(snap.pos)} y ${snap.y.toFixed(2)}`);
        }
      });
    }
}

console.log('\n== 3. stuff on or near ramps ==');
const liftedRoads = city.roads.map((r, i) => ({ r, i })).filter(({ r }) => r.lift && r.lift.some((l) => Math.abs(l) > 0.3));
const nearRamp = (p: { x: number; z: number }, pad: number) => {
  for (const { r, i } of liftedRoads) {
    const pr = projectOnRoad(r, p);
    if (pr.d > r.width / 2 + pad) continue;
    const lift = profileAt(profiles[i]!, pr.s).lift;
    if (Math.abs(lift) > 0.3) return `${r.name} #${i} (lift ${lift.toFixed(2)}, ${(pr.d - r.width / 2).toFixed(1)} m from its edge)`;
  }
  return null;
};
for (const s of city.stops) {
  const n = nearRamp(s.pos, 15);
  if (n) console.log(`stop ${s.id} ${s.name} ${f(s.pos)}: near ramp ${n}`);
}
for (const st of city.stations) {
  const n = nearRamp(st.pos, st.length / 2);
  if (n) console.log(`station ${st.name} ${f(st.pos)}: near ramp ${n}`);
}
for (const m of city.metro ?? []) {
  const n = nearRamp(m.pos, 6);
  if (n) console.log(`metro ${m.name} ${f(m.pos)}: near ramp ${n}`);
}
for (const fe of city.features) {
  const n = nearRamp(fe.pos, 2);
  if (n) console.log(`feature ${(fe as any).kind} ${f(fe.pos)}: on ramp ${n}`);
}
for (const pr of city.props) {
  const n = nearRamp((pr as any).pos, 1);
  if (n) console.log(`prop ${(pr as any).kind} ${f((pr as any).pos)}: on ramp ${n}`);
}
let trees = 0;
for (const t of city.trees) {
  const pos = (t as any).pos ?? t;
  const n = nearRamp(pos, 1.5);
  if (n) (trees++, console.log(`tree ${f(pos)}: by ramp ${n}`));
}
console.log(`${trees} trees within 1.5 m of a ramp's asphalt`);
