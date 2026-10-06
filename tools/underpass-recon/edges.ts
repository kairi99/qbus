/** Prints graph edges (road, OSM-road index, lanes, endpoints, lift range, nodes). Usage: npx tsx tools/underpass-recon/edges.ts 160 970 ... */
import { readFileSync } from 'node:fs';
import type { CityData } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph } from '../../src/world/roadGraph';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const graph = buildRoadGraph(city);
const f = (p: { x: number; z: number }) => `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
for (const a of process.argv.slice(2)) {
  const e = graph.edges[Number(a)];
  const lift = e.lift ? `lift ${e.lift[0].toFixed(2)}..${e.lift[e.lift.length - 1].toFixed(2)} (min ${Math.min(...e.lift).toFixed(2)}, max ${Math.max(...e.lift).toFixed(2)})` : 'ground';
  const y = e.y ? `y ${e.y[0].toFixed(2)}..${e.y[e.y.length - 1].toFixed(2)}` : '';
  console.log(`edge ${e.id} "${e.road}" road#${e.roadIndex} ${e.oneway ? 'oneway' : 'two-way'} lanes ${e.lanes} w ${e.roadWidth} len ${e.len.toFixed(1)} ${f(e.a)} -> ${f(e.b)} heading ${((e.heading * 180) / Math.PI).toFixed(0)}° ${lift} ${y} drivable=${e.drivable} nodes ${e.from}->${e.to} (to: lift ${graph.nodes[e.to].lift.toFixed(2)} y ${graph.nodes[e.to].y?.toFixed(2)}, out ${graph.nodes[e.to].out.join(',')})`);
}
