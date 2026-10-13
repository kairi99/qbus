import { readFileSync } from 'node:fs';
import { buildRoadGraph } from '../../src/world/roadGraph';
import { BRT_KIND, TrafficSim, brtBusCount } from '../../src/gameplay/traffic';
import { TrafficLights } from '../../src/gameplay/trafficLights';
const city = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const g = buildRoadGraph(city);
const lights = new TrafficLights(g, city.signals ?? []);
const sim = new TrafficSim(g, city, { seed: 5, count: 40, brt: brtBusCount(g), lights });
const st = city.stops.find((s: any) => s.system);
sim.recycle({ pos: st.pos, heading: st.heading }, true);
const buses = sim.cars.filter((c) => c.kind === BRT_KIND);
console.log(brtBusCount(g), buses.map((b) => [b.state, b.edge, b.s.toFixed(0), g.edges[b.edge]?.len.toFixed(0)]));
// @ts-ignore
console.log('stations', g.edges.filter((e) => e.access === 'brt').map((e) => (sim as any).stations[e.id].length).reduce((a: number, b: number) => a + b, 0));
for (let t = 0; t < 120; t += 0.5) {
  for (let k = 0; k < 10; k++) sim.step(0.05, []);
  if (t % 10 === 0) console.log(t, buses.map((b) => `${b.state}:e${b.edge}@${b.s.toFixed(0)} v${b.speed.toFixed(1)} d${b.dwell.toFixed(1)} w${b.wait.toFixed(0)}${b.held ? 'H' : ''}`).join(' | '));
}
for (const e of g.edges.filter((x) => x.access === 'brt' && x.len > 30)) console.log(e.id, e.len.toFixed(0), 'to', e.to, g.nodes[e.to].junction, 'out', g.nodes[e.to].out.map((o) => g.edges[o].access[0] + o).join(','), 'st', (sim as any).stations[e.id].map((s: number) => s.toFixed(0)).join(','));
