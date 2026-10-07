import { RAPIER } from './world';

/**
 * Ray casts against the static world for the chase camera (`CameraRig.obstacles`): ground,
 * terrain patches, walls, roofs, decks and buildings. Small solids (trunks, poles, pillars,
 * bollards, props: cylinders, cones, boxes) are ignored so passing one doesn't make the camera
 * jump in, and so is the invisible wall at the map edge (a box). The ray and ball are reused: no
 * allocations besides Rapier's own hit.
 */
export function staticObstacles(world: RAPIER.World) {
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const skip = new Set([RAPIER.ShapeType.Cylinder, RAPIER.ShapeType.Cone, RAPIER.ShapeType.Cuboid, RAPIER.ShapeType.Ball, RAPIER.ShapeType.Capsule]);
  const solid = (c: RAPIER.Collider) => !skip.has(c.shapeType());
  const flags = RAPIER.QueryFilterFlags.ONLY_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  const balls = new Map<number, RAPIER.Ball>();
  const pos = { x: 0, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: 0 };
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  return {
    cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, radius = 0): number {
      if (radius > 0) {
        // A ball swept along the ray: it stops `radius` short of anything (a roof just over the
        // line, not only one across it). Starting inside something and leaving it isn't a hit.
        let ball = balls.get(radius);
        if (!ball) balls.set(radius, (ball = new RAPIER.Ball(radius)));
        pos.x = ox;
        pos.y = oy;
        pos.z = oz;
        vel.x = dx;
        vel.y = dy;
        vel.z = dz;
        const hit = world.castShape(pos, rot, vel, ball, 0, max, false, flags, undefined, undefined, undefined, solid);
        return hit ? hit.time_of_impact : max;
      }
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
