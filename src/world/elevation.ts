import type { CityData, Road, Vec2 } from './cityData';
import { terrainAt } from './cityData';

/** A lifted road's surface: height at each of its points. */
export interface RoadProfile {
  cum: number[];
  y: number[];
  lift: number[];
}

/** Radius of the averaging disc that turns bumpy ground into a smooth deck or floor. */
const SMOOTH = 15;
/** Lift over which the surface goes from following the ground to following the smooth line. */
const BLEND = 1.5;
/** Lift that makes a road a bridge deck or an underpass (below it, it just lies on the ground). */
export const LIFTED = 0.3;

const cache = new WeakMap<CityData, { scale: number; profiles: (RoadProfile | null)[] }>();

/**
 * Surfaces of bridges, underpasses and their ramps. Where a road is lifted it follows a smoothed
 * line of the ground under it (a bridge deck doesn't copy the bumps below) plus its lift; at the
 * ends of a ramp it blends back into the ground. Null for roads on the ground.
 */
export function roadProfiles(city: CityData): (RoadProfile | null)[] {
  const scale = city.terrain?.scale ?? 1;
  const hit = cache.get(city);
  if (hit && hit.scale === scale) return hit.profiles;
  const profiles = city.roads.map((r) => (r.lift ? profile(city, r) : null));
  cache.set(city, { scale, profiles });
  return profiles;
}

function profile(city: CityData, r: Road): RoadProfile {
  const pts = r.points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const lift = r.lift!;
  const y = pts.map((p, i) => {
    const w = Math.min(1, Math.abs(lift[i]) / BLEND);
    return terrainAt(city, p) * (1 - w) + smoothGround(city, p) * w + lift[i];
  });
  return { cum, y, lift };
}

/**
 * The road surface at `p` (a point across the road from where `at` was sampled on its profile).
 * Near the ground (a ramp's shallow ends) it follows the ground under `p`, cross slope and all,
 * so no level slab edge sticks up out of a sloping street; deeper it's the level deck or floor.
 * The rendered road (cityBuilder) and the solid decks and floors (gradeBuilder) both use this.
 */
export function surfaceY(city: CityData, at: { y: number; lift: number }, p: Vec2, ground = terrainAt(city, p)): number {
  const w = Math.max(0, Math.min(1, (Math.abs(at.lift) - 0.2) / 1));
  return (ground + at.lift) * (1 - w) + at.y * w;
}

/**
 * The ground around `p`, averaged over a disc (the DSM has buildings and trees in it that a
 * deck or tunnel floor shouldn't copy). A function of position only, so two roads meeting at a
 * point (a tunnel continuing as another OSM way) get the same floor height there: no step.
 */
function smoothGround(city: CityData, p: Vec2): number {
  let sum = terrainAt(city, p) * 2;
  let wsum = 2;
  for (const [r, w] of [
    [SMOOTH / 2, 1.5],
    [SMOOTH, 1],
  ] as const)
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      sum += terrainAt(city, { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r }) * w;
      wsum += w;
    }
  return sum / wsum;
}

/** Height and lift `s` meters along a profile. */
export function profileAt(p: RoadProfile, s: number): { y: number; lift: number } {
  const { cum } = p;
  if (s <= 0) return { y: p.y[0], lift: p.lift[0] };
  if (s >= cum[cum.length - 1]) return { y: p.y[p.y.length - 1], lift: p.lift[p.lift.length - 1] };
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return { y: p.y[lo] + (p.y[hi] - p.y[lo]) * t, lift: p.lift[lo] + (p.lift[hi] - p.lift[lo]) * t };
}

/** Nearest point of a road's centerline to `q`: distance along it, and how far off `q` is. */
export function projectOnRoad(r: Road, q: Vec2): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  let cum = 0;
  for (let i = 0; i < r.points.length - 1; i++) {
    const a = r.points[i];
    const b = r.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-9) {
      const u = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.z - a.z) * dz) / (len * len)));
      const d = Math.hypot(q.x - (a.x + u * dx), q.z - (a.z + u * dz));
      if (d < best.d) best = { s: cum + u * len, d };
    }
    cum += len;
  }
  return best;
}

/** Lift of a road `s` meters along it (0 on roads without one). */
export function liftAlong(r: Road, s: number): number {
  if (!r.lift) return 0;
  let cum = 0;
  for (let i = 0; i < r.points.length - 1; i++) {
    const len = Math.hypot(r.points[i + 1].x - r.points[i].x, r.points[i + 1].z - r.points[i].z);
    if (s <= cum + len) return r.lift[i] + (r.lift[i + 1] - r.lift[i]) * Math.max(0, (s - cum) / (len || 1));
    cum += len;
  }
  return r.lift[r.lift.length - 1];
}
