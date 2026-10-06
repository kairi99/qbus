import { RAPIER } from './world';

/**
 * Ray casts against the static world for the chase camera (`CameraRig.obstacles`): ground,
 * terrain patches, walls, roofs, decks and buildings. Small solids (trunks, poles, pillars,
 * bollards, props: cylinders, cones, boxes) are ignored so passing one doesn't make the camera
 * jump in, and so is the invisible wall at the map edge (a box). One ray reused, no allocations
 * besides Rapier's own hit.
 */
export function staticObstacles(world: RAPIER.World) {
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const skip = new Set([RAPIER.ShapeType.Cylinder, RAPIER.ShapeType.Cone, RAPIER.ShapeType.Cuboid, RAPIER.ShapeType.Ball, RAPIER.ShapeType.Capsule]);
  const solid = (c: RAPIER.Collider) => !skip.has(c.shapeType());
  const flags = RAPIER.QueryFilterFlags.ONLY_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  return {
    cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
      ray.origin.x = ox;
      ray.origin.y = oy;
      ray.origin.z = oz;
      ray.dir.x = dx;
      ray.dir.y = dy;
      ray.dir.z = dz;
      const hit = world.castRay(ray, max, true, flags, undefined, undefined, undefined, solid);
      return hit ? hit.timeOfImpact : max;
    },
  };
}
