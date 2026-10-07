/** Extra cut shoulder on bends (gradeBuilder `bendAlong`) every 3 m along the given roads. Usage: npx tsx tools/underpass-recon/bends.ts 115 89 ... */
import { readFileSync } from 'node:fs';
import type { CityData } from '../../src/world/cityData';
import { roadProfiles } from '../../src/world/elevation';
import { bendAlong } from '../../src/world/gradeBuilder';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const p = roadProfiles(city);
const dug = city.roads.map((_, i) => !!p[i] && p[i]!.lift.some((l) => l < -0.03));
for (const a of process.argv.slice(2)) {
  const i = Number(a);
  const f = bendAlong(city, i, dug);
  const out: string[] = [];
  for (let s = 0; s < p[i]!.cum[p[i]!.cum.length - 1]; s += 3) out.push(`${s}:${f(s).toFixed(1)}`);
  console.log(`#${i} ${out.join(' ')}`);
}
