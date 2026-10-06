/**
 * Star targets of every route (both zones), beside the fares a model driver earns at the
 * autopilot's paces (tools/sim-shift.ts). Usage: npx tsx tools/star-targets.ts
 */
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import { buildRoadGraph } from '../src/world/roadGraph';
import { routeLegs, routeStops, routesFor, startPose } from '../src/gameplay/routes';
import { modelShift, starThresholds } from '../src/gameplay/stars';
const $ = (c: number) => (c / 100).toFixed(2);
for (const [n, city] of [
  ['mariscal', JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'))],
  ['grid', generateCity({ seed: 42 })],
] as const) {
  const g = buildRoadGraph(city);
  for (const r of routesFor(city, g)) {
    const legs = routeLegs(city, r, g);
    const args = [routeStops(city, r), legs, startPose(city, g, r).pos] as const;
    const th = starThresholds(...args);
    const fares = [9.5, 13.2, 16.2].map((p) => $([1, 2, 3].reduce((s, seed) => s + modelShift(...args, p, seed).cents, 0) / 3));
    console.log(n.padEnd(8), r.id.padEnd(24), String(r.stops.length).padStart(2), 'stops | fares at 9.5/13.2/16.2 m/s:', fares.join(' / '), '| stars:', th.map($).join(' / '));
  }
}
