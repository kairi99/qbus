/**
 * Groups drive.ts records by edge -> next: per vehicle@speed, wall contacts (count, where, peak
 * impulse), reached, stall. Usage: npx tsx tools/underpass-recon/summarize.ts out/drive-all.jsonl
 */
import { readFileSync } from 'node:fs';
const recs = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const groups = new Map<string, any[]>();
for (const r of recs) {
  const k = `edge ${r.edge} ${r.road} -> ${r.nextRoad ?? '-'}(${r.next})`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
for (const [k, list] of groups) {
  const bad = list.filter((r) => !r.reached || r.wallN > 0 || r.maxStall > 1 || r.airborne > 0.3);
  if (!bad.length) {
    console.log(`OK   ${k}`);
    continue;
  }
  console.log(`BAD  ${k}`);
  for (const r of list) {
    const walls = r.wall.map((w: any) => `(${w.x},${w.z}) ${w.shape} imp${w.imp} n[${w.nx},${w.ny},${w.nz}] cpRel${w.cpRel} v${w.v}`);
    const peak = Math.max(0, ...r.wall.map((w: any) => w.imp));
    console.log(
      `   ${r.vehicle}@${r.kmh}: reached=${r.reached} t=${r.time.toFixed(1)} wallN=${r.wallN} peakImp=${peak} stall=${r.maxStall.toFixed(1)} air=${r.airborne.toFixed(2)} dev=${r.maxDev.toFixed(1)} maxDecel=${r.maxDecel.toFixed(1)}@${r.maxDecelAt ? `(${r.maxDecelAt.x.toFixed(0)},${r.maxDecelAt.z.toFixed(0)})` : '-'} end=(${r.end.x},${r.end.z})`,
    );
    if (walls.length) console.log(`      walls: ${walls.slice(0, 4).join(' | ')}`);
  }
}
