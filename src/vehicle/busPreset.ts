// Shape of a bus preset JSON in data/buses/. All driving feel lives here so it
// can be tuned without touching code.
export interface BusPreset {
  id: string;
  name: string;
  /** A car or a truck (free roam and races only) rather than a bus. Default: bus. */
  kind?: 'bus' | 'car' | 'truck';
  body: { length: number; width: number; height: number; color: string; stripe: string; roof: string };
  /**
   * An articulated bus: sections joined at turntables. `body.length` is the whole vehicle;
   * `mass`, `wheels` (front axle and the driven middle axle) and `cockpit` describe the front
   * section, which is `body.length - sections * (rearLength + gap)` long. Each rear section
   * carries one trailing, unsteered axle. Left out = one rigid body.
   */
  articulated?: {
    /** Rear sections in a row, each hinged to the one ahead (default 1; the gusanito's wagons). */
    sections?: number;
    /** Length of the rear section (m). */
    rearLength: number;
    /** Distance between the sections where the bellows and turntable are (m); the hitch is its middle. Negative: the sections overlap (a trailer's nose reaches over the tractor's tail). */
    gap: number;
    /** Rear axle position in rear-section coordinates (x, forward; negative = behind its center). */
    rearAxle: number;
    /** More trailing axles of each rear section (same coordinates): a semi-trailer's axle group. */
    rearAxles?: number[];
    /** Height of the rear sections' boxes (m; default `body.height`): a container trailer stands taller than its tractor. Their floors stay level. */
    rearHeight?: number;
    /** Where the hinge sits above the front section's center (m, default 0; the fifth wheel is low). */
    hingeY?: number;
    /** Mass of each rear section. */
    rearMass: number;
    /** Largest bend between the sections (degrees): past it the turntable pushes back. */
    yawLimitDeg: number;
    /** How hard the turntable pushes back past `yawLimitDeg` (default 600). */
    yawLimitStiffness?: number;
    /** Largest nod between the sections (degrees), for humps and ramps. */
    pitchLimitDeg: number;
    /** Chamfer under both ends of each section's box (m along the bus): approach and departure angles. */
    bevel?: number;
    /** Turntable stiffness while the handbrake is held (0/absent: stays free): the bus drifts as one body. */
    driftLock?: number;
    /** Yaw rate (rad/s) a handbrake turn is eased toward, the arcade push that opens a drift. */
    driftYawRate?: number;
    /** Turntable stiffness pulling the sections straight while backing up (absent: free). A train of trailers folds in reverse. */
    reverseLock?: number;
    /** Seconds the drift push looks ahead along the slip angle's growth (absent: 0). A heavy vehicle's slip lags the push and would overshoot the drift limit. */
    driftLead?: number;
    /** While the handbrake is held the front tires grip this many times the rear ones (absent: unchanged). */
    driftFrontGrip?: number;
  };
  /** Passengers that fit on board. */
  capacity: number;
  /**
   * What a race's AI driver plans with at its limit (hard skill): the lateral acceleration it
   * corners at and the braking (m/s²) this vehicle really manages, dry and on a soaked road,
   * measured on the track with `tools/sim-race.ts` (CORNER=, BRAKE=, WET=1). Absent: cautious defaults.
   */
  race?: { corner: number; brake: number; wetCorner: number; wetBrake: number };
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
    /** More driven axles behind `rearOffset` (x, same coordinates): a truck's tandem. */
    extraRear?: number[];
    sideFrictionStiffness: number;
    /** Rear tire grip while the handbrake is held. Low enough to exceed the grip limit and slide. */
    handbrakeFrictionSlip: number;
  };
  /**
   * Tire friction (`frictionSlip`) on a soaked road, front and rear axles (rear sections count as
   * rear): caps, eased in with how wet the road is. Dry friction is far over what a turn needs and
   * how low the cap must go to slide depends on the vehicle, so each preset is tuned (with
   * `tools/wet-grip.ts`) to slide a little at full lock. Left out: rain changes nothing but braking.
   */
  wet?: { front: number; rear: number };
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

/** A train of wagons (more than one rear section): the gusanito. */
export function isTrain(p: BusPreset): boolean {
  return (p.articulated?.sections ?? 1) > 1;
}

/** The wheel axles' x positions of section `section` (0 = front): the steered one first (front section). */
export function axleXs(p: BusPreset, section: number): number[] {
  if (section === 0) return [p.wheels.frontOffset, p.wheels.rearOffset, ...(p.wheels.extraRear ?? [])];
  const a = p.articulated!;
  return [a.rearAxle, ...(a.rearAxles ?? [])];
}

/** Height of section `section`'s box. */
export function sectionHeight(p: BusPreset, section: number): number {
  return section === 0 ? p.body.height : (p.articulated?.rearHeight ?? p.body.height);
}

/** How far a rear section's center stands above the front one's (m): their floors are level. */
export function rearLift(p: BusPreset): number {
  return (sectionHeight(p, 1) - p.body.height) / 2;
}

/** A tractor with a semi-trailer (the container truck): not a bus, with the dual tires and truck engine. */
export function isTruck(p: BusPreset): boolean {
  return p.kind === 'truck';
}
