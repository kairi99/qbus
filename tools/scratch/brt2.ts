import { readFileSync } from 'node:fs';
import { buildRoadGraph } from '../../src/world/roadGraph';
import { Navigator } from '../../src/gameplay/navigation';
import { routeStops, routesFor } from '../../src/gameplay/routes';
import { groundHeightAt } from '../../src/world/cityData';
const city = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const g = buildRoadGraph(city);
for (const gc of [1, 2, 4]) {
  for (const r of routesFor(city, g).filter((x) => x.system)) {
    const nav = new Navigator(g, 'brt', gc);
    const st = routeStops(city, r);
    const sp = st.map((s) => nav.locate(s.zone, s.stop.heading, groundHeightAt(city, s.zone), (q) => groundHeightAt(city, q)));
    let tot = 0;
    let brt = 0;
    let bad = 0;
    st.forEach((s, i) => {
      const a = sp[i];
      const b = sp[(i + 1) % st.length];
      const p = a && b && nav.route(a, b);
      if (!p) {
        bad++;
        return;
      }
      for (const id of p.edges) {
        tot += g.edges[id].len;
        if (g.edges[id].access === 'brt') brt += g.edges[id].len;
      }
    });
    console.log('gc', gc, r.id, 'tot', Math.round(tot), 'brt', Math.round(brt), 'unrouted', bad, 'stopEdges', sp.map((x) => x && g.edges[x.edge].access).join(','));
  }
}
