import { RAPIER } from '../physics/world';
import type { BusPhysics } from '../vehicle/bus';

const MIN_SPEED = 35 / 3.6;
/** How far beyond the bus's side a solid counts as a close pass. */
const REACH = 1.4;
/** Hits closer than this are scrapes, not near misses. */
const SCRAPE = 0.12;
/** The same obstacle can't be counted again for this long. */
const COOLDOWN = 2;

/**
 * Casts short rays out of both sides of the bus; an obstacle within reach at speed is a
 * near miss. Rapier-only so it runs headless in tests.
 */
export class NearMissDetector {
  private recent = new Map<number, number>();
  private clock = 0;
  private offsets: number[];

  constructor(
    private world: RAPIER.World,
    private bus: BusPhysics,
  ) {
    const L = bus.preset.body.length;
    this.offsets = [L / 2 - 1, 0, -L / 2 + 1];
  }

  update(dt: number): number {
    this.clock += dt;
    if (Math.abs(this.bus.speed) < MIN_SPEED) return 0;
    const t = this.bus.body.translation();
    const q = this.bus.body.rotation();
    const halfW = this.bus.preset.body.width / 2;
    let count = 0;
    for (const side of [-1, 1]) {
      const dir = rotate(q, { x: 0, y: 0, z: side });
      for (const x of this.offsets) {
        const o = rotate(q, { x, y: 0, z: side * (halfW + 0.02) });
        const origin = { x: t.x + o.x, y: t.y + o.y, z: t.z + o.z };
        const hit = this.world.castRay(new RAPIER.Ray(origin, dir), REACH, true, undefined, undefined, undefined, this.bus.body);
        if (!hit || hit.timeOfImpact < SCRAPE) continue;
        if (origin.y + dir.y * hit.timeOfImpact < 0.5) continue; // the ground while leaning
        const last = this.recent.get(hit.collider.handle);
        if (last !== undefined && this.clock - last < COOLDOWN) continue;
        this.recent.set(hit.collider.handle, this.clock);
        count++;
      }
    }
    return count;
  }
}

type V3 = { x: number; y: number; z: number };

function rotate(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const cx = q.y * v.z - q.z * v.y;
  const cy = q.z * v.x - q.x * v.z;
  const cz = q.x * v.y - q.y * v.x;
  return {
    x: v.x + 2 * (q.w * cx + q.y * cz - q.z * cy),
    y: v.y + 2 * (q.w * cy + q.z * cx - q.x * cz),
    z: v.z + 2 * (q.w * cz + q.x * cy - q.y * cx),
  };
}
