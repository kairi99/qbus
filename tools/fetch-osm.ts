/**
 * Downloads a zone's roads, buildings, stops, parks and trees from Overpass into
 * data/raw/<zone>.osm.json. The public servers are often overloaded; mirrors are tried in order.
 * Usage: npx tsx tools/fetch-osm.ts [zone]
 */
import { writeFileSync } from 'node:fs';
import { ZONES } from './zones';

const zone = ZONES[process.argv[2] ?? 'mariscal'];
const b = zone.bbox.join(',');
const query = `[out:json][timeout:120];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service|pedestrian)$"](${b});
  way["building"](${b});
  relation["building"](${b});
  way["leisure"~"^(park|garden|pitch)$"](${b});
  way["landuse"~"^(grass|recreation_ground)$"](${b});
  node["highway"="bus_stop"](${b});
  node["natural"="tree"](${b});
);
out geom;`;
const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
for (const url of MIRRORS) {
  try {
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'QBus-dev/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    JSON.parse(text);
    writeFileSync(zone.osm, text);
    console.log(`saved ${zone.osm} (${(text.length / 1e6).toFixed(1)} MB) from ${url}`);
    process.exit(0);
  } catch (e) {
    console.warn(`${url}: ${(e as Error).message}`);
  }
}
process.exit(1);
