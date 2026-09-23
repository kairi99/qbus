/**
 * Builds data/cities/<zone>.json from cached raw data:
 *   data/raw/<zone>.osm.json   (Overpass `out geom;` result, see tools/fetch-osm.ts)
 *   data/raw/copernicus-*.tif  (Copernicus GLO-30 DEM tile)
 * Usage: npx tsx tools/build-city.ts [zone]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fromFile } from 'geotiff';
import { importOsm, type Dem } from '../src/world/osm/import';
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

const osm = JSON.parse(readFileSync(zone.osm, 'utf8'));
const t0 = performance.now();
const routesFile = zone.osm.replace('.osm.json', '.routes.json');
const routes = existsSync(routesFile) ? JSON.parse(readFileSync(routesFile, 'utf8')) : undefined;
const city = importOsm(osm, dem, { name: zone.name, bbox: zone.bbox, seed: 7 }, routes);
const ms = performance.now() - t0;

const out = `data/cities/${zone.id}.json`;
writeFileSync(out, JSON.stringify(city));
const t = city.terrain!;
const hs = t.heights;
console.log(
  `${out}: ${city.roads.length} roads (${city.roads.filter((r) => r.oneway).length} one-way), ${city.buildings.length} buildings, ` +
    `${city.stops.length} stops, ${city.lines?.length ?? 0} real lines, ${city.props.length} props, ${city.trees.length} trees, ${city.features.length} features, ` +
    `terrain ${t.cols}x${t.rows}@${t.cell}m relief ${Math.min(...hs).toFixed(1)}..${Math.max(...hs).toFixed(1)} m, ` +
    `size ${(city.bounds.max.x - city.bounds.min.x).toFixed(0)}x${(city.bounds.max.z - city.bounds.min.z).toFixed(0)} m, built in ${ms.toFixed(0)} ms`,
);
