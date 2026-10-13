import { readFileSync } from 'node:fs';
import { buildRoadGraph, projectOnPath } from '../../src/world/roadGraph';
import { BRT_GENERAL_COST, Navigator } from '../../src/gameplay/navigation';
import { routeStops, routesFor, startPose } from '../../src/gameplay/routes';
import { groundHeightAt } from '../../src/world/cityData';
const city = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const g = buildRoadGraph(city);
const gr = (q: any) => groundHeightAt(city, q);
for (const r of routesFor(city, g).filter((x) => x.system)) {
  const nav = new Navigator(g, 'brt', BRT_GENERAL_COST);
  const first = routeStops(city, r)[0];
  const spot = nav.locate(first.zone, first.stop.heading, gr(first.zone), gr)!;
  const b = nav.behind(spot, 70);
  const sp = startPose(city, g, r);
  const s2 = nav.locate(sp.pos, sp.heading, sp.y, gr)!;
  console.log(r.id, first.stop.id, 'spot', spot, g.edges[spot.edge].access, 'behind', b, g.edges[b.edge].access, 'relocated', s2, g.edges[s2.edge].access, nav.pathMeters(s2, spot));
  for (const id of [b.edge, s2.edge]) {
    const e = g.edges[id];
    const pr = projectOnPath(e.center, sp.pos);
    console.log('  ', id, e.access, pr.d.toFixed(1), 'len', e.len.toFixed(0));
  }
}
