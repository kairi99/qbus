/**
 * Lists every lifted road (underpass/bridge and their ramps) in La Mariscal with the OSM ways it
 * came from (matched by geometry), its extent, min/max lift, and the graph edges/nodes on it.
 * Usage: npx tsx tools/underpass-recon/enumerate.ts [--json]
 */
import { readFileSync } from 'node:fs';
import type { CityData, Vec2 } from '../../src/world/cityData';
import { inPlayArea } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { roadProfiles } from '../../src/world/elevation';
import { buildRoadGraph } from '../../src/world/roadGraph';
import { ZONES } from '../zones';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const osm = JSON.parse(readFileSync('data/raw/mariscal.osm.json', 'utf8'));
const bbox = ZONES.mariscal.bbox;
const lat0 = (bbox[0] + bbox[2]) / 2;
const lon0 = (bbox[1] + bbox[3]) / 2;
const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
const mz = 110574;
const toXZ = (lat: number, lon: number): Vec2 => ({ x: (lon - lon0) * mx, z: -(lat - lat0) * mz });

const ways = (osm.elements as any[]).filter((e) => e.type === 'way' && e.tags?.highway && e.geometry).map((e) => ({ id: e.id as number, tags: e.tags, pts: (e.geometry as any[]).map((g) => toXZ(g.lat, g.lon)) }));

function distPtSeg(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - a.x - u * dx, p.z - a.z - u * dz);
}
function distPoly(p: Vec2, pts: Vec2[]) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distPtSeg(p, pts[i], pts[i + 1]));
  return d;
}

const profiles = roadProfiles(city);
const graph = buildRoadGraph(city);
const out: any[] = [];
city.roads.forEach((r, i) => {
  if (!r.lift) return;
  const prof = profiles[i]!;
  const minL = Math.min(...r.lift);
  const maxL = Math.max(...r.lift);
  // OSM ways: every way whose all points lie near this road's centerline, or vice versa.
  const matches = ways.filter((w) => {
    const share = w.pts.filter((p) => distPoly(p, r.points) < 1).length / w.pts.length;
    const share2 = r.points.filter((p) => distPoly(p, w.pts) < 1).length / r.points.length;
    return share > 0.8 && share2 > 0.5;
  });
  const deepest = r.lift.reduce((b, l, k) => (Math.abs(l) > Math.abs(r.lift![b]) ? k : b), 0);
  const edges = graph.edges.filter((e) => e.roadIndex === i || (e as any).roadIdx === i);
  out.push({
    road: i,
    name: r.name,
    layer: r.layer ?? 0,
    oneway: !!r.oneway,
    width: r.width,
    lanes: r.lanes,
    lift: [minL, maxL].map((x) => +x.toFixed(2)),
    from: r.points[0],
    to: r.points[r.points.length - 1],
    extreme: { ...r.points[deepest], lift: r.lift[deepest], y: +prof.y[deepest].toFixed(2) },
    len: +prof.cum[prof.cum.length - 1].toFixed(1),
    inPlay: inPlayArea(city, r.points[deepest]),
    osm: matches.map((w) => `${w.id}${w.tags.tunnel ? ' tunnel=' + w.tags.tunnel : ''}${w.tags.bridge ? ' bridge=' + w.tags.bridge : ''}${w.tags.layer ? ' layer=' + w.tags.layer : ''} ${w.tags.highway}`),
    edges: edges.length,
  });
});
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else
  for (const o of out)
    console.log(
      `#${o.road} ${o.name} L${o.layer}${o.oneway ? ' oneway' : ''} w${o.width} lift[${o.lift}] len ${o.len} ` +
        `(${o.from.x.toFixed(0)},${o.from.z.toFixed(0)})->(${o.to.x.toFixed(0)},${o.to.z.toFixed(0)}) extreme (${o.extreme.x.toFixed(0)},${o.extreme.z.toFixed(0)}) lift ${o.extreme.lift} y ${o.extreme.y} ${o.inPlay ? '' : 'OUTSIDE-PLAY'} osm=[${o.osm.join('; ')}]`,
    );
console.error('graph edge keys', Object.keys(graph.edges[0]));
