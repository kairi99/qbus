import RAPIER from '@dimforge/rapier3d-compat';
import type { Terrain } from '../world/terrain';

export const PHYSICS_STEP = 1 / 60;
// Slightly stronger than real gravity: arcade games feel floaty at 9.81.
export const GRAVITY = -16;

let ready: Promise<void> | null = null;

/** Loads the Rapier WASM module once. Safe to call repeatedly. */
export function initRapier(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export function createWorld(): RAPIER.World {
  return new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
}

export function addGround(world: RAPIER.World, halfSize = 500): void {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(halfSize, 0.5, halfSize).setFriction(1), body);
}

/**
 * Static heightfield matching terrainHeight() (heights are scaled by `t.scale`). Vertices in
 * `sink.pit` are dropped to `sink.pitY`, out of the way of an underpass: other colliders (see
 * gradeBuilder.ts) stand in for the ground there.
 */
export function addTerrainCollider(world: RAPIER.World, t: Terrain, sink?: { pit: Set<number>; pitY: number }): RAPIER.Collider {
  // Rapier wants a column-major matrix with rows along z and columns along x, given as
  // subdivision counts, centered on the collider's position.
  const nrows = t.rows - 1;
  const ncols = t.cols - 1;
  const heights = new Float32Array(t.rows * t.cols);
  for (let c = 0; c < t.cols; c++)
    for (let r = 0; r < t.rows; r++) heights[c * t.rows + r] = sink?.pit.has(r * t.cols + c) ? sink.pitY / t.scale : t.heights[r * t.cols + c];
  const w = ncols * t.cell;
  const d = nrows * t.cell;
  const desc = RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, { x: w, y: t.scale, z: d })
    .setTranslation(t.minX + w / 2, 0, t.minZ + d / 2)
    .setFriction(1);
  return world.createCollider(desc);
}

/**
 * Collision groups (membership << 16 | filter). The static world only belongs to STATIC, so
 * traffic in its lane (TRAFFIC, filtering out STATIC) never touches it; everything else keeps
 * the default "all groups" and collides with everything.
 */
export const GROUP = { STATIC: 0x0001, TRAFFIC: 0x0002, ALL: 0xffff };
export const groups = (member: number, filter: number) => (member << 16) | filter;

/** Puts every collider on a fixed body (or on none) in the STATIC group. Call once the city is built. */
export function markStatic(world: RAPIER.World): void {
  world.forEachCollider((c) => {
    const body = c.parent();
    if (!body || body.isFixed()) c.setCollisionGroups(groups(GROUP.STATIC, GROUP.ALL));
  });
}

export { RAPIER };
