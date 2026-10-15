import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { BusModel } from '../src/vehicle/busModel';
import type { BusPhysics } from '../src/vehicle/bus';
import { busById } from '../src/vehicle/buses';

/** Where the top of the steering wheel ends up (world z: + is right) with the front wheels at `steer` rad. */
function wheelTopZ(id: string, steer: number): number {
  const preset = busById(id);
  const model = new BusModel(preset);
  const body = { translation: () => ({ x: 0, y: 0, z: 0 }), rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }) };
  const vehicle = { wheelSuspensionLength: () => 0, wheelSteering: () => steer, wheelRotation: () => 0 };
  const bus = { preset, body, vehicle, rear: preset.articulated ? { body, vehicle } : null, boosting: false } as unknown as BusPhysics;
  model.sync(bus);
  const wheel = (model as unknown as { steeringWheel: THREE.Object3D }).steeringWheel;
  model.root.updateMatrixWorld(true);
  return wheel.localToWorld(new THREE.Vector3(0, 0.2, 0)).z - wheel.localToWorld(new THREE.Vector3(0, 0, 0)).z;
}

describe('steering wheel', () => {
  // Buses draw their destination sign on a canvas: a do-nothing one is enough here.
  beforeAll(() => {
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });
  });
  // Positive wheel steering turns the vehicle left (toward -z); seen from the seat the steering
  // wheel then turns counterclockwise, its top moving left.
  for (const id of ['popular', 'articulado', 'ae86'])
    it(`${id}: turns counterclockwise to steer left`, () => {
      expect(wheelTopZ(id, 0.3)).toBeLessThan(-0.05);
      expect(wheelTopZ(id, -0.3)).toBeGreaterThan(0.05);
    });
});
