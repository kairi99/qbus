import * as THREE from 'three';
import type { CityData, Vec2 } from './cityData';
import { profileAt, roadProfiles } from './elevation';
import type { RoadGraph } from './roadGraph';
import { FLOOD_MAX } from '../gameplay/weather';

/** Roads dug in at least this deep somewhere are underpasses (as `clearCuts` counts them). */
const DEEP = -1;
/** Samples along each cut road (m). */
const STEP = 2;
/** Water reaches past the asphalt over the cut's shoulders (gradeBuilder's SHOULDER), to its walls. */
const SHOULDER = 0.6;
/** Cut roads whose floors come this close (m past their asphalt) at about the same height (SAME_FLOOR) are one underpass. */
const JOIN = 1.5;
const SAME_FLOOR = 1;

/** One stretch of a cut's floor the water can cover: a centerline segment, its half width and floor heights. */
interface Strip {
  a: Vec2;
  b: Vec2;
  ya: number;
  yb: number;
  hw: number;
}

/** An underpass (cut roads joined end to end) and the low part of it a flood fills. */
export interface Basin {
  /** Lowest point of its floor: the water stands `flood` meters over it. */
  floor: number;
  strips: Strip[];
}

/**
 * The underpasses' basins: each set of dug-in roads (a road lifted below DEEP somewhere) whose
 * floors meet collects rain at its lowest point; the stretches of its floor less
 * than FLOOD_MAX over that point are where the water can stand.
 */
export function floodBasins(city: CityData): Basin[] {
  const profiles = roadProfiles(city);
  const cuts = city.roads.map((r, i) => ({ r, p: profiles[i] })).filter((c) => !c.r.access && c.p && c.r.lift!.some((l) => l < DEEP));
  // Samples of each cut's floor, then the cuts grouped into underpasses: two whose floors touch
  // at about the same height share their water (the Patria/12 de Octubre ways meet at junctions
  // down in the cut, not end to end).
  const samples = cuts.map(({ r, p }) => {
    const len = p!.cum[p!.cum.length - 1];
    const n = Math.max(1, Math.ceil(len / STEP));
    return Array.from({ length: n + 1 }, (_, k) => {
      const s = (len * k) / n;
      return { q: pointAt(r.points, p!.cum, s), y: profileAt(p!, s).y };
    });
  });
  const parent = cuts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < cuts.length; i++)
    for (let j = i + 1; j < cuts.length; j++) {
      const reach = (cuts[i].r.width + cuts[j].r.width) / 2 + JOIN;
      if (samples[i].some((a) => samples[j].some((b) => Math.hypot(a.q.x - b.q.x, a.q.z - b.q.z) < reach && Math.abs(a.y - b.y) < SAME_FLOOR))) parent[find(i)] = find(j);
    }
  const groups = new Map<number, number[]>();
  cuts.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));

  const basins: Basin[] = [];
  for (const group of groups.values()) {
    const strips: Strip[] = [];
    for (const i of group) {
      const hw = cuts[i].r.width / 2 + SHOULDER;
      for (let k = 1; k < samples[i].length; k++) {
        const [a, b] = [samples[i][k - 1], samples[i][k]];
        strips.push({ a: a.q, b: b.q, ya: a.y, yb: b.y, hw });
      }
    }
    const floor = Math.min(...strips.map((s) => Math.min(s.ya, s.yb)));
    basins.push({ floor, strips: strips.filter((s) => Math.min(s.ya, s.yb) < floor + FLOOD_MAX + 0.3) });
  }
  return basins;
}

function pointAt(pts: Vec2[], cum: number[], s: number): Vec2 {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
}

/** Distance from `p` to segment ab, and how far along it (0..1). */
function toSegment(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return { d: Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t), t };
}

/**
 * How deep the water is (m) for something on the road at `p`, `y` (its road height), with the
 * underpasses flooded `flood` meters deep: 0 out of every basin, or above its water (a street
 * crossing over the flooded underpass is dry).
 */
export function waterDepth(basins: Basin[], p: Vec2, y: number, flood: number): number {
  if (flood <= 0) return 0;
  let depth = 0;
  for (const b of basins) {
    const level = b.floor + flood;
    if (y >= level || y < b.floor - 1) continue;
    for (const s of b.strips) {
      const { d, t } = toSegment(p, s.a, s.b);
      // On this floor (not a ramp alongside at another level that overlaps it).
      if (d <= s.hw && Math.abs(y - (s.ya + (s.yb - s.ya) * t)) < 1.5) depth = Math.max(depth, level - y);
    }
  }
  return depth;
}

/**
 * Lane edges running through each basin's water when it's `flood` deep: for each edge down in an
 * underpass, the lowest point of it (edges never reach it are left out). Traffic crawls through
 * water standing over that point.
 */
export function floodedEdges(basins: Basin[], graph: RoadGraph): { edge: number; basin: number; low: number }[] {
  const out: { edge: number; basin: number; low: number }[] = [];
  for (const e of graph.edges) {
    if (!e.y) continue;
    const low = Math.min(...e.y);
    const pt = e.center.pts[e.y.indexOf(low)];
    const basin = basins.findIndex((b) => Math.abs(low - b.floor) < FLOOD_MAX + 0.3 && b.strips.some((s) => toSegment(pt, s.a, s.b).d < s.hw));
    if (basin >= 0) out.push({ edge: e.id, basin, low });
  }
  return out;
}

/**
 * Muddy floodwater over every basin, one mesh: each basin's water is drawn flat at its floor and
 * the whole mesh is raised by the flood's depth (`setFlood`), so the water stays level and the
 * road climbing out of it covers what's beyond its edge. Opaque (overlapping strips would double up
 * if it were see-through), with a sheen.
 */
export class FloodWater {
  readonly mesh: THREE.Mesh;

  constructor(basins: Basin[]) {
    const pos: number[] = [];
    for (const b of basins)
      for (const s of b.strips) {
        const dx = s.b.x - s.a.x;
        const dz = s.b.z - s.a.z;
        const l = Math.hypot(dx, dz) || 1;
        // Across, and a little longer than the segment so neighbors overlap without slits.
        const [nx, nz] = [(-dz / l) * s.hw, (dx / l) * s.hw];
        const [ex, ez] = [(dx / l) * 0.3, (dz / l) * 0.3];
        const a = [s.a.x - ex, s.a.z - ez];
        const c = [s.b.x + ex, s.b.z + ez];
        const y = b.floor;
        pos.push(a[0] + nx, y, a[1] + nz, c[0] + nx, y, c[1] + nz, c[0] - nx, y, c[1] - nz);
        pos.push(a[0] + nx, y, a[1] + nz, c[0] - nx, y, c[1] - nz, a[0] - nx, y, a[1] - nz);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: '#6e5d45', specular: '#9a9a8c', shininess: 70, side: THREE.DoubleSide }));
    this.mesh.name = 'floodwater';
    this.mesh.visible = false;
    this.mesh.receiveShadow = true;
  }

  setFlood(depth: number): void {
    this.mesh.visible = depth > 0.02;
    this.mesh.position.y = depth;
  }
}
