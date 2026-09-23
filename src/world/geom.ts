import type { Vec2 } from './cityData';

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

export function distToPolyline(p: Vec2, points: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) best = Math.min(best, distToSegment(p, points[i], points[i + 1]));
  return best;
}

/** Intersection point of segments ab and cd, or null. */
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = { x: b.x - a.x, z: b.z - a.z };
  const s = { x: d.x - c.x, z: d.z - c.z };
  const denom = r.x * s.z - r.z * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * s.z - (c.z - a.z) * s.x) / denom;
  const u = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * r.x, z: a.z + t * r.z };
}

export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentIntersection(a, b, c, d)) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Minimum distance between a polygon (outline and interior) and a polyline. */
export function polygonToPolylineDistance(poly: Vec2[], line: Vec2[]): number {
  if (line.some((p) => pointInPolygon(p, poly))) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    for (let j = 0; j < line.length - 1; j++) best = Math.min(best, segmentDistance(a, b, line[j], line[j + 1]));
  }
  return best;
}

export function rect(x0: number, z0: number, x1: number, z1: number): Vec2[] {
  return [
    { x: x0, z: z0 },
    { x: x1, z: z0 },
    { x: x1, z: z1 },
    { x: x0, z: z1 },
  ];
}

export function bbox(poly: Vec2[]): { min: Vec2; max: Vec2 } {
  const xs = poly.map((p) => p.x);
  const zs = poly.map((p) => p.z);
  return { min: { x: Math.min(...xs), z: Math.min(...zs) }, max: { x: Math.max(...xs), z: Math.max(...zs) } };
}
