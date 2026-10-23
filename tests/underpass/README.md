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
  (-820.6, 767.7) puts it 1.6 m into a wall. (Both resets fixed: the R reset test now calls
  `snapToRoad` as the game does, with `vehicleClearance`.)
- **Geometry (22)**: walls or ground in the swept bus volume on 9 passages (worst: e564 lane 0,
  0.99 m deep at (-195.9, -836.0); Patria e970 lane 1, 0.46 m at (-30.9, 711.0)); lips up to
  0.49 m on the Guambra deck joint at (-634, 325) and 0.35 m at (-57.2, 756.9), surface/graph
  mismatches up to 0.92 m (e970 at (-30.0, 710.6)) on 11 passages; drawn-but-not-solid faces
  beside the Guambra up-ramp (6.2 m left of lane 0 from (-696.6, 233.7)) and in the cut by the
  Guambra at (-592, 340).
- **Traffic (3)**: cars float 0.4 m on e564 at (-211.3, -785.2) and sink 0.4 m on e589 at
  (-115, 777) (the same surface mismatches the geometry suite finds); a car stuck > 20 s on the
  Queseras link e349 at (-25.8, 710.4). (All fixed: traffic rides the solid road, and obstacles
  on another level no longer hold cars up.)
- **Rendering (3 views)**: a slit to the sky in the side of the main 12 de Octubre cut at about
  (-28, 730), seen S→N ahead/right and N→S looking left. Fixed (Rendering agent): `KNOWN_HOLES` is empty.

After the Collision/Physics, Rendering and AI/Nav fixes (2026-10-07): 27 known failures left
(10 drive-throughs: Queseras link at node 257, the S→N link's top bend, the El Ejido tunnel kink,
the AE86 on the Guambra deck overlap and in the 10 de Agosto cut; 16 geometry: mostly small lips
and graph/surface mismatches, two swept-volume hits on the Patria bridge ramps, drawn-vs-solid by
the Guambra; 1 navigation: the e524/e277 step). Rebuilding the city can move a structure's
center by a meter, which renames its tests (`@(-42,734)` became `@(-43,733)`): rename the entries.

The AE86 rides higher since 2026-10-15 (suspension rest length 0.3 → 0.45 m, travel 0.2 → 0.35,
close to the buses' ground clearance): it now gets through the 10 de Agosto cut and no longer
stops under the Guambra deck overlap; what's left there is a railing graze on the Patria bridge at
(-658.3, 279.8) at 89 km/h, and the 12 de Octubre wall it shares with the buseta.

Streets alongside cuts and ramp mouths (2026-10-15, see `src/world/CLAUDE.md`): the 12 de Octubre
N→S link onto Queseras (Q1) now gets every vehicle through (the junction dips to meet the link;
its 1 m step at node 257 is gone), the street beside the main cut no longer hangs over it, and the
El Ejido kink (S2) is a knock, not a stall. Left: the interparroquial still knocks the ground beside
the link's last meter of cut once, at 35 and 70 km/h. Moving streets renumbers the graph's edges
and can move a structure's center by a meter: rename the entries (map old to new by catalog
order). The traffic suite's dice move with them (seed-dependent
stalls and overlaps at the cut sin nombre @(-876,-220), 10 de Agosto and 12 de Octubre show and
vanish as the road layout moves them).

2026-10-23: the (-876,-220) cut is fixed for good (seeds 1-20 clean): its two incoming edges (e524, 3
lanes, e745, 1 lane) are drawn over the same road for their last 60 m and merge into one exit, so
cars from both sat in each other's path. `traffic.ts` now keeps the standoff winner on record (the
blocker flickered, so it crept), lets it ignore only the safety margin, widens the berth to a car
merging alongside from another edge (`MERGE_BERTH`, corner skew), gives up a junction claim against
a car stopped in the way (`YIELD_AFTER`), and keeps lane changes off lanes another edge's car sits
over. Still dice-dependent elsewhere: 10 de Agosto overlap (seed 6), 12 de Octubre stuck (seed 6).

2026-10-18: the S→N link to Patria (Q2) passes: Ladrón de Guevara, a street crossing over the main
12 de Octubre cut by Patria, was never pushed aside (the whole street counted as "on the roof"),
and the link's top bend needs the cut's bend allowance; both are in `clearCuts` now. Two traffic
deadlocks it exposed are fixed in `traffic.ts` (a car claiming a junction ahead of the car it queues
behind; a short exit's feeders starved by the stream through the junction after it). The
articulado's graze in the cut at (-652, 321) (Δv 1.08–1.18 against 1.0) passes in the suite's order
and fails run alone: no longer listed. Traffic dice moved again: a car floating on the Guambra
up-ramp (seed 1, unchanged geometry) is listed, and (-876,-220)'s stuck/overlap entries trade places.

The harness measures a car's height against a junction at street level as the ground under it
(`surfaceAlong`), and a route joint where both edges are on the ground at a street-level node
isn't a step (a big junction's paving slopes with the ground).

Each entry in the suites carries the exact numbers observed.

2026-10-23 (strict run: 23 failures; 16 left, all in `known` lists, with the edge ids moved up by 9 by the busway change):
- Fixed: the Patria bridge railing was one convex hull per 2 m section, and on a bend their square ends were teeth a car at
  speed caught (the AE86 @ 90 km/h at (-658.3, 279.8), Δv 15 m/s): each side's railing is now one smooth frictionless
  trimesh (`railSolid`, as on the mountain tracks), which also closes the Guambra up-ramp's drawn-but-not-solid rail
  (e167 lanes 0/1) and the two swept-volume hull hits at (-588, 346) / (-587.5, 339). The Queseras link (Q1, wall at
  (-57.4, 713.6)): the wall's 1 m parapet stood on ground only 0.25 m above the floor, its blunt end in the way where the ramp
  tops out; the parapet now grows with the cut's depth (`SHALLOW`).
- Harness fixes, not looser thresholds: (1) the surface check compares each lane with where it should be (`surfaceY`
  of the center height, or the ground at the lane itself on street level), not the center's height: on a slope the road
  follows the ground across (4 lanes, 5% cross slope = 0.4 m "mismatch"); (2) lips are measured on samples 0.5 m of path
  length apart (the points where one edge meets the next sit centimeters apart, and a sample there turned any 8% grade into a
  "6 cm lip"); (3) the drawn-vs-solid rays look 1 m past `SIDE_REACH`, only a wall inside it counts (a hull's near face at 9.7 m,
  its drawn face at 10.0 m was "solid but not drawn"); `QBUS_LIST=n` lists n findings per test (default 8).
- Not fixed: El Ejido (e694→e195). The kink is real (65 degrees in 10 m, radius ~7 m, tighter than a 12.5 m bus turns) and the
  cut is boxed in: Av. 10 de Agosto runs over its east lane, another carriageway of it along the west wall, so neither the
  wall nor the centerline has room. Tried: easing the line to a minimum radius of 10-28 m (`easeBends`, a Laplacian pull on the
  tight points, ends and junctions fixed), wider bend room (`BEND_MAX` 3.5 and a tightness factor), pushing the west
  street out (`clearCuts` taper/roof reach): the hit just moves to the next wall tip (the north wall under the crossing
  street jogs 1.2 m in, or the bend's far end), at best Δv 3.2 instead of 4.6. Needs the street network there redrawn, not the cut.
- Left in the surface check: seams of 7-18 cm where two road pieces meet. Their lifts differ by up to 9 cm at the shared
  vertex (the grade smoothing averages each copy with its own neighbours); making the copies one vertex removes most of the
  steps (0.27 m -> 0.10 m at (-82.9, 761.5)) but moves a wall tip closer to the 12 de Octubre N->S lane (the interparroquial
  @ 35 then wedges at (-65.5, 751.5), 1.2 m from lane center), so it is not in. The 0.18 m seam at the top of the 12 de
  Octubre ramp (-129.6, 782.4) and the one at the Guambra deck joint (-622.6, 312.8) stay with the lifts joined: a floor ending
  below the ground and a junction slab, not a lift step.
- Cut by the Guambra, articulado @ 60: Δv 0.95-1.16 against 1.0, flips with centimeters (now listed).

- Follow-up 2026-10-23: cut walls (the two hulls of each retaining wall) are frictionless (`solidHull(..., true)`): a graze slides instead of grabbing. El Ejido no longer stalls (stuck 2.8 s -> 0 / 0.3 s; Δv 4.6 -> 2.8 @ 35, 6.4 -> 8.3 @ 70, still over 1.0: at 70 km/h in a radius-7 bend the bus meets the wall head-on) and the Guambra articulado graze passes (its entry is gone). One trimesh per wall side with chamfered tips was not built: hulls are what the drawn walls and the parity test use. Wider bend room (`BEND_MAX` 3.5, sweep x2.2) was tried again: Δv 1.6 @ 35 but it stalls the 12 de Octubre N->S passage (-72, 752) for all vehicles, so not in.
