/** Physics queries shared by the underpass suites. */
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { GROUP, RAPIER, groups } from '../../src/physics/world';
import type { Vec2 } from '../../src/world/cityData';

const STATIC_ONLY = groups(GROUP.ALL, GROUP.STATIC);

/** Rotation: yaw `h` about +Y, then pitch about the box's own +Z (nose up), then roll about +X. */
export function yawPitchRoll(h: number, pitch = 0, roll = 0) {
  const [cy, sy] = [Math.cos(h / 2), Math.sin(h / 2)];
  const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)];
  const [cr, sr] = [Math.cos(roll / 2), Math.sin(roll / 2)];
  // q = qYaw * qPitch * qRoll
  const a = { x: sy * sp, y: sy * cp, z: cy * sp, w: cy * cp };
  return { x: a.w * sr + a.x * cr, y: a.y * cr + a.z * sr, z: a.z * cr - a.y * sr, w: a.w * cr - a.x * sr };
}

export interface Intrusion {
  shape: number;
  depth: number;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

/**
 * Static colliders penetrating a box (half extents `half`) at `center`/`rot` deeper than
 * `minDepth`, keeping only wall-like contacts (|normal.y| < `maxNy`: not the road under it).
 */
export function intrusions(world: RAPIER_T.World, center: { x: number; y: number; z: number }, rot: RAPIER_T.Rotation, half: { x: number; y: number; z: number }, minDepth = 0.05, maxNy = 0.7): Intrusion[] {
  const shape = new RAPIER.Cuboid(half.x, half.y, half.z);
  const out: Intrusion[] = [];
  world.intersectionsWithShape(
    center,
    rot,
    shape,
    (c) => {
      const k = c.contactShape(shape, center, rot, 0);
      if (k && -k.distance > minDepth && Math.abs(k.normal1.y) < maxNy)
        out.push({ shape: c.shapeType(), depth: -k.distance, point: { ...k.point1 }, normal: { ...k.normal1 } });
      return true;
    },
    undefined,
    STATIC_ONLY,
  );
  return out;
}

/** Height of the first static surface straight down from (p, top), or null. */
export function surfaceBelow(world: RAPIER_T.World, p: Vec2, top: number, reach = 6, filter?: (c: RAPIER_T.Collider) => boolean): number | null {
  const hit = world.castRay(new RAPIER.Ray({ x: p.x, y: top, z: p.z }, { x: 0, y: -1, z: 0 }), reach, true, undefined, STATIC_ONLY, undefined, undefined, filter);
  return hit ? top - hit.timeOfImpact : null;
}

/** Distance to the first static hit along a horizontal ray, or null. */
export function rayDistance(world: RAPIER_T.World, from: { x: number; y: number; z: number }, dir: Vec2, reach: number): { d: number; shape: number } | null {
  const hit = world.castRay(new RAPIER.Ray(from, { x: dir.x, y: 0, z: dir.z }), reach, false, undefined, STATIC_ONLY);
  return hit ? { d: hit.timeOfImpact, shape: hit.collider.shapeType() } : null;
}

export const fmt = (p: { x: number; z: number; y?: number }) => `(${p.x.toFixed(1)}, ${p.z.toFixed(1)}${p.y !== undefined ? `, y ${p.y.toFixed(2)}` : ''})`;
