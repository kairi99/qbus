# Underpass / bridge bug catalog: La Mariscal

Recon of every grade-separated road in `data/cities/mariscal.json` at default hills (scale 1).
Evidence for the Collision/Physics, Rendering and AI/Nav fixers; each item's **Status** says what has been fixed since.
All probes live in `tools/underpass-recon/` (run with `npx tsx …` from the repo root, Node from nvm);
their outputs from this run are committed in `tools/underpass-recon/out/`. Screenshots (gitignored) are in
`e2e/screenshots/recon/{day,night}/` from `QBUS_PORT=5182 npx playwright test underpassRecon`.

Coordinates: world x (east), z (south), meters. "edge N" = `buildRoadGraph(city).edges[N]`;
"road #N" = `city.roads[N]` (both stable for the current city JSON). Bus heights above the road:
popular 3.0 m body, top ~3.15 m over the road; interparroquial 3.3 m body, top ~3.45 m; buseta ~2.95 m; AE86 ~1.3 m.

## Inventory

| Complex | Road # (graph edge) | OSM way | What | lift | Extent (world) |
|---|---|---|---|---|---|
| A. Patria / 12 de Octubre | #84 (e155) | 24650062 tunnel L-1 | 12 de Octubre N→S tunnel under Patria | -6.5 | (-2,705)→(-87,756) |
| A | #85 (e156) | 24650063 | its south ramp up | -4.7→0 | (-87,756)→(-155,798) |
| A | #407 (e586) | 425195362 | its north ramp down | 0→-5.0 | (45,675)→(-2,705) |
| A | #145 (e242) | 31528042 tunnel L-1 | 12 de Octubre S→N tunnel | -6.5 | (-84,760)→(1,710) |
| A | #410 (e589) | 425195366 | its south ramp down | 0→-5.0 | (-152,802)→(-84,760) |
| A | #144 (e241) | 31527988 | its north ramp up | -5.0→0 | (1,710)→(50,682) |
| A | #406 (e585), #229 (e349), #367 (e524) | 425195361, 253069205 tunnel, 420861083 | N→S link: off 12 de Octubre, under Patria side, up to Queseras del Medio / 12 de Octubre | to -6.5 | (44,672)→(-33,711)→(-64,720) |
| A | #409 (e588), #365 (e523), #89 (e160) | 425195365, 420861081 tunnel, 24650067 | S→N link: off 12 de Octubre, under Queseras, up to Av. Patria (restored link) | to -6.5 | (-150,808)→(-57,757)→(-18,728) |
| B. Puente del Guambra | #401 (e575), #93 (e165), #689 (e895) | 424792137, 24650209 bridge L1, 534542787 | Av. Patria westbound over 10 de Agosto | to +6.5 | (-499,388)→(-693,218)→(-702,199) |
| B | #95 (e167), #358 (e517) | 24650211 bridge L1, 420853985 | Av. Patria eastbound over 10 de Agosto | to +6.5 | (-701,219)→(-633,324)→(-549,373) |
| B | #117 (e197), #118 (e198), #119 (e199) | 24672301, 24672302 tunnel, 24672303 | link Patria → 10 de Agosto, under Patria's bridge ramp | to -6.5 | (-499,388)→(-626,320)→(-669,340)→(-713,435) |
| C. West edge (El Ejido) | #476 (e681), #115 (e195), #116 | 431762830, 24672281 tunnel, 24672282 | link Tarqui → 10 de Agosto, tunnel under 10 de Agosto | to -6.5 | (-690,790)→(-812,770)→(-836,787)→(-890,878) |
| C | #182 José Riofrío, #181, #183 (e297) | 106941324 tunnel, 106941334 | link from José Riofrío (outside play area) to Tarqui | to -6.5 | (-946,826)→(-883,849)→(-843,854)→(-719,807) |
| D. 10 de Agosto south | #167 (e276) | 50511607 | 10 de Agosto S-bound ramp down | 0→-5.5 | (-216,-748)→(-176,-845) |
| D | #395, #163, #393 | 423661907, 423487570 tunnels L-1 | 10 de Agosto tunnels under the Paso elevado (mostly outside the play area, z < -897) | -6.5 | (-176,-845)→(-130,-946); (-137,-965)→(-191,-837) |
| D | #396 (e564) | 423661909 | 10 de Agosto N-bound ramp up | -3.2→0 | (-191,-837)→(-226,-761) |
| D | #135, #136 | 31108618, 31108625 bridge L1 | Paso elevado 10 de Agosto (outside the play area; #136 only lifts 0.8 m inside) | to +6.5 | (-68,-968)→(-191,-852) |
| E. Av. América west edge | #53, #357 (e516) | 24559926 tunnel, 420853981 | América link: tunnel past the west edge, ramp up to Av. América inside | -3.8→0 inside | (-900,-144)→(-866,-250)→(-826,-364) |

All 26 lifted drivable edges were driven (probe 1). Joints between lifted ways (probe `clearance.ts` §4)
all agree within 0.1 m: no steps at OSM joints.

## Probes

1. `drive.ts`: every vehicle (popular, interparroquial, buseta, ae86) × 40 and 75 km/h, along the legal
   path through each lifted edge and out by every exit of the junction after it; logs chassis contacts
   with static colliders (impulse, normal, contact point), stalls, airtime. `summarize.ts` groups them
   (`out/drive-summary.txt`, raw `out/drive-all.jsonl`). `TRACE=1` prints a step log.
2. `clearance.ts`: ceilings over every lane, forward obstacles at 0.3/2.3/2.9/3.3 m, physics surface vs graph
   `edgeY`, joints (`out/clearance.txt`).
3. `sweep.ts`: bus-sized box (2.5 m wide) every 0.5 m of every lane and 1 m of junction hulls, slices
   0.35–1.3 m (lips/walls) and 2.0–3.6 m (roofs) (`out/sweep.txt`).
4. `section.ts <edge> <s0> <s1> [step]`: cross-section of solid surfaces (`out/section-*.txt`).
   `whatis.ts x y z r`: which colliders are at a point (convex hull bounding boxes).
5. `nav.ts`: `Navigator.locate` with/without y, `snapToRoad` from every lifted edge and from the street
   over each crossing, stops/props/trees near ramps (`out/nav.txt`).
6. `traffic.ts`, `trafficY.ts`: 90 s traffic runs at each complex, 2 seeds (`out/traffic.txt`).
7. `e2e/underpassRecon.spec.ts`: 156 views (driver seat + chase, start/mid/end of every lifted edge),
   day and night, PNGs plus a magenta hole count. `sheet.py` makes contact sheets
   (`e2e/screenshots/recon/sheet-*.png`).

---

## Bugs

### UP-001: Patria-bridge link: interparroquial jams under a roof-edge lintel at 3.37 m
- **Status: fixed (Collision/Physics).** `HEADROOM` is now the clear height (4.2 m: tallest bus + suspension/pitch), and the lintel/roof-edge face never hangs below it; the roof is decided over every cut at a point (`roofAt`), not the nearest one, so it no longer flips on and off where two cuts meet. Harness e197→e199 drives pass; recon `drive.ts … 197,198,199`: no stalls.
- **Category:** collision/physics (+ rendering: the lintel is the visible roof edge)
- **Severity:** high (the interparroquial can't drive the link Patria → 10 de Agosto: stuck 38–42 s, every run)
- **Where:** complex B, link #117/#118 (e197 → e198), under Av. Patria's westbound ramp (#401) at about
  (-623, 321); OSM 24672301 / 24672302.
- **Repro:** `npx tsx tools/underpass-recon/drive.ts interparroquial 40,75 197,198,199`. Contact
  at (-622.9, 23.27, 321.0), impulse 16–19k, normal (-0.86, 0, -0.51), 1.19 m above the bus center. Bus ends at
  (-618.1, 325.1). Popular, buseta and AE86 pass under it.
- **Evidence:** `whatis.ts -622.9 23.27 321 0.4` finds a 0.2 × 1 × 1.6 m convex hull at y 23.27–24.87: a
  terrain-patch roof railing + lintel (`stripCorners(pa, pb, y - 0.6, …, PARAPET + 0.6, 0.12)`). Road there is
  y ≈ 19.9, so the lintel bottom is 3.37 m over the asphalt. `out/section-197.txt` s 120–129: roof 4.2–4.4 m above most of the lane.
- **Suspected cause:** `src/world/gradeBuilder.ts:663` keeps the ground as a roof where
  `terrain - floor > HEADROOM` (3.6, line 111), then hangs a 0.6 m lintel under the roof edge
  (lines 682–685) and a ceiling 0.6 m under it (666). So the actual headroom at an edge is HEADROOM - 0.6 = 3.0 m,
  less than the tallest bus. HEADROOM itself is 0.15 m over the interparroquial's roof.
- **Fix direction:** require headroom ≥ tallest vehicle + margin (about 4.2 m) measured to the lintel/ceiling
  bottom, not the terrain; or don't hang lintels over a lane. Add a lane box sweep at the
  interparroquial's height to `tests/lanesClear.test.ts` (it only ray-casts at 0.6 and 1.5 m, see UP-014).

### UP-002: 10 de Agosto northbound comes up under a 3.2 m roof ("10 de Agosto start jams")
- **Status: fixed (Collision/Physics).** With the 4.2 m headroom the 3.2–3.5 m roof is gone, and the shoulders down in a cut (lift < -0.5) are never left to a street alongside (`claimedByRival`), so no ground stands over lane 0; e564 drives and swept volume pass. The approach road's own asphalt keeps its roof (`coverTest`: a parallel street covers its own asphalt), so it has no hole.
- **Category:** collision/physics, rendering
- **Severity:** high (popular stalls 8.8 s at 40 km/h; interparroquial stuck the whole run (41 s) and airborne-flagged; visible dark slab right over the windscreen)
- **Where:** complex D, start of #396 (e564) at (-191…-197, -837…-829), under the Paso elevado's ground-level
  approach (#351 / edge 870, y ≈ 20.8); OSM 423661909 (and 423487570 tunnel before it).
- **Repro:** `npx tsx tools/underpass-recon/drive.ts popular,interparroquial 40 564`; screenshot
  `e2e/screenshots/recon/day/e564-Av_10_de_Agosto-start-driver.png` (low dark roof over the right lanes).
- **Evidence:** `out/clearance.txt`: ceiling 3.2 m over lane 0 at (-195.7, -835.8) (TriMesh), convex obstacles
  0.68 m ahead at 2.9 and 3.3 m up. `out/section-564.txt` s 0–14: on the right side (offsets +5.5…+8) a roof at
  +3.4 → +2.1 m and a wall (C) at the asphalt edge; down-ray at s 0 shows the floor 0.1–0.16 m below the graph
  surface over half the lanes. Bus contacts: wall at (-196.9, -831.1) cpRel +0.25 m, TriMesh at (-198…-202, -829…-821).
- **Suspected cause:** #393 ends at lift -3.33 and #396 starts at -3.23 (`grades.ts` ramps it from the crossing
  point) while it's still under the at-grade street #351/edge 870, which `coverTest` (`gradeBuilder.ts:207`) treats
  as covering the cut: the ground stays as a roof only 3.2–3.5 m above the floor. The crossing that matters is
  the Paso elevado (#135, outside the play area), and the road continuing under its ground-level approach isn't
  kept down long enough (`grades.ts:248` `stretch` only follows the crossing road's own width).
- **Fix direction:** either keep #396 deep (lift ≤ -5) until it clears the approach road's asphalt plus a margin,
  or don't keep a roof where floor-to-roof < ~4.2 m (open the cut and wall the street, or let the street ramp).
  Same rule as UP-001.

### UP-003: Av. América west-edge link: sawtooth roof/floor at the HEADROOM threshold traps buses
- **Status: fixed (Collision/Physics).** Same rule as UP-001/002: the roof needs 4.2 m everywhere under it and is decided over all cuts at once; e516 drives and swept volume pass (left on e516: a 0.10 m lip and a 0.27 m graph/surface mismatch on lane 2).
- **Category:** collision/physics, rendering
- **Severity:** high where reached, but medium overall: inside the play area (x ≈ -861, 15 m from the edge),
  reached by traffic entering from the map edge or a bus driving the one-way link wrong-way from Av. América.
- **Where:** complex E, #357 (e516), s 0–30, (-866, -250)…(-856, -278); OSM 420853981 (tunnel 24559926 beyond the edge).
- **Repro:** `npx tsx tools/underpass-recon/drive.ts popular,interparroquial 40,75 516`: popular never gets out
  (45 s, ends at (-859.7, -257.1)), interparroquial@40 the same; 12–15k "wall" contacts with the TriMesh.
  Screenshot `day/e516-sin_nombre-start-driver.png`: grey slabs and spikes across the lane.
- **Evidence:** `out/section-516.txt` s 3: down-rays across the asphalt alternate 0.00 (floor) and 3.48–3.5
  (roof) every 0.5–1 m, i.e. the 1 m terrain patch flips between "roof" and "dipped" cell by cell; ceilings
  3.48–3.62 m (`out/clearance.txt`), forward hits at 2.9/3.3 m. Low-slice lips (TriMesh 0.35–1.3 m) along both curb lanes s 6–30 (`out/sweep.txt`).
- **Suspected cause:** `terrainPatch` (`gradeBuilder.ts:598–623`) decides roof vs open per vertex with
  `terrain - cut.y > HEADROOM` while the lift here is -3.5…-3.8 and terrain ≈ floor + 3.5…3.8, so the test
  flickers across the road. Vertical triangles join roof vertices to dipped neighbours across the lanes. What
  "covers" the cut here (`coverTest`) is probably Av. América (edge 729) running alongside within ROOF_MARGIN or
  #53's end junction; to confirm.
- **Fix direction:** hysteresis or a minimum roof area (decide the roof per connected region, not per vertex);
  never keep a roof whose floor clearance is near the threshold; check what covers it.

### UP-004: Saw-tooth concrete "teeth" along the foot of retaining walls (and lips at the asphalt edge)
- **Category:** rendering, collision/physics
- **Severity:** high visually (in most cuts, from both cameras); medium for physics (horizontal-normal
  TriMesh contacts slow and jolt buses; AE86@75 stopped dead at (-195.4, -791.3), impulse 10.8k).
- **Where:** every deep cut; worst on e197 end ((-625, 320)), e564 start, e585 end ((-4, 700)), e349 start,
  e516 start, e156 start ((-87, 756)), e160 start, e195 start. Lips onto the asphalt: e276 (10 de Agosto ramp, both curb lanes,
  (-189…-175, -806…-839)), e241 lane 0 ((24…5, 699…710)), e589 lane 1 ((-128…-88, 785…760)), e516.
- **Repro:** screenshots `day/e197-sin_nombre-end-driver.png`, `day/e564-…-start-driver.png`,
  `day/e585-…-end-driver.png`, `day/e349-…-start-driver.png` (contact sheet `e2e/screenshots/recon/sheet-detail.png`).
  `npx tsx tools/underpass-recon/sweep.ts` lists the low-slice TriMesh hits; `section.ts 516 0 30 3` shows
  0.4–0.9 m of patch ground over the asphalt at offset -4.95 of a 5.45 m half-width (s 15–21).
  Bus drives: e241/e242 ~1100 TriMesh side contacts per run at (0.5…12, 713…706), normal (0.52, -0.2, 0.83);
  e276 contacts along (-191…-183, -801…-819).
- **Suspected cause:** the 1 m patch dips vertices inside `trenchAt(..., UNDER_WALL)` (`gradeBuilder.ts:617`)
  but a triangle whose other corners lie just outside the reach climbs from the floor to full ground height
  across one cell, and gets the CONCRETE color (`:654`), so it reads as spikes in front of the wall. Where the
  wall's diagonal grid cells straddle the shoulder, the slope reaches over the asphalt (lips).
  `claimedByRival` (`:161`) also lets a parallel street keep ground over the curb lane near ramp tops (e589 lane 1, e276).
- **Fix direction:** dip every vertex whose cell touches the wall's footprint (dig by cell, not vertex; or extend
  the reach by one grid diagonal, ~1.42 m), or clip the patch triangles against the wall's outer face; keep
  patch ground off the asphalt entirely below a small tolerance.
- **Status: visual part fixed (Rendering); lips partly.** The patch is dug a cell's diagonal (`UNDER_WALL` ≈ 1.46 m) past every wall's inner face, also beside a street alongside (never under its asphalt), so no triangle climbs in front of a wall; a solid, fully drawn walkway (`APRON`) covers the pit behind each wall not under a roof. The harness's lane-0 swept-volume hits on e276/e241 and drive-throughs on e564 (buseta), e197 (interparroquial @35) and e516 (interparroquial) now pass. Left: e276 lane 2 (4 hits ≤ 0.15 m), the slope between it and the N-bound ramp's shared cut. Collision/Physics also: shoulders in a deep cut are never ceded to a street alongside, and a wall under a street is a cell's diagonal thicker with its top flush with the street, so the ground climbing to the street stays inside it (no lips on e277 along the 12 de Octubre ramp).

### UP-005: West-edge (El Ejido) tunnel bend: buses scrape and jam on the retaining wall (known open item)
- **Status: partly fixed (Collision/Physics).** Cuts widen on bends for a long bus's swept path (`bendAlong`: about L²/8R from the heading change over 12 m along the chain of dug-in ways, up to 2 m, both sides; floor, walls and dig follow). Recon: the interparroquial now gets through (stall 5–8 s, was stuck 22 s) and the R reset there is clear of the wall; the harness autopilot still jams on the sharp OSM kink at (-829.2, 773.8) against the outer tunnel wall. Needs a smoothed centerline (or a bigger kink allowance) for that way.
- **Category:** collision/physics
- **Severity:** high (interparroquial@40 stuck 22 s / never arrives; popular stalls 1.2–1.8 s with impulses
  of 1.7–8.6k; buseta scrapes; AE86 is fine)
- **Where:** complex C, e681 → e195 (#476 → #115) at (-818…-832, 768…777); OSM 431762830 → 24672281.
- **Repro:** `npx tsx tools/underpass-recon/drive.ts popular,interparroquial,buseta 40,75 681,195`.
- **Evidence:** first hit at (-819.7, 768.3), contact (-825.2, 19.8, 767.3), normal (-0.5, 0, -0.87), then
  sliding along (-828…-832, 772…777) with normal (-0.91, 0, -0.42). `whatis.ts -825.2 19.8 767.3`: retaining wall
  hulls 6.8 m tall (y 19.2–26.0). Autopilot deviation from the lane path stays ≤ 1.8 m, so the cut is just too
  narrow for a 11–12.5 m bus's swept path on this bend (two lanes, 7.6 m, plus 0.6 m shoulders). Sweep: the
  bus-wide box in lane 1 at (-826.5, 774.5) already touches the wall at 0.35–1.3 m and 2–3.6 m.
- **Suspected cause:** walls stand at `half + WALL` (`gradeBuilder.ts:469`) regardless of curvature; the OSM
  centerline cuts the corner (#476 end / #115 start meet at an angle at (-812, 770)), and `JOINT_OVERLAP`
  extends the walls straight past the joint into the inside of the bend.
- **Fix direction:** widen shoulders on curved stretches (offset by the bus's swept-path overhang,
  ≈ L²/(8R)), or bevel the wall corner at the joint instead of overlapping straight pieces.

### UP-006: S→N link (e160) climbing to Av. Patria: long buses hit the cut walls on the bend at the top
- **Status: open (Collision/Physics).** Bend widening applies, but at the top the ramp runs 1.1 m of ground away from Ladrón de Guevara: the wall between them at (-16.6, 747.6) (0.8 m of retained ground plus parapet) is all the room there is, and the interparroquial's overhang sweeps it. Needs the ramp at street level sooner (it already climbs at 16%) or a lower barrier there.
- **Category:** collision/physics
- **Severity:** high (interparroquial stuck all 45 s at (-21, 749) whatever the exit; popular stalls
  4.3 s turning onto 12 de Octubre (e460); buseta and AE86 stall 3–4.5 s at (-16, 729))
- **Where:** complex A, #89 (e160) from (-57, 757) to node 202 (-17.8, 727.7); OSM 24650067.
- **Repro:** `npx tsx tools/underpass-recon/drive.ts popular,interparroquial,buseta,ae86 40,75 160`.
- **Evidence:** interparroquial: contact (-16.5, 18.47, 748.0), impulse 2.6–8.8k, normal (0.98, 0, 0.22), wall hulls
  y 17.7–21.9 at x -16.7…-15.7 (`whatis.ts -16.5 18.47 748`). Everyone else: hulls at (-16.3, 728.7) as they turn
  out of the top of the ramp into node 202, normal (0.98, 0, 0.2). Also many TriMesh side contacts at (-20, 747)
  (patch spikes, UP-004).
- **Suspected cause:** a tight 1-lane (6 m) link curving ~45° inside its cut; the walls follow the centerline
  at a fixed offset, and the cut's wall runs right up to the junction hull at (-16, 729), where a turning bus
  sweeps outside the edge's ribbon. `gradeBuilder.ts:530–565` (sunk-junction walls) / `:466–526`.
- **Fix direction:** same as UP-005 (curvature-aware shoulder), and stop the walls (or flare them out) where the
  ramp is within a bus length of an at-grade junction it turns into.

### UP-007: N→S link top (e524 → Queseras / 12 de Octubre): wall at the junction corner; traffic jams there
- **Status: traffic part fixed (AI/Nav); wall and the e524/e277 1.15 m step open (Collision/Physics):** the graph merges two junctions at node 257 and trims the link ~15 m before the real one; keeping it level from there (the import's junction-level feedback) would need a 16% climb straight out of the crossing, a V the bus high-centers on, so that one is refused. The sim's obstacle test was 2D, so cars on the street over the link's tunnel held up cars in it (also the harness's car stuck > 20 s on e349): obstacles now carry a lift and only block their own level. `traffic.ts 90 2`: no more waits/recycles on e524.
- **Category:** collision/physics, ai/nav
- **Severity:** medium-high (interparroquial@40 stuck at (-60.7, 715.9) when exiting to 12 de Octubre (e277);
  impulses 9.7–14.4k at (-57.1, 713.3) for interparroquial on both exits; popular/buseta hit at (-62, 717) /
  (-64, 719) with 1.4–3.6k; in traffic runs cars on e524 at (-62, 718) wait > 24 s and get recycled 4 times in 90 s (seed 2)).
- **Where:** complex A, #367 (e524) end at node 257 (-63.9, 719.9); OSM 420861083.
- **Repro:** `npx tsx tools/underpass-recon/drive.ts interparroquial 40,75 524,349`;
  `npx tsx tools/underpass-recon/traffic.ts 90 2` (site "Patria / 12 de Octubre", seed 2).
- **Evidence:** `whatis.ts -63.5 18.12 714.6`: retaining wall hull y 17.4–20.4 at x -64.0…-63.2, z 713.2…715.0,
  i.e. at the end of the ramp right where buses swing left/right into node 257. Edge 524 still has lift -0.97 at
  its end (graph), so the wall is 1–2 m tall at the junction corner.
- **Suspected cause:** the ramp's last stretch is still dug in at the junction (`grades.ts` JUNCTION_CLEAR=10 m is
  measured from the anchor vertex, but the graph's trims/cluster at node 257 sit further out), so the walls of
  `gradeBuilder.ts:466–526` stand at the junction mouth. For traffic, cars wait at node 257's entry on a 1-lane
  ramp whose exit is shared by 12 de Octubre and Queseras flows (priority starvation).
- **Fix direction:** end the walls (or lower them flush) inside the junction trim distance; check node 257's
  admission order for the link (it's the only entry with a stop line on a ramp).

### UP-008: Bridge railing missing on Puente del Guambra (westbound deck), and an open slit between the two decks
- **Category:** collision/physics, rendering
- **Severity:** medium (a bus can drop a wheel into a 1 m slit 6 m deep, or go over the open edge; railing gap visible)
- **Where:** complex B, #93 (e165): right railing absent around s 52 ((-662, 279.5)); left railing absent from
  s ≈ 67 on ((-669, 266) onward), where a 1 m gap opens between the westbound and eastbound decks (offsets
  -4.8…-4.3 drop to the heightfield 6 m below).
- **Repro:** `npx tsx tools/underpass-recon/section.ts 165 40 70 3` (`out/section-165.txt`): offsets ±3.8 should
  read `1.00C`; at s 52 the right one is `-0.01T` then `-6.6H`, at s 67/70 the left one is `0.00T` then `-6.1H`.
- **Suspected cause:** `gradeBuilder.ts:386` drops the railing where `joins(ri, out, y)` or `onTraffic(ri, mid, y)`:
  a point 1 m out lands on the other deck (#95, within 1.5 m in height near the ends) or a road at about the same
  height, so the railing on the slit side is skipped although the other deck isn't joined to it.
- **Fix direction:** skip railings only where another road's asphalt is actually contiguous (no gap between the
  ribbons); otherwise keep the railing or pave the slit between parallel decks.
- **Status: fixed (Rendering), railings.** A road alongside only cancels a railing where its asphalt touches the deck (tested 0.15 m past the edge instead of 1 m), so both decks are railed along the slit, down to node 171. The slit itself (0.5–0.7 m wide, decks 0.6–0.8 m apart in height) is fenced, not paved. Right side at s 52: a railing hull is there (`whatis.ts -659.2 31.6 276.95`); the old section probe sampled the joint.

### UP-009: Puente del Guambra westbound: every bus brushes the right railing at (-659, 278)
- **Status: fixed.** Harness Guambra passages and recon `drive.ts … 165`: no railing shoves. Also: deck node slabs follow their roads' surfaces (no lip at angled deck joints), and the higher of two overlapping carriageways' decks stops at the lower one's asphalt (the buseta shove at (-692.6, 213.1)).
- **Category:** collision/physics
- **Severity:** low-medium (speed loss and scraping on the bridge's best-known stretch: popular@75 impulse
  1.2k, interparroquial@75 1.8k, AE86@75 1.9k; at 40 km/h too)
- **Where:** e165 → e895 (#93 → #689) at (-657…-661, 282…276).
- **Repro:** `npx tsx tools/underpass-recon/drive.ts popular,interparroquial 40,75 165`.
- **Evidence:** contacts at chassis bottom height (cpRel -1.5) against railing hulls y 30.86–32.07
  (`whatis.ts -659 31.35 277.5`); the curb-lane path is 1.9 m off center on a 7.6 m deck, so a 2.5 m bus has
  0.5 m to the railing's inner face, and the railing is centered on the asphalt edge (0.15 m into the lane,
  `gradeBuilder.ts:387–388`).
- **Fix direction:** set railings outside the asphalt (offset by half their thickness), and check the
  deck/curb-lane geometry near the railing gap of UP-008 (the deck bends there).

### UP-010: Eastbound Patria bridge: interparroquial hits the inner railing at speed near (-645…-658, 305…319)
- **Status: fixed.** Recon `drive.ts interparroquial 40,75 167,517`: reaches, no stall. The harness's Guambra northbound "sink" was the up-ramp starting 1.25 m up inside node 171's paved area: ramps are now kept level across the junction areas the graph paves (`rampsIntoJunctions` feedback in `import.ts`).
- **Category:** collision/physics
- **Severity:** low-medium (interparroquial@75 impulse 28.6k at (-648.5, 313.7) on e167 → e517; scraping on e167 at 40 and 75)
- **Where:** complex B, #95 → #358 (e167 → e517); railing hulls at (-644.9, 318.9), y 30.0–31.5.
- **Repro:** `npx tsx tools/underpass-recon/drive.ts interparroquial 40,75 167,517`.
- **Suspected cause:** same as UP-009 (railing in the lane edge) on the bend at the bridge's east end.

### UP-011: Chase camera has no collision: inside tunnels and cuts it goes into the roof, the ground or behind walls
- **Category:** rendering (camera)
- **Severity:** high (player-facing in every roofed tunnel with the default camera)
- **Where:** all roofed stretches: A (e155/e242 under Patria/Queseras, roof ~6 m over the floor), B (e198), C (e195 bend).
- **Repro:** `src/camera/cameraRig.ts:80–92`: chase sits `max(7, 1.3·L)` m behind and `min(7, 2 + 1.8·H)` m up
  (popular: 14.3 m back, 7 m up), with no raycast. In a 6.5 m deep tunnel under a roof that puts the camera above
  or inside the roof. Recon `day/e195-sin_nombre-mid-chase.png` (13 m back, 5 m up, on the west-edge bend):
  the view is a wall face, the underside of the ground and 18k px of nothing (magenta = sky through the
  back of the terrain).
- **Fix direction:** cast from the bus to the desired camera spot against STATIC and pull the camera in (and
  down) to the hit; or lower the chase offset while the bus is under a roof (`terrainPatch` knows the roof cells).
- **Status: fixed (Rendering).** `CameraRig.obstacles` (`src/physics/cameraObstacles.ts`, fixed colliders only, small cylinders/cones/boxes and the map-edge box ignored): a ray up from over the bus caps the camera 1.2 m under any roof or deck, and a 0.9 m ball swept from there to the camera pulls it in before any wall, ground or roof. Both pull in at once and ease out (1.5/s); two casts per frame, nothing allocated. `tests/cameraRig.test.ts` covers roof, wall, ease-out and a real Rapier tunnel with a pole.

### UP-012: Ragged roof edges and slivers hanging into tunnel mouths
- **Category:** rendering
- **Severity:** medium
- **Where:** tunnel mouths of A: e349 start ((-4, 700), a thin vertical sliver standing at the left lane edge and
  dark spikes hanging from the roof), e585 end, e155 start, e195 mid, e523.
- **Repro:** `day/e349-sin_nombre-start-driver.png`, `day/e585-sin_nombre-end-driver.png`,
  `day/e195-sin_nombre-mid-driver.png` (see `sheet-detail.png`).
- **Suspected cause:** the roof/open decision per 1 m cell (`terrainPatch`, `gradeBuilder.ts:598–640`)
  leaves a staircase edge; the "mouth" skip (`:640`) drops cells only over road asphalt, so cells over the shoulder
  stay as triangles going from roof down to the dipped floor (slivers); lintels/railings (`:670–686`) only on axis-aligned
  cell sides, so a diagonal mouth gets a jagged lintel.
- **Fix direction:** build the roof edge as a clean line across the cut (perpendicular to the road at the cover
  boundary) instead of the cell staircase; same patch rework as UP-003/UP-004.
- **Status: partly fixed (Rendering).** Roof vs open is now decided per patch cell: roof cells are flat at the ground, every other cell in the cut is floor, and each roof edge gets a vertical face down to the lower side (a lintel ≤ 0.6 m, never below `HEADROOM` over the floor), with railings only over the cut. No more slivers, spikes or stepped dark slabs; the ceiling follows the roof. Left: on a diagonal mouth the lintel still follows the 1 m cell staircase. Also fixed: the harness's slit to the sky at (-28, 730) (the cut's wall was left out where the S→N link, 6 m above its floor, was taken for a carriageway sharing the cut: `otherFloor` now needs floors within 2.5 m, and a ramp that far above the floor roofs the cut).

### UP-013: R reset near ramp tops can snap onto a parallel street at another level
- **Status: fixed (AI/Nav).** `snapToRoad` scores distance off the asphalt plus 4× the height mismatch under the bus, takes the bus's height from its wheel contacts (`BusPhysics.roadHeight`), slides along whole roads, and with `vehicleClearance` (`src/physics/clearance.ts`) only lands where the bus box is clear of the static world (same level only); the reset pitches the bus to the road. `nav.ts` §2: no level changes left on lifted stretches (only at-grade overlaps, dy ≤ 0.3 m).
- **Category:** ai/nav (reset)
- **Severity:** low-medium
- **Where:** e564 (10 de Agosto N-bound ramp, s 27–51) → Paso elevado approach #351, up to 1.06 m higher and 2–3.4 m
  sideways; e516 (s 27–33) → Av. América #518, +1.07 m; e276 (s 15–39) → #574 alongside.
- **Repro:** `npx tsx tools/underpass-recon/nav.ts` §2 (`out/nav.txt`).
- **Suspected cause:** `snapToRoad` (`src/world/roadSnap.ts:35–38`) weighs height mismatch at 1.5× and a parallel
  road drawn 2–3 m away at ground level beats the ramp the bus is on, landing the bus straddling the retaining
  wall. Also: despite its doc comment it only slides clear of `features`, not of ramps.
- **Fix direction:** prefer the road the bus is on (the nearest one whose surface is within ~0.5 m of the bus),
  or weigh dy more heavily; reject spots whose bus footprint overlaps a wall (cut edge).

### UP-014: `tests/lanesClear.test.ts` runs at hills 1.3 and only ray-casts the curb lane at 0.6/1.5 m
- **Status: fixed (Collision/Physics).** `tests/lanesClear.test.ts` runs at `DEFAULT_HILLS` and at 1.3, on every lane, at 0.6/1.5/3.3 m (wheel, waist, roof). It found a roof-edge railing standing on Av. Patria's lanes over a hole in the street (now a parallel street always roofs its own asphalt, and no roof-edge railing stands on a street).
- **Category:** test gap (collision)
- **Severity:** medium (it can't catch UP-001/002/003: roofs at 3.0–3.5 m, other lanes, the real default scale)
- **Where:** `tests/lanesClear.test.ts:13` (`scale = 1.3`; the default is 1, `DEFAULT_HILLS`), `:17–23`.
- **Fix direction:** run at `DEFAULT_HILLS`, every lane, and with a box the size of the tallest bus (see
  `tools/underpass-recon/sweep.ts`, which finds them).

### UP-015: `Navigator.locate` without y picks the street over/under the cut (route stop lookup, path target)
- **Status: fixed (AI/Nav).** Every runtime caller passes a height (stops and start poses at street level, the bus its wheel-contact height); `locate` weighs dy 4× (`nav.ts` §1: 0 wrong picks with y). The in-game arrow also follows the path on the bus's level (`NavPath.lifts`, `guidePoint(..., lift)`).
- **Category:** ai/nav
- **Severity:** low today (stops are kept off ramps; the bus's own `locate` passes y)
- **Where:** e165/e167 on the bridge → 10 de Agosto below; e276/e564/e516 in the cuts → the parallel street at
  ground level. `src/gameplay/session.ts:440` and `src/gameplay/routes.ts:133,159,188,202` call `locate` without y.
  With y there is still one wrong pick: e564 s 24 ((-204.6, -816.8), lift -0.95) → Paso elevado edge 511 (dy 1.14),
  so guidance can flick to the parallel street on the ramp top.
- **Repro:** `npx tsx tools/underpass-recon/nav.ts` §1.
- **Fix direction:** keep passing y wherever a position on a lifted road is located; in `locate`, weigh dy
  enough that a 1 m step beats a 2–3 m lateral offset.

### UP-016: Traffic: cars ride 0.25 m into the floor at the west-edge tunnel joint
- **Status: fixed (AI/Nav).** `laneSurface` follows the road's own `surfaceY` (cross slope) and, near grade separations, the solid surface under the car (short STATIC raycast), so cars ride what the bus drives on, before and after geometry fixes. Also fixes the harness's e564 (floating 0.4 m: graph centerline vs cross slope) and e589 (sunk 0.4 m: patch ground over lane 1, UP-004) height failures.
- **Category:** ai/nav (traffic bodies), rendering
- **Severity:** low
- **Where:** e195 near (-835, 790) (end of #115, joint with #116).
- **Repro:** `npx tsx tools/underpass-recon/traffic.ts 90 2`, site "West edge": ~800 samples "sunk 0.25 m into the
  floor" per run.
- **Suspected cause:** `laneSurface` uses `edgeY` (centerline profile) while the solid there is higher (patch
  ground dipped to a neighbouring cut's floor via `trenchAt` nearest-cut choice, or the node slab); traffic bodies
  ignore STATIC, so they visibly sink.
- **Fix direction:** compare `edgeY` to the trimesh floor at the joint; make `trenchAt` prefer the cut whose
  asphalt the point is on.

### UP-017: Traffic bodies spawn at y ≈ 0 and rise for a frame at session start
- **Status: fixed (AI/Nav).** The `TrafficBodies` constructor places (and pitches) every driving car on its lane.
- **Category:** ai/nav (traffic bodies), rendering
- **Severity:** low (not underpass-specific; one or two frames)
- **Where:** everywhere; seen as 38 of 40 cars 8–10 m under their lanes at t = 0 (`out/trafficY.txt`).
- **Suspected cause:** `TrafficBodies` constructor (`src/gameplay/trafficBodies.ts:52–53`) places bodies at
  `height/2 + 0.02` (world y ≈ 0) and relies on `steer()` velocity to lift them; generation already matches, so
  `drive()` (which uses `groundAt`) never runs for the initial fill.
- **Fix direction:** call `drive(i)` (or use `groundAt`) for driving cars in the constructor.

### UP-018: Hump next to the Av. América link ramp top catches the AE86 at speed
- **Status: fixed (Collision/Physics).** Humps keep 25 m from any point of a road that's off the ground (along the road too, not just across it: `nearRampPoint` in `import.ts`); one hump beside the 12 de Octubre ramp went. The e516 AE86 drive passes.
- **Category:** collision/physics
- **Severity:** low
- **Where:** (-831.7, -339.7), 10 m past the top of #357 (e516 end), a speed hump (18-vertex hull, y 28.3–28.8).
- **Repro:** `drive.ts ae86 75 516`: stopped dead, impulse 10.5k.
- **Note:** by design humps are kept off ramps; this one is just past the ramp, where the car arrives
  pitched up. Consider keeping humps ≥ 20 m from ramp ends.

---

## Checked and fine
- Joints between consecutive lifted OSM ways: all within 0.1 m (`out/clearance.txt` §4). No steps.
- Driving through on all four vehicles, both speeds: no launches at ramp crests (airtime ≤ 0.6 s, almost all of
  it the spawn drop) except where a bus is wedged (UP-002: interparroquial hung with all wheels off the ground for
  41 s); no falling through the floor or heightfield (min body center over the road: popular 0.90 m,
  interparroquial 1.08, buseta 0.67; AE86 dips to -0.18 m at the AE86's lip hits of UP-004).
- 12 de Octubre main tunnels both ways (e155/e586/e156, e589/e242/e241): every bus gets through at both speeds;
  only patch-spike side contacts (UP-004) on e241/e242.
- Patria bridge decks: no gaps along the deck itself, slabs continuous; buses get over at 75 km/h.
- Reset from a street directly over or under each crossing (`nav.ts` §2b, 72 cases): stays on that street's level.
- `Navigator.locate` with y on lifted edges: right level everywhere except e564 s 24 (UP-015).
- Stops, stations, Metro entrances, props, trees: none on or within 1.5 m of a ramp's asphalt; the nearest stop
  (El Ejido, (-770.5, 763.9)) is 12 m from #476's ramp.
- Traffic: no car knocked loose without a bus around at any complex (90 s × 2 seeds × 5 sites); every lifted
  edge used. Body height matches the lane after the first frame.
- Hole check (magenta pass, lower 45% of 156 views, day and night): only the chase view behind the west-edge
  bend (UP-011). Night views were hole-checked by the same count; only one (e155 mid) was inspected by eye
  (fine). The other night PNGs are saved but nobody has looked at them yet.
- Map-edge cuts (#53/#181/#182/#393/#395 outside the play area): covered by `tests/edgeUnderpass.test.ts`; not re-tested.

## Not covered (time)
- ~~Pedestrian strips by cuts~~: done (AI/Nav): sidewalks, corners and crossings within 1.4 m of a cut's asphalt are dropped unless on street-level asphalt (`tests/pedestrians.test.ts`).
- ~~Sunset/night lighting inside cuts, AE86 driver's view in cuts~~: checked (Rendering) on e155/e242/e195/e198/e197/e564, chase and seat: lighting reads fine (headlights on the walls at night), no cockpit gaps. LOD popping and z-fighting by frame diffs: still not done.
- Exact cause of what `coverTest` treats as covering at UP-003 (Av. América vs. the junction hull).
