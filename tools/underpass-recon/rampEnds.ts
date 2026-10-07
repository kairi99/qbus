/**
 * Ramps that are still off street level where their edge runs into a street-level junction in
 * the road graph (the junction's paved area starts before the ramp is done). Usage: npx tsx tools/underpass-recon/rampEnds.ts
 */
import { readFileSync } from 'node:fs';
import type { CityData } from '../../src/world/cityData';
import { buildRoadGraph } from '../../src/world/roadGraph';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const graph = buildRoadGraph({ roads: city.roads } as CityData);
for (const n of graph.nodes) {
  if (!n.hull || Math.abs(n.lift) > 0.3) continue;
  for (const [id, at] of [...n.in.map((id) => [id, -1] as const), ...n.out.map((id) => [id, 0] as const)]) {
    const e = graph.edges[id];
    if (e.lift && Math.abs(e.lift.at(at)!) > 0.05)
      console.log(`node ${n.id} (${n.pos.x.toFixed(1)}, ${n.pos.z.toFixed(1)}) lift ${n.lift.toFixed(2)}: e${id} road #${e.roadIndex} ${e.road} lift ${e.lift.at(at)!.toFixed(2)} at its ${at ? 'end' : 'start'}`);
  }
}
