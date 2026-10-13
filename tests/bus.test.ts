import { beforeAll, describe, expect, it } from 'vitest';
import { RAPIER, addGround, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { DriveInput } from '../src/core/input';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';
import interparroquial from '../data/buses/interparroquial.json';
import buseta from '../data/buses/buseta.json';
import ae86 from '../data/buses/ae86.json';
import articulado from '../data/buses/articulado.json';

const idle: DriveInput = { throttle: 0, steer: 0, handbrake: false };

describe.each([popular, interparroquial, buseta, ae86, articulado] as BusPreset[])('BusPhysics ($name)', (preset) => {
function setup() {
  const world = createWorld();
  // Big enough that the fastest vehicle can't drive off it during a test.
  addGround(world, 3000);
  const bus = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
  const run = (input: DriveInput, seconds: number) => {
    for (let t = 0; t < seconds; t += PHYSICS_STEP) {
      bus.update(input, PHYSICS_STEP);
      world.step();
    }
  };
  return { world, bus, run };
}

  beforeAll(() => initRapier());

  it('settles on its wheels', () => {
    const { bus, run } = setup();
    run(idle, 3);
    expect(bus.wheelsOnGround).toBe(bus.wheelCount);
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
        // An 18 m articulated bus mostly folds at the turntable instead of sliding.
        expect(maxSlip).toBeGreaterThan(preset.articulated ? 3 : 25);
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

  it('nitro gives a clear kick in 1.5 s, stays upright, and can pass top speed', () => {
    const plain = setup();
    const boosted = setup();
    for (const s of [plain, boosted]) {
      s.run(idle, 1);
      s.run({ ...idle, throttle: 1 }, 2);
    }
    plain.run({ ...idle, throttle: 1 }, 1.5);
    boosted.run({ ...idle, throttle: 1, boost: true }, 1.5);
    expect(boosted.bus.boosting).toBe(true);
    expect((boosted.bus.speed - plain.bus.speed) * 3.6).toBeGreaterThan(20);
    expect(boosted.bus.wheelsOnGround).toBeGreaterThanOrEqual(3);
    expect(Math.abs(boosted.bus.body.translation().z)).toBeLessThan(1);

    // Already flat out: nitro still pushes past top speed, but only up to the bonus.
    boosted.run({ ...idle, throttle: 1 }, 6);
    boosted.run({ ...idle, throttle: 1, boost: true }, 6);
    const kmh = boosted.bus.speed * 3.6;
    expect(kmh).toBeGreaterThan(preset.topSpeedKmh + 5);
    expect(kmh).toBeLessThanOrEqual(preset.topSpeedKmh + preset.nitro.topSpeedBonusKmh + 3);
  });

  it('reset puts the bus back upright at spawn', () => {
    const { bus, run } = setup();
    run({ ...idle, throttle: 1, steer: 1 }, 3);
    bus.reset({ x: 10, y: 0, z: 5, heading: Math.PI / 2 });
    expect(bus.body.translation().x).toBeCloseTo(10);
    expect(bus.heading).toBeCloseTo(Math.PI / 2);
  });
});

describe('articulated bus', () => {
  const preset = articulado as BusPreset;
  const art = preset.articulated!;
  const deg = (r: number) => (r * 180) / Math.PI;
  beforeAll(() => initRapier());

  function setup(walls?: (w: ReturnType<typeof createWorld>) => void) {
    const world = createWorld();
    addGround(world, 3000);
    walls?.(world);
    const bus = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
    const rear = bus.rear!;
    /** Distance between the two hinge anchors in the world. */
    const separation = () => {
      const anchor = (b: typeof bus.body, x: number) => {
        const t = b.translation();
        const q = b.rotation();
        return { x: t.x + x * (1 - 2 * (q.y * q.y + q.z * q.z)), y: t.y + x * 2 * (q.x * q.y + q.w * q.z), z: t.z + x * 2 * (q.x * q.z - q.w * q.y) };
      };
      const a = anchor(bus.body, -(bus.frontLength / 2 + art.gap / 2));
      const b = anchor(rear.body, art.rearLength / 2 + art.gap / 2);
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    };
    const run = (input: DriveInput, seconds: number, each?: () => void) => {
      for (let t = 0; t < seconds; t += PHYSICS_STEP) {
        bus.update(input, PHYSICS_STEP);
        world.step();
        each?.();
      }
    };
    return { world, bus, rear, run, separation };
  }

  it('is two bodies whose sections add up to the preset length', () => {
    const { bus } = setup();
    expect(bus.bodies).toHaveLength(2);
    expect(bus.colliders).toHaveLength(2);
    expect(bus.frontLength + art.gap + art.rearLength).toBeCloseTo(preset.body.length);
    expect(bus.wheelCount).toBe(6);
  });

  it('starts in line, settles on six wheels and drives straight', () => {
    const { bus, run } = setup();
    run(idle, 2);
    expect(bus.wheelsOnGround).toBe(6);
    run({ ...idle, throttle: 1 }, 6);
    expect(Math.abs(deg(bus.bend))).toBeLessThan(1);
    expect(Math.abs(bus.body.translation().z)).toBeLessThan(0.5);
    expect(bus.rear!.body.translation().x).toBeLessThan(bus.body.translation().x - preset.body.length / 2);
  });

  it('bends in a turn, with the tail cutting inside, and straightens out again', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 4);
    let max = 0;
    run({ throttle: 0.5, steer: -1, handbrake: false }, 4, () => (max = Math.max(max, Math.abs(bus.bend))));
    expect(deg(max)).toBeGreaterThan(8);
    expect(deg(max)).toBeLessThan(art.yawLimitDeg);
    run({ throttle: 0.5, steer: 0, handbrake: false }, 6);
    expect(Math.abs(deg(bus.bend))).toBeLessThan(3);
  });

  it('never jack-knifes: reversing on full lock stops at the yaw limit, upright, joint closed', () => {
    const { bus, run, separation } = setup();
    run(idle, 1);
    let maxBend = 0;
    let maxSep = 0;
    let minUp = 1;
    run({ ...idle, throttle: -1, steer: 1 }, 10, () => {
      maxBend = Math.max(maxBend, Math.abs(bus.bend));
      maxSep = Math.max(maxSep, separation());
      for (const b of bus.bodies) {
        const q = b.rotation();
        minUp = Math.min(minUp, 1 - 2 * (q.x * q.x + q.z * q.z));
      }
    });
    expect(deg(maxBend)).toBeLessThan(art.yawLimitDeg + 6);
    expect(maxSep).toBeLessThan(0.1);
    expect(minUp).toBeGreaterThan(0.9);
  });

  it('holds together through hard swerves at full speed', () => {
    const { bus, run, separation } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 10);
    let maxBend = 0;
    let maxSep = 0;
    let t = 0;
    for (let k = 0; k < 5 * 60; k++) {
      t += PHYSICS_STEP;
      run({ throttle: 1, steer: Math.sin(t * 5) > 0 ? 1 : -1, handbrake: false }, PHYSICS_STEP);
      maxBend = Math.max(maxBend, Math.abs(bus.bend));
      maxSep = Math.max(maxSep, separation());
    }
    expect(deg(maxBend)).toBeLessThan(art.yawLimitDeg + 6);
    expect(maxSep).toBeLessThan(0.1);
  });

  it('joint holds through a 25 m/s crash into a wall, and the tail stops at a wall behind', () => {
    const wall = (w: ReturnType<typeof createWorld>, x: number) => {
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 2, 0));
      w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 2, 20), b);
    };
    const crash = setup((w) => wall(w, 80));
    crash.run(idle, 1);
    for (const b of crash.bus.bodies) b.setLinvel({ x: 25, y: 0, z: 0 }, true);
    let maxSep = 0;
    crash.run({ ...idle, throttle: 1 }, 5, () => (maxSep = Math.max(maxSep, crash.separation())));
    expect(maxSep).toBeLessThan(0.1);
    expect(crash.bus.body.translation().x + crash.bus.frontLength / 2).toBeLessThan(79.6);
    for (const b of crash.bus.bodies) expect(Number.isFinite(b.translation().x + b.translation().y)).toBe(true);

    const back = setup((w) => wall(w, -14));
    back.run(idle, 1);
    back.run({ ...idle, throttle: -1 }, 6);
    expect(back.rear.body.translation().x - art.rearLength / 2).toBeGreaterThan(-13.5 - 0.15);
  });

  it('crosses speed humps and a ramp without leaving the road or flipping', () => {
    const { bus, run } = setup((w) => {
      for (const x of [50, 70]) {
        const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.04, 0));
        w.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 0.12, 6), b);
      }
    });
    run(idle, 1);
    let minUp = 1;
    let airborne = 0;
    run({ ...idle, throttle: 0.4 }, 12, () => {
      for (const b of bus.bodies) {
        const q = b.rotation();
        minUp = Math.min(minUp, 1 - 2 * (q.x * q.x + q.z * q.z));
      }
      if (bus.wheelsOnGround === 0) airborne += PHYSICS_STEP;
    });
    expect(bus.body.translation().x).toBeGreaterThan(90);
    expect(minUp).toBeGreaterThan(0.95);
    expect(airborne).toBe(0);
  });

  it('reset puts both sections upright and in line, centered on the spawn', () => {
    const { bus, run } = setup();
    run({ ...idle, throttle: 1, steer: 1 }, 4);
    bus.reset({ x: 10, y: 0, z: 5, heading: Math.PI / 2 });
    const c = bus.position();
    expect(c.x).toBeCloseTo(10, 1);
    expect(c.z).toBeCloseTo(5, 1);
    expect(bus.heading).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(bus.bend)).toBeLessThan(0.01);
    // Facing +Z... heading pi/2 points to -Z: the tail is toward +Z.
    expect(bus.rear!.body.translation().z).toBeGreaterThan(bus.body.translation().z + 8);
  });
});
