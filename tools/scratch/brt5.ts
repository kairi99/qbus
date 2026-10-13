import { readFileSync } from 'node:fs';
import { buildRoadGraph } from '../../src/world/roadGraph';
import { BRT_KIND, TrafficSim, brtBusCount } from '../../src/gameplay/traffic';
import { TrafficLights } from '../../src/gameplay/trafficLights';
import { forward, right } from '../../src/world/cityData';
const city = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const g = buildRoadGraph(city);
const lights = new TrafficLights(g, city.signals ?? []);
function overlaps(a: any, b: any): boolean {
  const axes = [forward(a.heading), right(a.heading), forward(b.heading), right(b.heading)];
  const d = { x: b.pos.x - a.pos.x, z: b.pos.z - a.pos.z };
  for (const ax of axes) {
    const proj = (o: any) => (Math.abs(forward(o.heading).x * ax.x + forward(o.heading).z * ax.z) * o.kind.length) / 2 + (Math.abs(right(o.heading).x * ax.x + right(o.heading).z * ax.z) * o.kind.width) / 2;
    if (Math.abs(d.x * ax.x + d.z * ax.z) > proj(a) + proj(b)) return false;
  }
  return true;
}
for (const seed of [1, 2, 3]) {
  const sim = new TrafficSim(g, city, { seed, count: 60, brt: brtBusCount(g), lights });
  const sts = city.stops.filter((s: any) => s.system);
  const focus = { pos: sts[0].pos, heading: 0 };
  sim.recycle(focus, true);
  let ov = 0;
  const pairs = new Set<string>();
  const trav = new Map<number, number>();
  const last = new Map<number, any>();
  for (let t = 0; t < 180; t += 1 / 20) {
    sim.step(1 / 20, []);
    if (Math.round(t * 20) % 400 === 0) focus.pos = sts[Math.floor(t / 20 * 3 + seed) % sts.length].pos;
    if (Math.round(t * 20) % 10 === 0) sim.recycle(focus);
    const dr = sim.cars.filter((c) => c.state === 'driving');
    for (const c of dr) {
      const l = last.get(c.id);
      if (l) trav.set(c.id, (trav.get(c.id) ?? 0) + Math.hypot(c.pos.x - l.x, c.pos.z - l.z));
      last.set(c.id, { ...c.pos });
    }
    for (let i = 0; i < dr.length; i++) for (let j = i + 1; j < dr.length; j++) if (((dr[i].kind === BRT_KIND) !== (dr[j].kind === BRT_KIND)) && overlaps(dr[i], dr[j])) { ov++; pairs.add(`${dr[i].id}-${dr[j].id}`); }
  }
  const buses = sim.cars.filter((c) => c.kind === BRT_KIND);
  console.log('seed', seed, 'overlap frames', ov, [...pairs].slice(0, 5), 'bus travelled', buses.map((b) => Math.round(trav.get(b.id) ?? 0)), buses.map((b) => b.state));
}
