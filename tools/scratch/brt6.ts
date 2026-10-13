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
const sim = new TrafficSim(g, city, { seed: 2, count: 60, brt: brtBusCount(g), lights });
const sts = city.stops.filter((s: any) => s.system);
const seed = 2;
const focus = { pos: sts[0].pos, heading: 0 };
sim.recycle(focus, true);
const seen = new Set<string>();
for (let t = 0; t < 180 && seen.size < 12; t += 1 / 20) {
  sim.step(1 / 20, []);
  if (Math.round(t * 20) % 400 === 0) focus.pos = sts[Math.floor(t / 20 * 3 + seed) % sts.length].pos;
  if (Math.round(t * 20) % 10 === 0) sim.recycle(focus);
  const dr = sim.cars.filter((c) => c.state === 'driving');
  for (let i = 0; i < dr.length; i++)
    for (let j = i + 1; j < dr.length; j++)
      if (((dr[i].kind === BRT_KIND) !== (dr[j].kind === BRT_KIND)) && overlaps(dr[i], dr[j])) {
        const k = `${dr[i].id}-${dr[j].id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const d = (c: any) => `#${c.id} ${c.kind.name} e${c.edge} s${c.s.toFixed(0)}/${g.edges[c.edge].len.toFixed(0)} ${g.edges[c.edge].access} turn${c.turn ? c.turn.node : '-'} v${c.speed.toFixed(1)} gen${c.generation} pos(${c.pos.x.toFixed(0)},${c.pos.z.toFixed(0)})`;
        console.log('t', t.toFixed(1), d(dr[i]), '||', d(dr[j]), 'lifts', sim.liftOf(dr[i]), sim.liftOf(dr[j]), 'headings', dr[i].heading.toFixed(2), dr[j].heading.toFixed(2));
      }
}
