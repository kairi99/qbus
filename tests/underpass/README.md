# Underpass and bridge harness

Automated checks for every grade-separated structure in a city (La Mariscal), so fixes can be
proven and regressions caught. Nothing is hardcoded: `catalog.ts` finds the structures from the
data and the suites iterate over them.

## Running

| What | Command | Time |
|---|---|---|
| Catalog + navigation (also in `npm test`) | `npx vitest run tests/underpass/navigation.test.ts` | ~8 s |
| Everything below (physics, slow) | `npm run test:underpass` | ~1 min |
| One slow suite | `npx vitest run --config vitest.underpass.config.ts tests/underpass/drive.slow.test.ts` | drive ~25 s, geometry ~10 s, traffic ~20 s |
| Rendering (Playwright) | `QBUS_PORT=5183 npx playwright test underpasses` | ~2 min |
| See known failures fail | `QBUS_STRICT=1 npm run test:underpass` | |

`*.slow.test.ts` files are left out of `npm test` (`exclude` in `vite.config.ts`);
`vitest.underpass.config.ts` runs all of `tests/underpass/`. Filter with `-t "<part of a name>"`.

## Catalog (`catalog.ts`)

- **Structure**: roads lifted the same way (cut: lift < 0, bridge: lift > 0) clustered by where
  their deep/high parts are (25 m) or by joining end to end; kept if it reaches 2 m somewhere.
  Id: `cut Av. 12 de Octubre @(-42,734)` (kind, name of its deepest/highest named road, center).
- **Passage**: one legal way through it, from the drivable lane graph: a chain of lifted drivable
  edges in travel order, with a straight approach (70 m) and exit (60 m) at street level. Id:
  `<structure>: <road names> [e<first edge>→e<last edge>]`. `startS` keeps the start 22 m inside
  the play area (passages that run off the map start down in their cut).
- La Mariscal today: 8 structures (the "Paso elevado avenida 10 de Agosto" bridge is outside the
  play area: no drivable passage), 13 passages.

## Suites and thresholds (`thresholds.ts`)

**Drive-through** (`drive.slow.test.ts`, `drive.ts`): the real `BusPhysics`, a simple autopilot
(aims 8 m or 0.8 s ahead on the curb lane, slows for bends at 3.5 m/s² and for the route's end)
per passage × {interparroquial @ 35 and 70 km/h, buseta @ 60, AE86 @ 90}. Fails if: it doesn't
reach the end within length / (cruise/2) + 10 s; it's under 1 m/s for > 3 s; no wheel touches for
> 0.3 s; anything shoves the body sideways by more than Δv 1 m/s (impulse/mass); the chassis rises
> 0.6 m or sinks > 0.5 m relative to the road profile (vs its settled ride height); it falls
through the road; the autopilot gets knocked > 3.5 m off its lane. The message has all numbers and
where each happened.

**Traffic** (`traffic.slow.test.ts`): `TrafficSim` + `TrafficBodies` around each structure (40
cars, seeds 1 and 2, 40 s each, the bus parked far away, cars recycled around the structure).
Per passage, cars must drive off its deepest edge at least once; per structure, no car under
0.3 m/s on a lifted edge for > 20 s; a driving car's body bottom within 0.35 m of the physical
road under it (raycast); no overlapping driving cars at the same level; at most 1 car knocked off
its lane by the road. Cars queued at a map exit (they wait until unseen, by design) don't count.

**Navigation** (`navigation.test.ts`, in `npm test`): catalog sanity (known structures found;
every drivable lifted edge in the play area is in a passage); each passage's joints legal
(`a.to === b.from`) and level (≤ 1 m); `Navigator.route` through a passage follows exactly its
edges; every 8 m on the deep part, `Navigator.locate(p, heading, y)` picks an edge within 1.5 m
of the height asked, both in the structure and on the road crossing over/under it; `snapToRoad`
(R reset) there keeps the level (≤ 1.5 m) and puts the interparroquial clear of walls (box lifted
0.35 m, pitched to the road; walls may graze ≤ 0.25 m).

**Geometry** (`geometry.slow.test.ts`): on the passage edges plus 25 m of approach and exit:
- *Swept bus volume*: every lane, every 1 m, a 1 m slice of a 2.55 × 3.3 m bus 0.3 m above the
  road, pitched to it; any static collider cutting > 5 cm into it with a wall-like normal is listed
  (runs of hits merged).
- *Road surface*: every lane, every 0.5 m, raycast down: nothing there is a hole; > 0.25 m off the
  graph's `edgeY` is a mismatch; along the curb lane's path straight through (junctions included)
  a second difference > 6 cm over 0.5 m is a lip.
- *Drawn vs solid*: from lanes 0 and last, every 2 m, at 0.6 and 2 m up, rays left/right (10 m)
  against physics and against the drawn scene (`meshes.ts`: everything but ground overlays and
  LOD decoration); one hitting > 0.4 m before the other is listed. Small solids (cylinders,
  cones, cuboids: trunks, poles, bollards, the invisible map-edge wall) are skipped.
- *Heightfield under the asphalt* (cuts): across each lowered road (lift ≤ -1.2), the terrain
  heightfield collider may not stand > 2 cm above the road.

**Rendering** (`e2e/underpasses.spec.ts`): every 18 m along each passage's lifted part, and at its
extreme point: the driver's seat (ahead, left, right) and the chase camera, placed as `CameraRig`
does for the "popular" bus; > 20 magenta (nothing drawn) pixels in the lower 45% is a hole.
Writes `e2e/screenshots/underpasses/<passage>-seat.png` / `-chase.png` at each passage's extreme
point, and `hole-<view>.png` for every view with a hole. The older `underpassHoles.spec.ts`
(looking around at 1.6 m along every lowered road) still runs too.

## Known failures

Tests that fail today because of real bugs are marked in `known.ts` style lists inside each suite
(`known({...})`, keyed by exact test name) and run as `it.fails`, so `npm test` stays green while
the harness still reports them. When a fix makes one pass, its `it.fails` turns red: delete the
entry. Never add an entry for a test a change just broke (a regression). `QBUS_STRICT=1` runs them
as plain tests to see the messages. The rendering spec has its own `KNOWN_HOLES`.

First run (2026-10-06, `DEFAULT_HILLS`), 51 known failures:

- **Drive-through (23)**: Puente del Guambra northbound up-ramp: every vehicle sinks 0.66–0.82 m
  at about (-705, 220) and the AE86 stops dead there; Guambra southbound: shove at (-692.6, 213.1),
  AE86 stuck at (-620.5, 313.6); 10 de Agosto cut: AE86 hits a wall at (-195.4, -791.3), and on
  e564 the bus starts wedged at (-195.5, -832.7) (ground stands on lane 0); 12 de Octubre →
  Queseras link: wall at (-57.2, 713.5), ~1 m bump at (-68.3, 724.7), wall at (-126.0, 775.3);
  12 de Octubre → Patria link: the interparroquial jams at (-21.9, 750.8); main cut S→N: AE86
  stuck at (0.2, 713.0); cut by the Guambra (e197→e199): interparroquial high-centers at
  (-660, 323.7); cut at (-820, 774): wall at (-818.4, 768.0); west-edge cut (e516): bus spawns
  rubbing a wall at (-854.2, -272.7). (Map-edge passages e564/e516 start down in the cut, so part
  of those may be how the harness places the bus; the geometry suite confirms walls/ground on the
  lanes there.)
- **Navigation (3)**: Queseras link e524 ends 1.15 m below e277 at node 257; R reset in the
  10 de Agosto cut at (-176.7, -834.5) puts the bus 0.25 m into the ground; R reset at
  (-820.6, 767.7) puts it 1.6 m into a wall.
- **Geometry (22)**: walls or ground in the swept bus volume on 9 passages (worst: e564 lane 0,
  0.99 m deep at (-195.9, -836.0); Patria e970 lane 1, 0.46 m at (-30.9, 711.0)); lips up to
  0.49 m on the Guambra deck joint at (-634, 325) and 0.35 m at (-57.2, 756.9), surface/graph
  mismatches up to 0.92 m (e970 at (-30.0, 710.6)) on 11 passages; drawn-but-not-solid faces
  beside the Guambra up-ramp (6.2 m left of lane 0 from (-696.6, 233.7)) and in the cut by the
  Guambra at (-592, 340).
- **Traffic (3)**: cars float 0.4 m on e564 at (-211.3, -785.2) and sink 0.4 m on e589 at
  (-115, 777) (the same surface mismatches the geometry suite finds); a car stuck > 20 s on the
  Queseras link e349 at (-25.8, 710.4).
- **Rendering (3 views)**: a slit to the sky in the side of the main 12 de Octubre cut at about
  (-28, 730), seen S→N ahead/right and N→S looking left.

Each entry in the suites carries the exact numbers observed.
