import { beforeAll, describe, expect, it } from 'vitest';
import { addGround, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { DriveInput } from '../src/core/input';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';

const preset = popular as BusPreset;
const idle: DriveInput = { throttle: 0, steer: 0, handbrake: false };

function setup() {
  const world = createWorld();
  addGround(world);
  const bus = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
  const run = (input: DriveInput, seconds: number) => {
    for (let t = 0; t < seconds; t += PHYSICS_STEP) {
      bus.update(input, PHYSICS_STEP);
      world.step();
    }
  };
  return { world, bus, run };
}

describe('BusPhysics', () => {
  beforeAll(() => initRapier());

  it('settles on its wheels', () => {
    const { bus, run } = setup();
    run(idle, 3);
    expect(bus.wheelsOnGround).toBe(4);
    const y = bus.body.translation().y;
    expect(y).toBeGreaterThan(preset.body.height / 2);
    expect(y).toBeLessThan(preset.body.height / 2 + 1.2);
  });

  it('accelerates forward along +X to a brisk arcade speed', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 5);
    const kmh = bus.speed * 3.6;
    expect(kmh).toBeGreaterThan(45);
    expect(kmh).toBeLessThanOrEqual(preset.topSpeedKmh + 5);
    expect(bus.body.translation().x).toBeGreaterThan(20);
  });

  it('turns left when steering left', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 2);
    run({ ...idle, throttle: 0.6, steer: -1 }, 1.5);
    expect(bus.heading).toBeGreaterThan(0.3);
  });

  it('brakes to a stop quickly (then holding brake reverses)', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 4);
    let t = 0;
    while (bus.speed > 1 && t < 10) {
      run({ ...idle, throttle: -1 }, PHYSICS_STEP);
      t += PHYSICS_STEP;
    }
    expect(t).toBeLessThan(3);
    run({ ...idle, throttle: -1 }, 2);
    expect(bus.speed).toBeLessThan(-1);
  });

  it('stays upright through a hard turn at speed', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 4);
    run({ ...idle, throttle: 1, steer: 1 }, 3);
    const q = bus.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    expect(upY).toBeGreaterThan(0.5);
  });

  describe('handbrake drift', () => {
    /** Angle between where the bus points and where it moves, degrees. */
    const slipDeg = (bus: BusPhysics) => {
      const v = bus.body.linvel();
      const h = bus.heading;
      const fwd = v.x * Math.cos(h) - v.z * Math.sin(h);
      const side = v.x * Math.sin(h) + v.z * Math.cos(h);
      return (Math.atan2(Math.abs(side), Math.abs(fwd)) * 180) / Math.PI;
    };
    const driftFrom60 = (throttle: number) => {
      const { bus, run } = setup();
      run(idle, 1);
      run({ ...idle, throttle: 1 }, 4);
      let maxSlip = 0;
      for (let t = 0; t < 1.5; t += PHYSICS_STEP) {
        run({ throttle, steer: 1, handbrake: true }, PHYSICS_STEP);
        maxSlip = Math.max(maxSlip, slipDeg(bus));
      }
      return { bus, run, maxSlip };
    };

    it('a normal hard turn barely slides', () => {
      const { bus, run } = setup();
      run(idle, 1);
      run({ ...idle, throttle: 1 }, 4);
      let maxSlip = 0;
      for (let t = 0; t < 1.5; t += PHYSICS_STEP) {
        run({ throttle: 0.5, steer: 1, handbrake: false }, PHYSICS_STEP);
        maxSlip = Math.max(maxSlip, slipDeg(bus));
      }
      expect(maxSlip).toBeLessThan(12);
    });

    for (const throttle of [0, 1]) {
      it(`kicks the tail out to a visible drift without spinning (throttle ${throttle})`, () => {
        const { bus, maxSlip } = driftFrom60(throttle);
        expect(maxSlip).toBeGreaterThan(25);
        expect(maxSlip).toBeLessThan(55);
        expect(bus.speed).toBeGreaterThan(3); // still rolling forward, not spun around
      });
    }

    it('regains grip after the handbrake is released', () => {
      const { bus, run } = driftFrom60(1);
      run({ throttle: 1, steer: 0, handbrake: false }, 2);
      expect(slipDeg(bus)).toBeLessThan(8);
      expect(bus.speed).toBeGreaterThan(5);
    });
  });

  it('reverses at a useful speed', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: -1 }, 4);
    expect(bus.speed * 3.6).toBeLessThan(-25);
    expect(bus.speed * 3.6).toBeGreaterThan(-(preset.reverseTopSpeedKmh + 5));
  });

  it('reset puts the bus back upright at spawn', () => {
    const { bus, run } = setup();
    run({ ...idle, throttle: 1, steer: 1 }, 3);
    bus.reset({ x: 10, y: 0, z: 5, heading: Math.PI / 2 });
    expect(bus.body.translation().x).toBeCloseTo(10);
    expect(bus.heading).toBeCloseTo(Math.PI / 2);
  });
});
