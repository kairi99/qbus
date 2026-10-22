import { RAPIER } from '../physics/world';

/** Half the solid's thickness (m), and how far under the road and over the beam's top it reaches. */
const HALF = 0.15;
const BELOW = 0.3;
const ABOVE = 0.15;

/**
 * A guardrail's collision: one closed trimesh slab along the whole stretch (road surface up to
 * just over the beam), smooth and frictionless. Built as separate boxes per post gap, a vehicle
 * sliding along caught the next box's corner at every bend and stopped dead; one mesh with
 * Rapier's internal-edge fix lets it scrape along and lose speed only to the angle it hit at.
 * `points`: the rail's line, `y` the road under it, `top` the beam's height over the road.
 */
export function railSolid(points: { x: number; z: number; y: number }[], top: number, world: RAPIER.World, fixed: RAPIER.RigidBody): RAPIER.Collider | null {
  const n = points.length;
  if (n < 2) return null;
  const v = new Float32Array(n * 4 * 3);
  points.forEach((p, k) => {
    // Across the line at each point: the mean of its two neighbors' direction (mitred joins).
    const a = points[Math.max(0, k - 1)];
    const b = points[Math.min(n - 1, k + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const ox = (-(b.z - a.z) / l) * HALF;
    const oz = ((b.x - a.x) / l) * HALF;
    const [lo, hi] = [p.y - BELOW, p.y + top + ABOVE];
    v.set([p.x - ox, lo, p.z - oz, p.x - ox, hi, p.z - oz, p.x + ox, hi, p.z + oz, p.x + ox, lo, p.z + oz], k * 12);
  });
  const idx: number[] = [];
  // Inner face, top, outer face and the bottom between each pair of rings; caps at both ends.
  for (let k = 0; k + 1 < n; k++)
    for (let f = 0; f < 4; f++) {
      const [a, b] = [k * 4 + f, k * 4 + ((f + 1) % 4)];
      const [c, d] = [b + 4, a + 4];
      idx.push(a, b, c, a, c, d);
    }
  const last = (n - 1) * 4;
  idx.push(0, 2, 1, 0, 3, 2, last, last + 1, last + 2, last, last + 2, last + 3);
  const desc = RAPIER.ColliderDesc.trimesh(v, new Uint32Array(idx), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
  return world.createCollider(desc.setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min), fixed);
}
