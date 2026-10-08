/**
 * Lists every divided avenue (two one-way carriageways of the same name side by side) with both
 * carriageways' directions along its length, and flags stretches where both run the same way
 * (a way drawn backwards in OSM).
 * Usage: npx tsx tools/carriageways.ts [zone]
 */
import { readFileSync } from 'node:fs';
import type { CityData } from '../src/world/cityData';
import { carriagewaySamples, sameWayStretches } from '../src/world/osm/carriageways';

const zone = process.argv[2] ?? 'mariscal';
const city: CityData = JSON.parse(readFileSync(`data/cities/${zone}.json`, 'utf8'));
const compass = (d: { x: number; z: number }) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((Math.atan2(d.x, -d.z) * 180) / Math.PI + 360) / 45) % 8];
const fmt = (p: { x: number; z: number }) => `(${p.x.toFixed(0)}, ${p.z.toFixed(0)})`;

const samples = carriagewaySamples(city.roads).filter((s) => s.twin);
const names = [...new Set(samples.map((s) => s.name))].sort();
for (const name of names) {
  const mine = samples.filter((s) => s.name === name);
  const same = mine.filter((s) => s.twin!.dir.x * s.dir.x + s.twin!.dir.z * s.dir.z > 0);
  console.log(`\n${name}: ${mine.length * 10} m of carriageway beside its twin, ${same.length * 10} m running the same way`);
  // One line per pair of carriageways (road indices), in travel order.
  const pairs = new Map<string, typeof mine>();
  for (const s of mine) {
    const key = `${Math.min(s.road, s.twin!.road)}/${Math.max(s.road, s.twin!.road)}`;
    pairs.set(key, [...(pairs.get(key) ?? []), s]);
  }
  for (const [key, ps] of pairs) {
    const [a, b] = key.split('/').map(Number);
    const sa = ps.find((s) => s.road === a) ?? ps[0];
    const sb = ps.find((s) => s.road === b);
    const da = compass(sa.road === a ? sa.dir : sa.twin!.dir);
    const db = sb ? compass(sb.dir) : compass(sa.twin!.dir);
    const flag = (sb ?? sa).dir.x * (sb ?? sa).twin!.dir.x + (sb ?? sa).dir.z * (sb ?? sa).twin!.dir.z > 0 ? '  <-- SAME WAY' : '';
    console.log(`  roads ${a} ${da} | ${b} ${db} near ${fmt(ps[0].pos)}${flag}`);
  }
}
const bad = sameWayStretches(city.roads);
console.log(`\n${bad.length} stretch(es) where both carriageways run the same way:`);
for (const w of bad) console.log(`  ${w.name}: roads ${w.roads.join(' & ')}, ${w.length} m from ${fmt(w.from)} to ${fmt(w.to)}`);
