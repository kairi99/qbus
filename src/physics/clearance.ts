import { GROUP, RAPIER, groups } from './world';
import type { RoadPose } from '../world/roadSnap';

const STATIC_ONLY = groups(GROUP.ALL, GROUP.STATIC);
/** The box sits this far over the road (wheels and suspension under it). */
const LIFT = 0.35;
/** Contacts shallower than this are a straight box grazing a sag or crest of its own road. */
const GRAZE = 0.2;
/** Contact normals steeper than this are the road under the box, not a wall. */
const WALL_NY = 0.7;

/**
 * For the R reset (`snapToRoad`'s `clear`): whether a vehicle box of `size` at a pose, pitched to
 * the road, stands clear of the static world (walls, roofs, ground over the lane). Contacts from
 * below (the road itself) don't count.
 */
export function vehicleClearance(world: RAPIER.World, size: { length: number; width: number; height: number }): (pose: RoadPose) => boolean {
  const shape = new RAPIER.Cuboid(size.length / 2, size.height / 2, size.width / 2);
  const center = { x: 0, y: 0, z: 0 };
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  return (pose) => {
    const [cy, sy] = [Math.cos(pose.heading / 2), Math.sin(pose.heading / 2)];
    const [cp, sp] = [Math.cos(pose.pitch / 2), Math.sin(pose.pitch / 2)];
    Object.assign(rot, { x: sy * sp, y: sy * cp, z: cy * sp, w: cy * cp });
    Object.assign(center, { x: pose.pos.x, y: pose.y + LIFT + size.height / 2, z: pose.pos.z });
    let clear = true;
    world.intersectionsWithShape(
      center,
      rot,
      shape,
      (c) => {
        const k = c.contactShape(shape, center, rot, 0);
        if (k && -k.distance > GRAZE && Math.abs(k.normal1.y) < WALL_NY) clear = false;
        return clear;
      },
      undefined,
      STATIC_ONLY,
    );
    return clear;
  };
}
