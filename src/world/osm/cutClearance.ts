import type { Road, Vec2 } from '../cityData';
import { liftAlong, projectOnRoad } from '../elevation';
import { segmentIntersection } from '../geom';
import { nearestPoint, resampled } from './busways';

/** Underpasses: roads dug in at least this deep somewhere (lift, m)... */
const DEEP = -1;
/** ...and the stretch of them with a retaining wall beside it (a street there squeezes the wall onto the lanes). */
const WALLED = -0.3;
/** Room a cut takes past its asphalt on each side: its shoulder and retaining wall (gradeBuilder's SHOULDER + WALL). */
const CUT_MARGIN = 1.1;
/** A street moves at most this far sideways. */
const MAX_SHIFT = 3.5;
/** Only a street running alongside the cut (|cos| of the angle between them over this) gives way. */
const ALONGSIDE = 0.7;
/** Sidewalk and verge on each side of a street, kept clear of other streets when one moves. */
const SIDEWALK_ROOM = 3;
/** Bend allowance, as gradeBuilder gives the cut's floor (a 12.5 m bus: L² / 8 per unit of curvature, at most 2 m, measured over 12 m). */
const BEND_SWEEP = (12.5 * 12.5) / 8;
const BEND_MAX = 2;
const BEND_SPAN = 12;
/** Asphalts overlapping by more than this (m) are a street running into a cut, not beside it. */
const MERGE_OVERLAP = 2.5;
/** A street stays put this far from where it crosses over any way of an underpass (it's on the roof there). */
const ROOF_REACH = 25;
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
 * no street moves toward another street, a busway (`busways`, not in `roads` yet) or another
 * cut close by.
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
    // under where it is): near where it crosses any way of that underpass, it stays put. Further
    // along it may still run beside another part of the same complex, and gives way there.
    const over = cuts.flatMap((c) => crossingPoints(road, c).map((at) => ({ at, group: group.get(c) })));
    const { pts, pin, toPin } = resampled(road, roads);
    if (pts.length < 3) return road;
    let moved = false;
    const push = pts.map((p, i): Vec2 => {
      if (pin[i]) return { x: 0, z: 0 };
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dir = unit(a, b);
      let v = { x: 0, z: 0 };
      for (const c of cuts) {
        if (over.some((o) => o.group === group.get(c) && Math.hypot(o.at.x - p.x, o.at.z - p.z) < ROOF_REACH)) continue;
        // Measured to the walled stretch of the cut only (the wall is what the street must clear):
        // its nearest point may be a few meters from the nearest point of the whole cut.
        const w = nearestWalled(c, p);
        if (!w) continue;
        const { s, d, q } = w;
        const need = road.width / 2 + c.width / 2 + CUT_MARGIN + bendRoom(c, s);
        if (d < 0.3 || d >= need) continue;
        // Asphalts overlapping this much: the street runs into the cut's mouth (a junction), not
        // beside it; a half-done push there leaves the cut's wall under the edge of its lanes.
        if (d < road.width / 2 + c.width / 2 - MERGE_OVERLAP) continue;
        // Over the shallow top of a ramp a street drawn overlapping it keeps its place: the wall
        // stands flush under its asphalt there (a part-done push would leave its ground beside the
        // ramp's lanes). Only a street beside it, clear of its asphalt, gives the wall room.
        if (liftAlong(c, projectOnRoad(c, p).s) >= DEEP && d < road.width / 2 + c.width / 2) continue;
        const cd = dirAlong(c, s);
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
      // Nor into another cut's wall: away from one underpass, it may run beside another.
      for (const c of cuts) {
        const w = nearestWalled(c, p);
        if (!w || w.d < 0.3 || w.d > road.width / 2 + c.width / 2 + CUT_MARGIN + BEND_MAX + MAX_SHIFT) continue;
        const { d, q } = w;
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

/**
 * Extra room on a bend of cut `c` `s` meters along it: a long bus sweeps wider than its lane
 * there (front overhang out, rear wheels in), about L² / 8R, the same allowance the cut's floor
 * gets (gradeBuilder's BEND_SWEEP/BEND_MAX), the widest within a bus length.
 */
function bendRoom(c: Road, s: number): number {
  let worst = 0;
  for (let k = -6; k <= 6; k += 2) {
    const a = dirAlong(c, s + k - BEND_SPAN / 2);
    const b = dirAlong(c, s + k + BEND_SPAN / 2);
    const turn = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z)));
    if (turn > 0.05) worst = Math.max(worst, Math.min(BEND_MAX, (BEND_SWEEP * turn) / BEND_SPAN));
  }
  return worst;
}

/** Direction of `r` `s` meters along it (clamped to its ends). */
function dirAlong(r: Road, s: number): Vec2 {
  let cum = 0;
  for (let i = 0; i < r.points.length - 1; i++) {
    const len = Math.hypot(r.points[i + 1].x - r.points[i].x, r.points[i + 1].z - r.points[i].z);
    if (s <= cum + len || i === r.points.length - 2) return unit(r.points[i], r.points[i + 1]);
    cum += len;
  }
  return { x: 1, z: 0 };
}

/** Samples of each cut's walled stretch (lift under WALLED), every meter along it, cached per road. */
const walledCache = new WeakMap<Road, { s: number; p: Vec2 }[]>();
function walledSamples(c: Road): { s: number; p: Vec2 }[] {
  let out = walledCache.get(c);
  if (out) return out;
  out = [];
  let cum = 0;
  for (let i = 0; i < c.points.length - 1; i++) {
    const a = c.points[i];
    const b = c.points[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    for (let t = 0; t < len; t += 1) {
      const s = cum + t;
      if (liftAlong(c, s) < WALLED) out.push({ s, p: { x: a.x + ((b.x - a.x) * t) / len, z: a.z + ((b.z - a.z) * t) / len } });
    }
    cum += len;
  }
  walledCache.set(c, out);
  return out;
}

/** Nearest point of cut `c`'s walled stretch to `p` (null where it has none). */
function nearestWalled(c: Road, p: Vec2): { s: number; d: number; q: Vec2 } | null {
  let best: { s: number; d: number; q: Vec2 } | null = null;
  for (const w of walledSamples(c)) {
    const d = Math.hypot(w.p.x - p.x, w.p.z - p.z);
    if (!best || d < best.d) best = { s: w.s, d, q: w.p };
  }
  return best;
}

/** Where road `a` crosses road `b`. */
function crossingPoints(a: Road, b: Road): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < a.points.length - 1; i++)
    for (let j = 0; j < b.points.length - 1; j++) {
      const hit = segmentIntersection(a.points[i], a.points[i + 1], b.points[j], b.points[j + 1]);
      if (hit) out.push(hit);
    }
  return out;
}

function unit(a: Vec2, b: Vec2): Vec2 {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}
