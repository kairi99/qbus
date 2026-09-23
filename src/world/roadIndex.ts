import type { Road, Vec2 } from './cityData';
import { distToSegment } from './geom';

const CELL = 30;

/** Grid-hashed road segments for fast "is this on the asphalt?" queries. */
export class RoadIndex {
  private cells = new Map<string, { a: Vec2; b: Vec2; half: number }[]>();
  private maxHalf = 0;

  constructor(roads: Road[]) {
    for (const r of roads) {
      const half = r.width / 2;
      this.maxHalf = Math.max(this.maxHalf, half);
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i];
        const b = r.points[i + 1];
        const x0 = Math.floor((Math.min(a.x, b.x) - half) / CELL);
        const x1 = Math.floor((Math.max(a.x, b.x) + half) / CELL);
        const z0 = Math.floor((Math.min(a.z, b.z) - half) / CELL);
        const z1 = Math.floor((Math.max(a.z, b.z) + half) / CELL);
        for (let x = x0; x <= x1; x++)
          for (let z = z0; z <= z1; z++) {
            const key = `${x},${z}`;
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            list.push({ a, b, half });
          }
      }
    }
  }

  /** Distance from `p` to the nearest road edge; negative on the asphalt. */
  clearance(p: Vec2): number {
    let best = Infinity;
    for (const s of this.cells.get(`${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`) ?? []) {
      best = Math.min(best, distToSegment(p, s.a, s.b) - s.half);
    }
    return best;
  }

  onAsphalt(p: Vec2, margin = 0): boolean {
    return this.clearance(p) < margin;
  }

  /** Does the straight line a→b stay off the asphalt (sampled every ~0.7 m)? */
  lineClear(a: Vec2, b: Vec2, margin = 0.1): boolean {
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.7));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.onAsphalt({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, margin)) return false;
    }
    return true;
  }
}
