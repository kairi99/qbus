// Shape of a bus preset JSON in data/buses/. All driving feel lives here so it
// can be tuned without touching code.
export interface BusPreset {
  id: string;
  name: string;
  /** A car (free roam only) rather than a bus. Default: bus. */
  kind?: 'bus' | 'car';
  body: { length: number; width: number; height: number; color: string; stripe: string; roof: string };
  /** Passengers that fit on board. */
  capacity: number;
  mass: number;
  /** Height of the center of mass above the chassis center (m). Higher = more comic body roll. */
  centerOfMassHeight: number;
  engineForce: number;
  reverseForce: number;
  reverseTopSpeedKmh: number;
  brakeForce: number;
  handbrakeForce: number;
  topSpeedKmh: number;
  steer: { maxAngle: number; highSpeedAngle: number; speed: number };
  wheels: {
    radius: number;
    frontOffset: number;
    rearOffset: number;
    track: number;
    mountHeight: number;
    frictionSlip: number;
    sideFrictionStiffness: number;
    /** Rear tire grip while the handbrake is held. Low enough to exceed the grip limit and slide. */
    handbrakeFrictionSlip: number;
  };
  drift: {
    /** Slide angle beyond which yaw is damped so a drift holds instead of spinning out. */
    maxAngleDeg: number;
    /** How fast rear grip returns after releasing the handbrake, in frictionSlip units per second. */
    gripRecovery: number;
  };
  /** Driver's eye position in chassis space (default: front-left, where a bus driver sits). */
  cockpit?: { seat: [number, number, number] };
  nitro: {
    /** Extra forward acceleration while boosting, m/s² (on top of the engine). */
    accel: number;
    /** How far past its top speed nitro can push the bus. */
    topSpeedBonusKmh: number;
  };
  suspension: {
    restLength: number;
    maxTravel: number;
    stiffness: number;
    compression: number;
    relaxation: number;
    maxForce: number;
  };
}
