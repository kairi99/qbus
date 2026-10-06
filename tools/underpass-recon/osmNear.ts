/** Nearest OSM highway ways to the middle of the given city road indexes. Usage: npx tsx tools/underpass-recon/osmNear.ts 135 163 182 */
import { readFileSync } from 'node:fs';
const city = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const osm = JSON.parse(readFileSync('data/raw/mariscal.osm.json', 'utf8'));
const bbox = [-0.2125, -78.502, -0.195, -78.485];
const lat0 = (bbox[0] + bbox[2]) / 2, lon0 = (bbox[1] + bbox[3]) / 2, mx = 111320 * Math.cos((lat0 * Math.PI) / 180), mz = 110574;
const toXZ = (lat: number, lon: number) => ({ x: (lon - lon0) * mx, z: -(lat - lat0) * mz });
for (const a of process.argv.slice(2)) {
  const i = Number(a);
  const r = city.roads[i];
  const mid = r.points[Math.floor(r.points.length / 2)];
  const c = osm.elements
    .filter((e: any) => e.type === 'way' && e.tags?.highway && e.geometry)
    .map((e: any) => {
      const pts = e.geometry.map((g: any) => toXZ(g.lat, g.lon));
      return { e, d: Math.min(...pts.map((p: any) => Math.hypot(p.x - mid.x, p.z - mid.z))) };
    })
    .sort((x: any, y: any) => x.d - y.d)
    .slice(0, 3);
  console.log(i, r.name, c.map((x: any) => `${x.e.id} ${x.e.tags.name} ${JSON.stringify({ b: x.e.tags.bridge, t: x.e.tags.tunnel, l: x.e.tags.layer, h: x.e.tags.highway })} d=${x.d.toFixed(1)}`));
}
