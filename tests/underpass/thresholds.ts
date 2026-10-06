/** Tunable thresholds for the underpass/bridge suites (see README.md). */

/** Drive-through (physics). */
export const DRIVE = {
  /** Vehicles and cruise speeds (km/h): a heavy bus slow and fast, the shortest bus, the car. */
  RUNS: [
    ['interparroquial', 35],
    ['interparroquial', 70],
    ['buseta', 60],
    ['ae86', 90],
  ] as const,
  /** Extra seconds over length / (cruise / 2). */
  SLACK_S: 10,
  /** Longest time below 1 m/s after pulling away. */
  STUCK_S: 3,
  /** Longest time with no wheel on anything. */
  AIRBORNE_S: 0.3,
  /** Biggest sideways shove from anything solid, as a speed change (impulse / mass, m/s). */
  WALL_DV: 1.0,
  /** Chassis height over the road profile vs its ride height at the start (m). */
  RISE_M: 0.6,
  SINK_M: 0.5,
  /** The autopilot keeps this close to its lane (more means it was knocked off it). */
  OFF_PATH_M: 3.5,
};

/** Traffic (sim + trafficBodies). */
export const TRAFFIC = {
  CARS: 40,
  SECONDS: 60,
  SEEDS: [1, 2, 3],
  /** A car slower than 0.3 m/s on a lifted edge longer than this is stuck in the structure. */
  STUCK_S: 20,
  /** Body bottom vs the physical road under it (raycast), for driving cars on the structure (m). */
  HEIGHT_TOL: 0.35,
  /** Cars knocked off their lane by the road itself (driving → free), whole run. */
  RELEASED_MAX: 1,
  /** Pairs of driving cars at the same level overlapping (boxes, sampled once a second). */
  OVERLAPS_MAX: 0,
};

/** Navigation. */
export const NAV = {
  /** Sampling step along a passage's lifted edges (m). */
  STEP: 8,
  /** `locate` must pick an edge whose surface is this close to the height asked (m). */
  LEVEL_TOL: 1.5,
  /** Consecutive route edges must meet within this height (m). */
  JOINT_TOL: 1.0,
  /** `snapToRoad` height vs the level the bus was on (m). */
  SNAP_TOL: 1.5,
  /** Bus box placed at a snap pose, lifted this much, must not touch anything solid (m). */
  SNAP_LIFT: 0.35,
  /**
   * ...and walls may cut into that box at most this deep (a straight box over a sag or crest
   * grazes the ramp's own ground by a few centimeters: not a wall).
   */
  SNAP_DEPTH: 0.25,
};

/** Geometry/colliders. */
export const GEOMETRY = {
  /** Sampling step along lanes (m). */
  STEP: 1,
  /** Swept bus volume: widest/tallest bus, from this high over the road (suspension) up. */
  BUS_WIDTH: 2.55,
  BUS_HEIGHT: 3.3,
  BUS_CLEAR: 0.3,
  /** Step in the physical road surface between samples 0.5 m apart, beyond the grade (m). */
  LIP_M: 0.06,
  /** Physical road vs the graph's edge height (m). */
  SURFACE_TOL: 0.25,
  /** Terrain heightfield allowed above the asphalt inside a cut (m). */
  HEIGHTFIELD_ABOVE: 0.02,
  /** Drawn vs solid: a side ray hitting one but not the other within this (m). */
  PARITY_TOL: 0.4,
  /** Side rays reach this far from the lane (m). */
  SIDE_REACH: 10,
};

/** Rendering (Playwright). */
export const RENDER = {
  /** Viewpoints along each passage, this far apart (m). */
  STEP: 18,
  /** Magenta pixels (nothing drawn) below the horizon that count as a hole. */
  HOLE_PX: 20,
};
