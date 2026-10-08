/**
 * Builds data/cities/<zone>.json from cached raw data:
 *   data/raw/<zone>.osm.json   (Overpass `out geom;` result, see tools/fetch-osm.ts)
 *   data/raw/copernicus-*.tif  (Copernicus GLO-30 DEM tile)
 * Usage: npx tsx tools/build-city.ts [zone]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fromFile } from 'geotiff';
import { HORIZON_HALF, importOsm, makeProjection, type Dem } from '../src/world/osm/import';
import { sameWayStretches } from '../src/world/osm/carriageways';
import { ZONES } from './zones';

const zone = ZONES[process.argv[2] ?? 'mariscal'];
if (!zone) throw new Error(`unknown zone; known: ${Object.keys(ZONES).join(', ')}`);
const [south, west, north, east] = zone.bbox;

// DEM window around the bbox with ~600 m of margin for the terrain skirt.
const tiff = await fromFile(zone.dem);
const img = await tiff.getImage();
const [ox, oy] = img.getOrigin();
const [rx, ry] = img.getResolution();
const pad = 0.006;
const c0 = Math.floor((west - pad - ox) / rx);
const c1 = Math.ceil((east + pad - ox) / rx);
const r0 = Math.floor((north + pad - oy) / ry);
const r1 = Math.ceil((south - pad - oy) / ry);
const [values] = (await img.readRasters({ window: [c0, r0, c1, r1] })) as unknown as [Float32Array];
const dem: Dem = { lon0: ox + c0 * rx, lat0: oy + r0 * ry, dLon: rx, dLat: ry, cols: c1 - c0, rows: r1 - r0, values };

// A wider, coarser window for the far terrain seen around the city (El Panecillo, Pichincha).
const lat0 = (south + north) / 2;
const halfLat = HORIZON_HALF / 110574 + 0.003;
const halfLon = HORIZON_HALF / (111320 * Math.cos((lat0 * Math.PI) / 180)) + 0.003;
const midLon = (west + east) / 2;
const h0 = Math.floor((midLon - halfLon - ox) / rx);
const h1 = Math.ceil((midLon + halfLon - ox) / rx);
const v0 = Math.floor((lat0 + halfLat - oy) / ry);
const v1 = Math.ceil((lat0 - halfLat - oy) / ry);
const [far] = (await img.readRasters({ window: [h0, v0, h1, v1] })) as unknown as [Float32Array];
const horizonDem: Dem = { lon0: ox + h0 * rx, lat0: oy + v0 * ry, dLon: rx, dLat: ry, cols: h1 - h0, rows: v1 - v0, values: far };

const osm = JSON.parse(readFileSync(zone.osm, 'utf8'));
const t0 = performance.now();
const routesFile = zone.osm.replace('.osm.json', '.routes.json');
const routes = existsSync(routesFile) ? JSON.parse(readFileSync(routesFile, 'utf8')) : undefined;
const extra = (kind: string) => {
  const file = zone.osm.replace('.osm.json', `.${kind}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};
const city = importOsm(osm, dem, { name: zone.name, bbox: zone.bbox, seed: 7, dropWays: zone.dropWays, reverseWays: zone.reverseWays }, { routes, stations: extra('stations'), areas: extra('areas'), horizonDem });
const { toXZ } = makeProjection(zone.bbox);
if (zone.monuments) city.monuments = zone.monuments.map((m) => ({ kind: m.kind, name: m.name, pos: toXZ(m.lat, m.lon) }));
const ms = performance.now() - t0;
// A divided avenue whose carriageways run the same way side by side is a way drawn backwards
// in OSM (see `reverseWays`), inside the play area at least (outside it, side lanes too).
const pa = city.playArea!;
const inPlay = (p: { x: number; z: number }) => p.x >= pa.min.x && p.x <= pa.max.x && p.z >= pa.min.z && p.z <= pa.max.z;
for (const w of sameWayStretches(city.roads).filter((w) => inPlay(w.from) || inPlay(w.to)))
  console.warn(`both carriageways of ${w.name} run the same way for ${w.length} m near (${w.from.x.toFixed(0)}, ${w.from.z.toFixed(0)}): a one-way drawn backwards? (npx tsx tools/carriageways.ts)`);

const out = `data/cities/${zone.id}.json`;
writeFileSync(out, JSON.stringify(city));
const t = city.terrain!;
const hs = t.heights;
console.log(
  `${out}: ${city.roads.length} roads (${city.roads.filter((r) => r.oneway).length} one-way), ${city.buildings.length} buildings, ` +
    `${city.stops.length} stops, ${city.lines?.length ?? 0} real lines, ${city.stations?.length ?? 0} stations, ${city.metro?.length ?? 0} metro entrances, ${city.walls?.length ?? 0} walls, ${city.props.length} props, ${city.trees.length} trees, ${city.features.length} features, ` +
    `terrain ${t.cols}x${t.rows}@${t.cell}m relief ${Math.min(...hs).toFixed(1)}..${Math.max(...hs).toFixed(1)} m, ` +
    `size ${(city.bounds.max.x - city.bounds.min.x).toFixed(0)}x${(city.bounds.max.z - city.bounds.min.z).toFixed(0)} m, built in ${ms.toFixed(0)} ms`,
);
