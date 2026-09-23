import type { CityData, Vec2 } from './cityData';
import { forward, right } from './cityData';

/** Keep reset spots this far from a segment's ends so the bus isn't dropped past the city edge. */
const END_MARGIN = 10;
/** Extra clearance before/after a ramp or hump. */
const FEATURE_MARGIN = 6;

/**
 * Nearest drivable spot to `p`: on the closest road centerline, shifted into the right-hand
 * lane for whichever road direction is closer to `heading`, and moved along the road until
 * clear of ramps and humps.
 */
export function snapToRoad(city: CityData, p: Vec2, heading: number): { pos: Vec2; heading: number } {
  let best: { a: Vec2; dir: Vec2; len: number; t: number; width: number; lanes: number } | null = null;
  let bestD = Infinity;
  for (const r of city.roads) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 2 * END_MARGIN) continue;
      const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const t = Math.max(END_MARGIN, Math.min(len - END_MARGIN, (p.x - a.x) * dir.x + (p.z - a.z) * dir.z));
      const d = Math.hypot(p.x - (a.x + dir.x * t), p.z - (a.z + dir.z * t));
      if (d < bestD) {
        bestD = d;
        best = { a, dir, len, t, width: r.width, lanes: r.lanes };
      }
    }
  }
  if (!best) return { pos: city.spawn.pos, heading: city.spawn.heading };

  // Pick the road direction closest to where the bus was pointing.
  const cur = forward(heading);
  const sign = cur.x * best.dir.x + cur.z * best.dir.z >= 0 ? 1 : -1;
  const dir = { x: best.dir.x * sign, z: best.dir.z * sign };
  const snapped = Math.atan2(-dir.z, dir.x);

  // Center of the right-hand half of the road (one lane on streets, between lanes on avenues).
  const rt = right(snapped);
  const lateral = best.width / 4;
  const at = (t: number): Vec2 => ({
    x: best.a.x + best.dir.x * t + rt.x * lateral,
    z: best.a.z + best.dir.z * t + rt.z * lateral,
  });

  // Slide forward/back along the road past any feature under the spot.
  let t = best.t;
  for (let pass = 0; pass < 4; pass++) {
    const hit = city.features.find((f) => {
      const pos = at(t);
      const ff = forward(f.heading);
      const along = Math.abs((pos.x - f.pos.x) * ff.x + (pos.z - f.pos.z) * ff.z);
      const across = Math.abs((pos.x - f.pos.x) * ff.z - (pos.z - f.pos.z) * ff.x);
      return along < f.length / 2 + FEATURE_MARGIN && across < f.width / 2 + 2;
    });
    if (!hit) break;
    const ft = (hit.pos.x - best.a.x) * best.dir.x + (hit.pos.z - best.a.z) * best.dir.z;
    const clear = hit.length / 2 + FEATURE_MARGIN + 0.5;
    const back = ft - clear;
    const ahead = ft + clear;
    t = back >= END_MARGIN && (Math.abs(back - t) <= Math.abs(ahead - t) || ahead > best.len - END_MARGIN) ? back : ahead;
  }
  return { pos: at(t), heading: snapped };
}
