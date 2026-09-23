// Shape of a bus preset JSON in data/buses/. All driving feel lives here so it
// can be tuned without touching code.
export interface BusPreset {
  id: string;
  name: string;
  body: { length: number; width: number; height: number; color: string; stripe: string; roof: string };
  mass: number;
  /** Height of the center of mass above the chassis center (m). Higher = more comic body roll. */
  centerOfMassHeight: number;
  engineForce: number;
  reverseForce: number;
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
  suspension: {
    restLength: number;
    maxTravel: number;
    stiffness: number;
    compression: number;
    relaxation: number;
    maxForce: number;
  };
}
