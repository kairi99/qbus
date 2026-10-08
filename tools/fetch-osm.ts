/**
 * Downloads a zone from Overpass into data/raw/:
 * - <zone>.osm.json: roads, buildings, stops, traffic signals, parks and trees
 * - <zone>.routes.json: bus/trolleybus route relations with their geometry clipped to the zone
 * - <zone>.stations.json: stop positions of those routes (with names, for BRT stations) and
 *   Metro de Quito stations/entrances
 * - <zone>.areas.json: campus grounds (universities, schools, hospitals) that get walls
 * The public servers are often overloaded; mirrors are tried in order.
 * Usage: npx tsx tools/fetch-osm.ts [zone] [osm|routes|stations|areas ...]
 */
import { writeFileSync } from 'node:fs';
import { ZONES } from './zones';

const zone = ZONES[process.argv[2] ?? 'mariscal'];
const b = zone.bbox.join(',');
const ROUTES = `rel["type"="route"]["route"~"^(bus|trolleybus)$"](${b})`;
const QUERIES: Record<string, { file: string; query: string }> = {
  osm: {
    file: zone.osm,
    query: `[out:json][timeout:120];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service|pedestrian)$"](${b});
  way["building"](${b});
  relation["building"](${b});
  way["leisure"~"^(park|garden|pitch)$"](${b});
  way["landuse"~"^(grass|recreation_ground)$"](${b});
  node["highway"="bus_stop"](${b});
  node["highway"="traffic_signals"](${b});
  node["natural"="tree"](${b});
);
out geom;`,
  },
  routes: {
    file: zone.osm.replace('.osm.json', '.routes.json'),
    query: `[out:json][timeout:180];
${ROUTES};
out body geom(${b});`,
  },
  stations: {
    file: zone.osm.replace('.osm.json', '.stations.json'),
    query: `[out:json][timeout:120];
${ROUTES}->.r;
node(r.r)(${b})["public_transport"="stop_position"];
out;
(
  nwr["station"="subway"](${b});
  nwr["railway"="subway_entrance"](${b});
  nwr["public_transport"="station"]["network"~"Metro",i](${b});
);
out center;`,
  },
  areas: {
    file: zone.osm.replace('.osm.json', '.areas.json'),
    query: `[out:json][timeout:120];
(
  way["amenity"~"^(university|college|school|hospital)$"](${b});
  relation["amenity"~"^(university|college|school|hospital)$"](${b});
  way["landuse"="military"](${b});
);
out geom;`,
  },
};
const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function download(file: string, query: string): Promise<boolean> {
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'QBus-dev/0.1' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      JSON.parse(text);
      writeFileSync(file, text);
      console.log(`saved ${file} (${(text.length / 1e6).toFixed(1)} MB) from ${url}`);
      return true;
    } catch (e) {
      console.warn(`${url}: ${(e as Error).message}`);
    }
  }
  return false;
}

const which = process.argv.slice(3);
let ok = true;
for (const [name, q] of Object.entries(QUERIES)) if (!which.length || which.includes(name)) ok = (await download(q.file, q.query)) && ok;
process.exit(ok ? 0 : 1);
