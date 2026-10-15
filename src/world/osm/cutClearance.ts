import type { Road, Vec2 } from '../cityData';
import { liftAlong, projectOnRoad } from '../elevation';
import { segmentIntersection } from '../geom';
import { nearestPoint, resampled } from './busways';

/** A cut at least this deep (lift, m) has a retaining wall along it. */
const DEEP = -1;
/** Room a cut takes past its asphalt on each side: its shoulder and retaining wall (gradeBuilder's SHOULDER + WALL). */
const CUT_MARGIN = 1.1;
/** A street moves at most this far sideways. */
const MAX_SHIFT = 3.5;
/** Only a street running alongside the cut (|cos| of the angle between them over this) gives way. */
const ALONGSIDE = 0.7;
/** Sidewalk and verge on each side of a street, kept clear of other streets when one moves. */
const SIDEWALK_ROOM = 3;
/** The push tapers to nothing this far from a vertex shared with another road. */
const TAPER = 14;

/**
 * Pushes street-level roads sideways off the cuts they run alongside. OSM draws a divided
 * avenue's carriageways a few meters apart, and ours are drawn with generic widths: where one
 * carriageway dives into an underpass and the other stays up, their asphalts overlapped by up to
 * 2 m (12 de Octubre by El Ejido), so the street's edge hung over the cut (a hole a bus drops its
 * wheels into) or the cut had no room for its shoulder and wall. Each street point moves away
 * from the cut's centerline by the shortfall (at most MAX_SHIFT); ends and every vertex shared
 * with another road stay exactly where they were, with the push tapered toward them, so every
 * junction in the road graph stays exact. Roads off the ground (ramps, bridges) never move, and
 * no street moves toward another street or a busway (`busways`, not in `roads` yet) close by.
 */
export function clearCuts(roads: Road[], busways: Road[] = []): Road[] {
  const cuts = roads.filter((r) => !r.access && r.lift?.some((l) => l < DEEP));
  if (!cuts.length) return roads;
  const streets = [...roads.filter((r) => !r.access && !r.lift), ...busways];
  // Cuts joined end to end are one underpass (OSM splits a tunnel's ways anywhere).
  const group = new Map<Road, number>(cuts.map((c, i) => [c, i]));
  const touch = (a: Road, b: Road) => [a.points[0], a.points[a.points.length - 1]].some((p) => [b.points[0], b.points[b.points.length - 1]].some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 1.5));
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of cuts)
      for (const b of cuts)
        if (group.get(a)! < group.get(b)! && touch(a, b)) {
          const [from, to] = [group.get(b)!, group.get(a)!];
          for (const c of cuts) if (group.get(c) === from) group.set(c, to);
          changed = true;
        }
  }
  return roads.map((road) => {
    if (road.access || road.lift || road.points.length < 2) return road;
    const reach = road.width / 2 + CUT_MARGIN + Math.max(...cuts.map((c) => c.width / 2));
    if (!cuts.some((c) => c.points.some((q) => road.points.some((p) => Math.hypot(p.x - q.x, p.z - q.z) < reach + 60)))) return road;
    // A street crossing over an underpass is on its roof, not beside it (and the cut stays level
    // under where it is): only the underpasses it runs beside without crossing count.
    const over = new Set(cuts.filter((c) => crosses(road, c)).map((c) => group.get(c)));
    const beside = cuts.filter((c) => !over.has(group.get(c)));
    if (!beside.length) return road;
    const { pts, pin, toPin } = resampled(road, roads);
    if (pts.length < 3) return road;
    let moved = false;
    const push = pts.map((p, i): Vec2 => {
      if (pin[i]) return { x: 0, z: 0 };
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dir = unit(a, b);
      let v = { x: 0, z: 0 };
      for (const c of beside) {
        const { s, d } = projectOnRoad(c, p);
        const need = road.width / 2 + c.width / 2 + CUT_MARGIN;
        if (d < 0.3 || d >= need || liftAlong(c, s) >= DEEP) continue;
        const q = nearestPoint(c.points, p);
        const cd = cutDir(c, q);
        if (Math.abs(cd.x * dir.x + cd.z * dir.z) < ALONGSIDE) continue;
        const k = Math.min(MAX_SHIFT, need - d);
        v = { x: v.x + ((p.x - q.x) / d) * k, z: v.z + ((p.z - q.z) / d) * k };
      }
      // Never toward another street (or busway) close by: its asphalt or sidewalks would end up under ours.
      for (const o of streets) {
        if (o === road) continue;
        const q = nearestPoint(o.points, p);
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < 0.3 || d > road.width / 2 + o.width / 2 + 2 * SIDEWALK_ROOM) continue;
        const n = { x: (q.x - p.x) / d, z: (q.z - p.z) / d };
        const toward = v.x * n.x + v.z * n.z;
        if (toward > 0) v = { x: v.x - n.x * toward, z: v.z - n.z * toward };
      }
      const l = Math.hypot(v.x, v.z);
      if (l > 0.01) moved = true;
      return l > MAX_SHIFT ? { x: (v.x / l) * MAX_SHIFT, z: (v.z / l) * MAX_SHIFT } : v;
    });
    if (!moved) return road;
    // Widest push over a few meters around each point (so the street clears the cut along the
    // whole stretch, not just at its worst), then tapered toward the pinned points.
    const wide = push.map((_, i) => {
      let best = push[i];
      for (let j = Math.max(0, i - 2); j <= Math.min(push.length - 1, i + 2); j++) if (!pin[j] && Math.hypot(push[j].x, push[j].z) > Math.hypot(best.x, best.z)) best = push[j];
      return pin[i] ? push[i] : best;
    });
    const out = pts.map((p, i) => {
      if (pin[i]) return p;
      const k = Math.min(1, toPin[i] / TAPER);
      return { x: Math.round((p.x + wide[i].x * k) * 100) / 100, z: Math.round((p.z + wide[i].z * k) * 100) / 100 };
    });
    return { ...road, points: out };
  });
}

function crosses(a: Road, b: Road): boolean {
  for (let i = 0; i < a.points.length - 1; i++)
    for (let j = 0; j < b.points.length - 1; j++) if (segmentIntersection(a.points[i], a.points[i + 1], b.points[j], b.points[j + 1])) return true;
  return false;
}

function unit(a: Vec2, b: Vec2): Vec2 {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}

/** Direction of the segment of `c` nearest `q` (a point on it). */
function cutDir(c: Road, q: Vec2): Vec2 {
  let best = { d: Infinity, dir: { x: 1, z: 0 } };
  for (let i = 0; i < c.points.length - 1; i++) {
    const a = c.points[i];
    const b = c.points[i + 1];
    const m = { x: Math.max(Math.min(a.x, b.x), Math.min(Math.max(a.x, b.x), q.x)), z: Math.max(Math.min(a.z, b.z), Math.min(Math.max(a.z, b.z), q.z)) };
    const d = Math.hypot(m.x - q.x, m.z - q.z);
    if (d < best.d) best = { d, dir: unit(a, b) };
  }
  return best.dir;
}
