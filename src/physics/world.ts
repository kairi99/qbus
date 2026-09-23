import RAPIER from '@dimforge/rapier3d-compat';

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

export { RAPIER };
