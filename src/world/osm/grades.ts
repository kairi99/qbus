import type { Road, Vec2 } from '../cityData';
import { segmentIntersection } from '../geom';

/** Height between a lower road's surface and the one passing over it (deck included). */
export const CLEARANCE = 6.5;
/** Ramps climb or dive at most this steeply... */
const GRADE = 0.1;
/** ...unless they have to be back at street level for a junction that can't move. */
const STEEP = 0.16;
/** Roads with a ramp are resampled this finely so the ramp is smooth. */
const STEP = 3;
/** Road ends this close to another road connect to it. */
const JOIN = 1.5;
/** Relaxation passes that round off grade changes (each spreads them about a vertex, ~3 m, further). */
const SMOOTH_PASSES = 12;
/** Around an at-grade junction the road is locked level through the smoothing for this far. */
const JUNCTION_CORE = 10;
/** Roads stay level this far from an at-grade junction (about how far the graph trims them back). */
const JUNCTION_CLEAR = 10;
/** A crossing that can't be given at least this much room is treated as an ordinary junction. */
const MIN_GAP = 4.5;

/** Where one road passes over another. */
export interface Crossing {
  upper: number;
  lower: number;
  at: Vec2;
  /** Height difference the ramps achieved there (CLEARANCE, or less if squeezed). */
  gap: number;
}

interface Dense {
  pts: Vec2[];
  cum: number[];
  /** Global vertex id of pts[0]. */
  base: number;
}

/**
 * Bridges and underpasses. OSM tags the covered stretch of a road `bridge`/`tunnel` with a
 * `layer`; where two roads of different layers cross, the one tagged goes over (up) or under
 * (down) the other by CLEARANCE. The height change (the road's `lift`, meters off the ground)
 * ramps out from each crossing along the network (into the untagged approaches and any side
 * street on a ramp), and is squeezed back to zero before any road that has to stay put: a road
 * a bridge passes over never rises, a road over an underpass never dips. Roads that get a lift
 * come back resampled every few meters with a `lift` per point; the rest are untouched.
 */
export function separateGrades(roads: Road[]): { roads: Road[]; crossings: Crossing[] } {
  if (roads.every((r) => !r.layer)) return { roads, crossings: [] };
  // OSM sometimes tags a short link as a tunnel a few meters from where it passes over another
  // underpass: no ramp can do both. Those crossings meet at street level instead; solve again.
  const atGrade = new Set<string>();
  for (let pass = 0; ; pass++) {
    const result = solve(roads, atGrade);
    const bad = result.crossings.filter((c) => c.gap < MIN_GAP);
    if (!bad.length || pass === 5) return { roads: result.roads, crossings: result.crossings.filter((c) => c.gap >= MIN_GAP) };
    for (const c of bad) atGrade.add(`${c.upper},${c.lower}`).add(`${c.lower},${c.upper}`);
  }
}

function solve(roads: Road[], atGrade: Set<string>): { roads: Road[]; crossings: Crossing[] } {
  const layer = (i: number) => roads[i].layer ?? 0;

  // Dense copies of every road (original points kept), with global vertex ids.
  const dense: Dense[] = [];
  let count = 0;
  for (const r of roads) {
    const pts: Vec2[] = [r.points[0]];
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / STEP));
      for (let k = 1; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
      pts.push(b);
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    dense.push({ pts, cum, base: count });
    count += pts.length;
  }
  const roadOf = new Int32Array(count);
  dense.forEach((d, ri) => d.pts.forEach((_, k) => (roadOf[d.base + k] = ri)));
  const adj: [number, number][][] = Array.from({ length: count }, () => []);
  const link = (a: number, b: number, w: number) => {
    adj[a].push([b, w]);
    adj[b].push([a, w]);
  };
  dense.forEach((d) => {
    for (let k = 1; k < d.pts.length; k++) link(d.base + k - 1, d.base + k, d.cum[k] - d.cum[k - 1]);
  });
  const nearestVertex = (ri: number, s: number) => {
    const d = dense[ri];
    let lo = 0;
    let hi = d.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d.cum[mid] < s) lo = mid;
      else hi = mid;
    }
    return d.base + (s - d.cum[lo] < d.cum[hi] - s ? lo : hi);
  };
  const cumAt = (ri: number, i: number) => {
    let c = 0;
    const p = roads[ri].points;
    for (let k = 1; k <= i; k++) c += Math.hypot(p[k].x - p[k - 1].x, p[k].z - p[k - 1].z);
    return c;
  };

  // Every place two roads meet: grade-separated crossings, and at-grade joins.
  const CELL = 40;
  const hash = new Map<string, [number, number][]>();
  roads.forEach((r, ri) => {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      for (let x = Math.floor(Math.min(a.x, b.x) / CELL); x <= Math.floor(Math.max(a.x, b.x) / CELL); x++)
        for (let z = Math.floor(Math.min(a.z, b.z) / CELL); z <= Math.floor(Math.max(a.z, b.z) / CELL); z++) {
          const key = `${x},${z}`;
          hash.set(key, [...(hash.get(key) ?? []), [ri, i]]);
        }
    }
  });
  const crossings: (Crossing & { sUpper: number; sLower: number; sin: number })[] = [];
  /** Junctions: ramps never reach them (no side street joins a road halfway up a ramp). */
  const anchors = new Set<number>();
  const pairs = new Set<string>();
  const seen = new Set<string>();
  for (const list of hash.values())
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const [ri, i] = list[x];
        const [rj, j] = list[y];
        if (ri === rj) continue;
        const key = ri < rj ? `${ri},${i},${rj},${j}` : `${rj},${j},${ri},${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = roads[ri].points;
        const B = roads[rj].points;
        const hit = segmentIntersection(A[i], A[i + 1], B[j], B[j + 1]);
        if (!hit) continue;
        const si = cumAt(ri, i) + Math.hypot(hit.x - A[i].x, hit.z - A[i].z);
        const sj = cumAt(rj, j) + Math.hypot(hit.x - B[j].x, hit.z - B[j].z);
        const atEnd = (ri2: number, s: number) => s < 1 || s > dense[ri2].cum[dense[ri2].cum.length - 1] - 1;
        if (layer(ri) === layer(rj) || atEnd(ri, si) || atEnd(rj, sj) || atGrade.has(`${ri},${rj}`)) {
          const va = nearestVertex(ri, si);
          const vb = nearestVertex(rj, sj);
          link(va, vb, 0);
          // Streets crossing at grade: a junction, which stays at street level.
          if (!atEnd(ri, si) && !atEnd(rj, sj)) anchors.add(va).add(vb);
          continue;
        }
        const [upper, lower, sUpper, sLower] = layer(ri) > layer(rj) ? [ri, rj, si, sj] : [rj, ri, sj, si];
        const da = unit(A[i], A[i + 1]);
        const db = unit(B[j], B[j + 1]);
        crossings.push({ upper, lower, at: hit, gap: 0, sUpper, sLower, sin: Math.abs(da.x * db.z - da.z * db.x) });
        pairs.add(`${upper},${lower}`).add(`${lower},${upper}`);
      }

  // A road that carries on from one that crosses over/under another (OSM splits ways anywhere)
  // is on the same level there: it doesn't meet the other road either.
  const ends = (ri: number) => [roads[ri].points[0], roads[ri].points[roads[ri].points.length - 1]];
  const touching = (a: number, b: number) => ends(a).some((p) => ends(b).some((q) => Math.hypot(p.x - q.x, p.z - q.z) < JOIN));
  for (const c of [...crossings])
    for (const [moved, other] of [
      [c.upper, c.lower],
      [c.lower, c.upper],
    ])
      roads.forEach((_, ri) => {
        if (ri === moved || ri === other || !touching(ri, moved)) return;
        if (ends(ri).some((p) => Math.hypot(p.x - c.at.x, p.z - c.at.z) < 12)) pairs.add(`${ri},${other}`).add(`${other},${ri}`);
      });

  // Road ends join whatever road they touch (unless the two pass over each other).
  const vhash = new Map<string, number[]>();
  const vkey = (p: Vec2) => `${Math.floor(p.x / 5)},${Math.floor(p.z / 5)}`;
  dense.forEach((d) =>
    d.pts.forEach((p, k) => {
      const key = vkey(p);
      vhash.set(key, [...(vhash.get(key) ?? []), d.base + k]);
    }),
  );
  const vertexPos = (v: number) => dense[roadOf[v]].pts[v - dense[roadOf[v]].base];
  const endVertex = (v: number) => {
    const d = dense[roadOf[v]];
    return v === d.base || v === d.base + d.pts.length - 1;
  };
  dense.forEach((d, ri) => {
    for (const k of [0, d.pts.length - 1]) {
      const p = d.pts[k];
      const best = new Map<number, [number, number]>();
      const cx = Math.floor(p.x / 5);
      const cz = Math.floor(p.z / 5);
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          for (const v of vhash.get(`${cx + dx},${cz + dz}`) ?? []) {
            const rj = roadOf[v];
            if (rj === ri || pairs.has(`${ri},${rj}`)) continue;
            const q = vertexPos(v);
            const dist = Math.hypot(q.x - p.x, q.z - p.z);
            if (dist < JOIN + STEP / 2 && dist < (best.get(rj)?.[1] ?? Infinity)) best.set(rj, [v, dist]);
          }
      for (const [v] of best.values()) link(d.base + k, v, 0);
      // A road carries on into the next piece of the same chain (two ends meeting); a road
      // ending on another one's side, or three or more ends meeting, is a junction.
      const others = [...best.values()].map(([v]) => v);
      if (others.length > 1 || others.some((v) => !endVertex(v))) anchors.add(d.base + k).add(others[0]);
      for (const v of others) if (!endVertex(v)) anchors.add(v);
    }
  });

  // A junction is paved at street level over some meters around its center (the road graph
  // trims roads back that far): every road meeting it stays level for JUNCTION_CLEAR, so a ramp
  // finishes climbing before the junction instead of arriving under its paving.
  // What must stay exactly level no matter what (for the grade smoothing below): the junction
  // itself and a few meters around it.
  const junctionCore = new Set<number>();
  for (const v of [...anchors]) {
    const d = dense[roadOf[v]];
    const k0 = v - d.base;
    d.cum.forEach((c, k) => Math.abs(c - d.cum[k0]) <= JUNCTION_CORE && junctionCore.add(d.base + k));
  }
  for (const v of [...anchors]) {
    const d = dense[roadOf[v]];
    const k0 = v - d.base;
    for (let k = k0 - 1; k >= 0 && d.cum[k0] - d.cum[k] <= JUNCTION_CLEAR; k--) anchors.add(d.base + k);
    for (let k = k0 + 1; k < d.pts.length && d.cum[k] - d.cum[k0] <= JUNCTION_CLEAR; k++) anchors.add(d.base + k);
  }

  // Peaks: the stretch of each moving road right over/under the other one.
  type Peak = { road: number; s: number; flat: number; h: number };
  const up: Peak[] = [];
  const down: Peak[] = [];
  for (const c of crossings) {
    const lu = layer(c.upper);
    const ll = layer(c.lower);
    const rise = lu > 0 && ll >= 0 ? CLEARANCE : lu > 0 ? CLEARANCE / 2 : 0;
    const dive = CLEARANCE - rise;
    const flat = (w: number) => Math.min(30, (w / 2 + 4) / Math.max(0.3, c.sin));
    if (rise) up.push({ road: c.upper, s: c.sUpper, flat: flat(roads[c.lower].width), h: rise });
    if (dive) down.push({ road: c.lower, s: c.sLower, flat: flat(roads[c.upper].width), h: dive });
  }

  // Where a road passes over (or under) another it must stay at street level: the stretch of
  // it right at the crossing. (The rest of it may still ramp, say out of another underpass.)
  const stretch = (ri: number, s: number, flat: number) => dense[ri].cum.flatMap((c, k) => (Math.abs(c - s) <= flat ? [dense[ri].base + k] : []));
  const lift = new Float64Array(count);
  /**
   * Vertices whose lift must stay exact through the grade smoothing: the junction cores, and at
   * each crossing just the part right under/over the other road (the rest of the flat may round).
   */
  const locked = new Set<number>(junctionCore);
  const core = (ri: number, s: number, other: number, sin: number) => stretch(ri, s, Math.min(30, (roads[other].width / 2 + 2) / Math.max(0.3, sin)));
  for (const c of crossings) for (const v of [...core(c.upper, c.sUpper, c.lower, c.sin), ...core(c.lower, c.sLower, c.upper, c.sin)]) locked.add(v);
  for (const [peaks, sign, stays] of [
    [up, 1, crossings.flatMap((c) => stretch(c.lower, c.sLower, Math.min(30, (roads[c.upper].width / 2 + 4) / Math.max(0.3, c.sin))))],
    [down, -1, crossings.flatMap((c) => stretch(c.upper, c.sUpper, Math.min(30, (roads[c.lower].width / 2 + 4) / Math.max(0.3, c.sin))))],
  ] as const) {
    if (!peaks.length) continue;
    // Stretches that must stay at street level (except on roads that move themselves).
    const moving = new Set(peaks.map((p) => p.road));
    const fixed = new Set(stays.filter((v) => !moving.has(roadOf[v])));
    const isFixed = (v: number) => fixed.has(v) || anchors.has(v);
    const anchor = dijkstra(adj, [...fixed, ...anchors], CLEARANCE / STEEP, () => false);
    const best = new Float64Array(count);
    for (const p of peaks) {
      const d = dense[p.road];
      const sources: number[] = [];
      d.cum.forEach((s, k) => Math.abs(s - p.s) <= p.flat && sources.push(d.base + k));
      const dist = dijkstra(adj, sources, p.h / GRADE, isFixed);
      for (const [v, dv] of dist) best[v] = Math.max(best[v], p.h - dv * GRADE);
    }
    for (let v = 0; v < count; v++) {
      if (!best[v] || isFixed(v)) continue;
      lift[v] += sign * Math.min(best[v], (anchor.get(v) ?? Infinity) * STEEP);
    }
  }

  // Round off the grade changes (a V where a descent meets a climb bottoms out a long bus):
  // relax the free vertices toward their neighbors' average a number of times, which spreads
  // each change of grade over about ten meters. Locked vertices keep their exact lift, so
  // crossings keep their clearance and junctions stay level.
  const moved = new Set<number>();
  for (let v = 0; v < count; v++) if (lift[v]) for (const [w] of adj[v]) moved.add(w), moved.add(v);
  const free = [...moved].filter((v) => !locked.has(v));
  for (let it = 0; it < SMOOTH_PASSES; it++) {
    const next = new Float64Array(free.length);
    free.forEach((v, i) => {
      let sum = lift[v];
      for (const [w] of adj[v]) sum += lift[w];
      next[i] = sum / (adj[v].length + 1);
    });
    free.forEach((v, i) => (lift[v] = next[i]));
  }

  const out = roads.map((r, ri) => {
    const d = dense[ri];
    const l = Array.from({ length: d.pts.length }, (_, k) => Math.round(lift[d.base + k] * 100) / 100);
    if (l.every((x) => Math.abs(x) < 0.02)) return r;
    // Original OSM vertices stay exact: other roads meet them (shared nodes), and a rounded
    // copy a few millimeters off no longer touches, which cuts the junction out of the graph.
    const original = new Set(r.points);
    return { ...r, points: d.pts.map((p) => (original.has(p) ? p : { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 })), lift: l };
  });
  for (const c of crossings) c.gap = lift[nearestVertex(c.upper, c.sUpper)] - lift[nearestVertex(c.lower, c.sLower)];
  return { roads: out, crossings: crossings.map(({ upper, lower, at, gap }) => ({ upper, lower, at, gap })) };
}

/** Distances from `sources` along the network, up to `limit`, never entering `blocked` vertices. */
function dijkstra(adj: [number, number][][], sources: number[], limit: number, blocked: (v: number) => boolean): Map<number, number> {
  const dist = new Map<number, number>();
  const heap: [number, number][] = [];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heap[up][0] <= heap[i][0]) break;
      [heap[up], heap[i]] = [heap[i], heap[up]];
      i = up;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of sources) {
    dist.set(s, 0);
    push(0, s);
  }
  while (heap.length) {
    const [d, v] = pop();
    if (d > (dist.get(v) ?? Infinity)) continue;
    for (const [w, len] of adj[v]) {
      const nd = d + len;
      if (nd > limit || blocked(w) || nd >= (dist.get(w) ?? Infinity)) continue;
      dist.set(w, nd);
      push(nd, w);
    }
  }
  return dist;
}

function unit(a: Vec2, b: Vec2): Vec2 {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}
