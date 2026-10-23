# Spectator camera, Río Verde tunnels, Circuito La Mariscal: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After finishing a race the player can watch the other racers' cameras. Río Verde's tunnels look like real bores through a mountain. A closed 3-lap street circuit runs in La Mariscal.

**Architecture:**
- **Spectator:** a pure cycle module picks who to watch. `CameraRig` follows any vehicle-like target, and `RaceGame` keeps scoring after the player's finish.
- **Tunnels:** rework the Río Verde dressing in `world/tunnels.ts`, plus a canyon-only rock texture.
- **Circuit:** street waypoints stored in `mariscal.json` (`circuits`) become a `TrackData` *unrolled over all laps* (lead-in + 3 copies of the lap + run-off). That way every existing race system (`s`, places, pickups, AI, R reset, ghost) works with a monotonic `s`. A `TrackData.circuit` block marks it, and a circuit builder dresses the ordinary Mariscal city.

**Tech Stack:** TypeScript, Three.js, Rapier (`@dimforge/rapier3d-compat`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-spectator-tunnels-circuit-design.md`. Executors read it too.

## Global Constraints

- UI text Spanish, code and comments English. Real street names only, never real companies.
- Physics code (`src/vehicle/bus.ts`, `src/physics/`) never imports three.js. Pure modules in `src/gameplay/` stay three-free and unit-tested.
- Papallacta and Silante JSON stay byte-identical (`git diff --stat data/cities`). Río Verde JSON may change (part 2). Mariscal JSON may only gain the `circuits` field (part 3).
- Route shifts and free roam in Mariscal are unchanged. The circuit dressing exists only when racing the circuit.
- Draw calls: merged static tiles and instanced meshes only, never one mesh per object.
- VM runs out of memory: run heavy suites one at a time with `flock /tmp/qbus-heavy.lock` (`npm test`, `npm run build`, `npm run test:underpass`, `npm run e2e`). Node via `. ~/.nvm/nvm.sh`.
- No git commits by agents: the user commits ("commit and update"). Stop after each milestone (M1, M2, M3) for a playtest.
- Update `CLAUDE.md` / `src/world/CLAUDE.md` bullets in the task that changes the behaviour they describe.

## Review Focus

1. **Solo race where an AI rival never finishes** (stuck, retired, rescued forever): the player must still reach the full results. "Terminar ya" and the auto-open both work. Test in Task 1.
2. **Online seat goes offline or retires while being watched:** the camera moves to the next racer and never follows a removed bus. Test in Task 2.
3. **A lapped car on the circuit:** places come from total distance, and the lap counter never shows lap 4/3. Test in Task 11.
4. **Hint-less `locateOnTrack` on the unrolled circuit** (R reset or fall after a long gap) must not snap a lap-3 car back to lap 1, which would cost two laps. Test in Task 10.
5. **Restart after spectating:** player bus visible and solid again, camera back on the player, every rival back on the grid. Test in Task 3.

---

## M1: Spectator camera

### Task 1: RaceGame keeps scoring after the player finishes

**Files:**
- Modify: `src/gameplay/raceGame.ts`
- Test: `tests/race.test.ts`

**Interfaces:**
- Produces:
  - `RaceGame.update` keeps recording finishes after `phase === 'over'` in every mode. Solo never fills estimates on its own any more.
  - `RaceGame.estimateRest(): void` fills each still-null time from pace (the current formula, ×1.03, `estimated = true`).
  - `get allDone(): boolean`: every racer has a time.
  - `phase === 'over'` still means "the player finished" (callers unchanged).

- [ ] **Step 1: Write failing tests** in `tests/race.test.ts`:
  - `'solo: rivals still racing at the player's finish get real times later'`: after the player crosses, the rival's `time` is `null`. Feed progress past `length` for the rival: it gets `time === game.time` with `estimated === false`. `allDone` flips to true.
  - `'estimateRest fills the rest from pace'`: the same numbers as the old automatic estimate. Adapt any existing test that expected the instant estimate to call `estimateRest()` first.
- [ ] **Step 2:** `npx vitest run tests/race.test.ts`. The new tests fail.
- [ ] **Step 3: Implement.** Drop the solo early return (`if (over && this.opts.estimate !== false) return ev;`) and the automatic estimate block. Move the estimate into `estimateRest()`. Keep the `estimate` option (online passes `false`): `estimateRest` is a no-op when it is false.
- [ ] **Step 4:** `npx vitest run tests/race.test.ts`. All pass.

### Task 2: Spectator cycle (pure)

**Files:**
- Create: `src/gameplay/spectator.ts`
- Test: `tests/spectator.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Watchable { racer: number; place: number; racing: boolean } // racing: still out (not finished past its photo window, not retired, bus exists)
  export class SpectatorCycle {
    /** Racer being watched, or null (nobody left: open the full results). */
    get target(): number | null;
    /** Each frame: who may be watched. Keeps the current target while it is still racing, else moves to the next by place (nearest place below first, then above). */
    update(list: readonly Watchable[]): void;
    /** ←/→, LB/RB, touch arrows: step through the racing ones ordered by place, wrapping. */
    step(dir: 1 | -1): void;
    reset(): void;
  }
  ```

- [ ] **Step 1: Write tests:**
  - first `update` picks the racing one with the best place;
  - `step(1)` / `step(-1)` wrap in place order;
  - the target finishing or retiring moves to the next place;
  - an empty list gives `target === null`;
  - a racer index that disappears from the list (a removed online seat) is never kept.
- [ ] **Step 2:** Run. Fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run tests/spectator.test.ts`. Pass.

### Task 3: Finishers ghost and stop; RaceSession spectates

**Files:**
- Modify:
  - `src/gameplay/raceSession.ts`
  - `src/gameplay/raceDriver.ts` (a finished driver brakes to a stop in its lane)
  - `src/vehicle/busModel.ts` (only if hiding needs a helper; `root.visible` may do)
- Test: `tests/track.test.ts` (headless AI block)

**Interfaces:**
- Consumes: Task 1 `allDone` / `estimateRest`; Task 2 `SpectatorCycle`.
- Produces, on `RaceSession`:
  - `spectating: number | null`: the racer index watched, 0 = player (never while spectating).
  - `spectateTarget(): CameraTarget | null`.
  - `spectateStep(dir: 1 | -1): void`.
  - `endNow(): void`: "Terminar ya": `estimateRest`, open full results.
  - `get watchInfo(): { name: string; place: number; gap: number | null; vehicle: string } | null`: for the HUD strip.
- Behaviour:
  - Any finisher (player, AI rival, remote) eases to a stop in its lane and turns ghost. Rivals: `bus.setGhost(true)`, `model.setGhost(...)`. Remotes are already ghost when `g` says so; locally treat a finished remote as ghost.
  - Once the photo-finish camera ends, the player's bus is ghost and hidden.
  - Spectating starts when `FINISH_CAM` ends, if anyone is still racing. Otherwise the full results show as today.
  - Full results open on their own when `allDone` (solo) or when the room's results are all in (online).
  - `restart()` undoes all of it: player visible and solid, spectator reset.

- [ ] **Step 1: Write a failing test** in `tests/track.test.ts`: `'a finished AI rival stops past the line and turns ghost'`. Run the existing headless AI harness until the rival's `s` passes `finish`. Within 15 s after that: speed < 0.5 m/s, `s - finish < 150`, and the bus is ghost (static-only collision groups).
- [ ] **Step 2:** Run it. Fails.
- [ ] **Step 3:** Implement the driver stop, the ghosting and the session state above.
- [ ] **Step 4:** Run `tests/track.test.ts` and `tests/race.test.ts`. Pass.

### Task 4: Camera, HUD, input, online, e2e

**Files:**
- Modify:
  - `src/camera/cameraRig.ts`: `update(dt, target: CameraTarget, lookBack)`, with `export type CameraTarget = Pick<BusPhysics, 'body' | 'position' | 'heading' | 'preset' | 'speed' | 'boosting' | 'frontLength'>`. `RemoteBus` gets whatever adapter it needs to satisfy it.
  - `src/main.ts`:
    - while spectating, `rig.update(dt, racing.spectateTarget() ?? bus, false)` with the chase view forced;
    - keys ←/→ and A/D call `spectateStep`;
    - pad LB/RB through `Input.press` actions `'watchPrev'` / `'watchNext'`;
    - Esc opens the full results;
    - `__qbus.racing.spectating` exposed in dev.
  - `src/ui/raceHud.ts`:
    - spectator strip `rh-watch`: "Viendo: {name} · {place}º · +{gap} s", with ◀ ▶ buttons;
    - compact live results side panel `rh-live`: rows by place, time or "en carrera";
    - buttons "Ver resultados" and "Terminar ya" (solo only, hidden online).
  - `src/ui/touchControls.ts`: ◀ ▶ buttons while spectating.
  - `src/ui/tutorial.ts`: one race-page line ("Al terminar, ◀ ▶ para ver a los demás").
- Test: `e2e/race.spec.ts`; `e2e/online.race.spec.ts` (assertion only).

- [ ] **Step 1: Write the e2e test** `'after the finish the camera watches a rival and ←/→ switch'`.
  - Use the existing dev hooks to put the player past the finish quickly (look in `e2e/race.spec.ts` for how the finish test does it).
  - `expect.poll(() => __qbus.racing.spectating)` is a rival index.
  - Press ArrowRight: the index changes (with ≥ 2 rivals).
  - Click "Terminar ya": the full results card shows and `spectating` is null.
  - Screenshot `e2e/screenshots/r9-spectate.png`.
- [ ] **Step 2: Online e2e assertion:** the finished client spectates the other client's bus (`spectating` ≠ null) until that one finishes.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Run:**
  - `npx playwright test e2e/race.spec.ts`;
  - `npm run e2e:online`;
  - `npm test`;
  - `npm run build` (each under the flock).
- [ ] **Step 5:** Update the `CLAUDE.md` race bullet with spectating: finishers ghost, solo AI race to the line, "Terminar ya". **STOP for the M1 playtest.**

---

## M2: Río Verde tunnels and stage looks

Common to Tasks 5–8:
- Before starting, run `npx playwright test e2e/tunnels.spec.ts` to keep a *before* set: copy `e2e/screenshots/t*.png` and `f*.png` to the scratchpad. Compare after each task.
- `tests/tunnels.test.ts` stays green. Bore triangles stay wound inward and mound triangles face up (one-sided trimesh rule), and nothing is ever inside the swept space.
- Papallacta and Silante render the same: every change is gated on `biome === 'canyon'` or on `race.tunnels`.

### Task 5: Canyon rock texture

**Files:**
- Create: `src/world/rockTexture.ts`: a procedural canvas texture with layered bands and cracks, built once and cached. In Node tests (no DOM) it returns null, and callers fall back to plain colours.
- Modify: `src/world/trackBuilder.ts` (canyon terrain material: rock texture on slopes over the `cliff` threshold through a world-space triplanar `onBeforeCompile`, blended by the existing slope colour); `src/world/tunnels.ts` (bore and portal rock use it).
- Test: `tests/tunnels.test.ts` (still builds in Node without the texture); e2e screenshots.

- [ ] Implement.
- [ ] Run `npx vitest run tests/tunnels.test.ts tests/track.test.ts`.
- [ ] Run `npx playwright test e2e/tunnels.spec.ts` and compare the screenshots: cliffs and bore show banded rock, the other tracks are unchanged (`e2e/track.spec.ts` shots).

### Task 6: Bore interior

**Files:**
- Modify: `src/world/tunnels.ts`.
- Test: `tests/tunnels.test.ts`.

What to build:
- The cross-section wanders along the length: radius and wall lean vary with `s` from a seeded noise, outward only from today's `boreRing` minimum, so the swept space is untouched.
- Concrete curbs (0.2 m high, 0.5 m wide) with a dark drainage gutter each side. Curbs are part of the static trimesh, wound inward.
- Wet dark streaks in the vertex colours.
- Sodium lamps (warm orange `#ffa040`-ish pools) on one side only.
- Small reflective markers on both walls every 25 m (instanced; they shine back at night like the chevrons).

- [ ] **Step 1: Add a test** `'bore wanders but never enters the swept space'`: sample every 2 m. At each sample the inner surface stays ≥ today's clearance from the deck centre (the existing invariant, at the new geometry), and the cross-section radius has a spread > 0.15 m along the tunnel.
- [ ] **Step 2:** Run. Fails (no spread).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run tests/tunnels.test.ts`. Pass, then the e2e screenshots.

### Task 7: Portals

**Files:**
- Modify: `src/world/tunnels.ts`; `src/world/signAtlas.ts` or a small canvas for the plate.
- Test: `tests/tunnels.test.ts`.

What to build:
- At each portal, a concrete hood: a cut-and-cover box 4–6 m long, arch inside matching the bore, slab on top, slightly darker concrete. It is solid, part of the bore trimesh, wound inward.
- A headwall face around it.
- A name plate "TÚNEL {NAME}" only when `tunnel.name` exists (white on green, canvas).
- Moss streaks down the headwall in vertex colours.
- Hanging ferns and vines over the hood lip: instanced cards, visual only, never below `BORE_TOP + 0.3` over the deck.

- [ ] **Step 1: Test** `'hanging plants never reach into the opening'`: every plant instance's lowest point is ≥ `BORE_TOP + 0.3` over the deck, or lies outside the bore half width + 1 m.
- [ ] **Step 2:** Run. Fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass, then screenshots.

### Task 8: Mountain over each tunnel

**Files:**
- Modify:
  - `src/world/tunnels.ts`: `moundHeight` and the mound ribbon width.
  - `src/world/track.ts`: `MOUND_HALF` grows, or becomes a per-tunnel value computed from the slope.
  - `src/world/trackBuilder.ts`: plants on the mound, now allowed at least 6 m off the bore centreline and outside the portal hoods, using the canyon plant mix.
- Rebuild `data/cities/rioverde.json` only if import data must change (`npx tsx tools/build-city.ts rioverde`). Then confirm papallacta and silante are byte-identical.
- Test: `tests/tunnels.test.ts`.

What to build: the mound is wide enough that its edges meet the cut ground smoothly, with no spine, no vertical side faces and no step > 0.5 m at its edge. It is coloured like the hillside (grass/rock by slope). Ground logic is unchanged: the heightfield stays the cut.

- [ ] **Step 1: Test** `'mound blends into the slope'`. Across each tunnel, sample the mound edge every 6 m: |mound y − terrain y| < 0.5 m at the edge, and the mound's own slope there is < the canyon `cliff` threshold. Also, no plant trunk lies within 6 m of the bore centreline.
- [ ] **Step 2:** Run. Fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Run** `npx vitest run tests/tunnels.test.ts tests/track.test.ts`, then `npx playwright test e2e/tunnels.spec.ts e2e/track.spec.ts`. Compare before/after shots. Check performance: draw calls from `__qbus.perf` within +10% of before on rioverde.
- [ ] **Step 5:** Update the `CLAUDE.md` Río Verde bullet. **STOP for the M2 playtest.**

---

## M3: Circuito La Mariscal

### Task 9: Circuit data at build time

**Files:**
- Create: `src/world/osm/circuit.ts`.
- Modify:
  - `tools/zones.ts`: mariscal gets `circuits` definitions;
  - `tools/build-city.ts`: calls `buildCircuits`;
  - `src/world/cityData.ts`: types.
- Rebuild `data/cities/mariscal.json`. `git diff` must show only the added `circuits` key; confirm with a key-by-key compare script.
- Test: `tests/circuit.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // tools/zones.ts
  circuits?: { id: string; name: string; laps: number; via: [number, number][] }[] // via = street crossings in city metres, in driving order, first = start/finish line's street
  // cityData.ts
  export interface CircuitData {
    id: string; name: string; laps: number;
    /** One lap, closed (last point = first), corners filleted, every ~2 m. */
    points: Vec2[];
    /** Barrier offsets from the centreline at each point (m, both positive): carriageway edge + sidewalk, clipped 0.3 m short of any building. */
    left: number[]; right: number[];
    /** Carriageway half widths at each point (the AI's preferred line stays inside on straights). */
    halfRoad: number[];
    /** Where other roads meet the course: distance along the lap, side, opening width (side-street walls go here). */
    mouths: { s: number; side: 1 | -1; width: number }[];
    /** Start/finish line: distance along the lap. */
    line: number;
  }
  CityData.circuits?: CircuitData[]
  export function buildCircuits(roads: Road[], buildings: Building[], defs: ZoneCircuit[]): CircuitData[]
  ```
- **Route:** the spec's candidate. `via` = Amazonas×Carrión (-141,1), Amazonas×Calama (214,-286), Calama×JL Mera (268,-209), JL Mera×L. García (324,-243), L. García×Reina Victoria (384,-161), RV×Foch (272,-94), Foch×Almagro (333,-12), Almagro×Wilson (237,43), Wilson×RV (180,-36), RV×Carrión (28,153), back to the start.
  - Between consecutive `via` points, follow the named road's polyline: shortest path over road pieces, ignoring `oneway`, never using busways.
  - Fillet each corner with the largest radius that keeps the line inside `left`/`right` minus 1.5 m.
  - Start/finish line on Amazonas 120 m after the Carrión corner.
  - id `zonarosa`, name "Circuito Zona Rosa", laps 3.

- [ ] **Step 1: Tests** in `tests/circuit.test.ts`, on the built `mariscal.json`:
  - closed;
  - lap length within [1500, 2500] m;
  - ≥ 7 corners (heading change > 45° within 40 m);
  - `left`/`right` ≥ `halfRoad` everywhere;
  - minimum course width (`left + right`) ≥ 9 m;
  - every `mouth` lies where a non-course road's centreline comes within its half width of the barrier line;
  - the original roads, buildings and stops arrays are deep-equal to the previous build (load the JSON from `git show HEAD:data/cities/mariscal.json` in the test setup, or snapshot the counts plus a hash).
- [ ] **Step 2:** Run. Fails.
- [ ] **Step 3:** Implement and rebuild.
- [ ] **Step 4:** `npx vitest run tests/circuit.test.ts`. Pass.

### Task 10: Unrolled race track from a circuit; loading

**Files:**
- Create: `src/world/circuitTrack.ts`.
- Modify:
  - `src/world/track.ts`: types and helpers;
  - `src/world/loadCity.ts`: `CIRCUITS` virtual zones, `TRACK_LIST` entry;
  - every `city.race` caller listed by `grep -rn "city.race\|\.race)" src`: `main.ts`, `session.ts`, `backdrop.ts`, `cityBuilder.ts`, `menu.ts`.
- Test: `tests/circuit.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // track.ts
  TrackData.circuit?: { id: string; laps: number; lap: number /* lap length m */; data: CircuitData }
  TrackData.edges?: { left: number[]; right: number[] } // per point barrier offsets, overrides width/2 where present
  export function isCircuit(t: TrackData | null | undefined): boolean
  export function lapOf(t: TrackData, s: number): number // 1-based, clamped to [1, laps]
  export function lapStart(t: TrackData, lap: number): number // s of that lap's line
  // circuitTrack.ts
  export const CIRCUIT_LEAD = 100   // m of course before the line (the grid)
  export const CIRCUIT_RUNOFF = 150 // m past the finish (finishers stop there)
  export function circuitTrack(city: CityData, c: CircuitData): TrackData // points = lead-in + laps × lap + run-off, y from groundHeightAt, start = CIRCUIT_LEAD, finish = start + laps*lap, rails/drops [] , pickups 3 per lap pairs, from/to = c.name / `${c.laps} vueltas`, width = min course width
  // loadCity.ts
  ZONES gets `zonarosa: mariscal json`; loadCity for a circuit zone returns { ...city, race: circuitTrack(city, c) } (shallow copy: never mutate the cached mariscal module), terrain.scale 1
  TRACK_LIST += { id: 'zonarosa', name: 'Circuito Zona Rosa', blurb: 'La Mariscal cerrada: tres vueltas por Amazonas, la Foch y la Reina Victoria entre barreras y público' }
  ```
- **`locateOnTrack` on circuits:**
  - without a hint, search only the lap the caller is known to be on;
  - add an optional `lapHint` parameter, or have callers on circuits always pass the last `s`;
  - document the choice;
  - mountain tracks behave exactly as before.
- **Audit:** every `city.race` branch keeps mountain behaviour but uses the city look on circuits:
  - city built by `buildCity`, not `buildTrack`, plus Task 12's dressing;
  - no `TRACK_FOG`;
  - normal backdrop and city lights;
  - no traffic, pedestrians or `MetroCrowd`;
  - no track traffic option;
  - no landslides, off-road timer, fall watch or mist.

- [ ] **Step 1: Tests:**
  - `'unrolled circuit: s is continuous over the lap seam'`: `trackPose` at `lapStart(2) ± 0.5` is < 1.2 m apart, with heading change < 0.1;
  - `'lapOf'` at the boundaries;
  - `'locate keeps a lap-3 car on lap 3'`: a point at lap-3 s with the hint from lap 3, and the no-hint path the session uses after a fall/R, both return s within lap 3;
  - `'loading zonarosa does not touch mariscal'`: after `loadCity(zonarosa)`, `loadCity(mariscal).race` is undefined.
- [ ] **Step 2:** Run. Fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/circuit.test.ts tests/track.test.ts`, then `npm test`. Pass.

### Task 11: Laps in the race rules, HUD, results, records, menu

**Files:**
- Modify:
  - `src/gameplay/raceGame.ts`: optional `laps?: { count: number; lap: number }` in opts; per racer `lap: number`, `lapTimes: number[]`;
  - `src/ui/raceHud.ts`: "Vuelta 2/3" plus last/best lap, results best-lap column;
  - `src/gameplay/raceRecords.ts` and `src/gameplay/onlineRecords.ts`: optional `lap` best per track, versions unchanged (missing = none);
  - `src/menu/menu.ts`: circuit card (lap map, length, laps, best time, best lap); lobby track list; no "Derrumbes" or "Tráfico" options on circuits;
  - `src/ui/tutorial.ts`: circuit lines (laps; barriers, no ravines);
  - `server/src/room.ts` only if the track id is validated there.
- Test: `tests/race.test.ts`, `tests/records.test.ts` (or the existing records test file), `tests/menu*.test.ts` if present.

**Interfaces:**
- Consumes: Task 10's `isCircuit`, `lapOf`, `lapStart`.
- Produces:
  - `Racer.lap` (1..laps, current);
  - `Racer.lapTimes` (completed laps' times);
  - `RaceEvent | { type: 'lap'; racer: number; lap: number; time: number }`;
  - `bestLap(r: Racer): number | null`.

- [ ] **Step 1: Tests:**
  - lap events fire once per crossing;
  - lap times sum to the race time at the finish;
  - `'a lapped car ranks behind on total distance'`: A at s = start + 2.2 laps, B at start + 1.9 laps gives A ahead, and B's `lap` is 2, never > laps;
  - records keep the best lap separately from the best time, and old saved records without a lap load fine.
- [ ] **Step 2:** Run. Fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/race.test.ts` plus the records test, then `npm test`. Pass.

### Task 12: Circuit dressing (barriers, blocked streets, crowds, clear course)

**Files:**
- Create: `src/world/circuitBuilder.ts`.
- Modify:
  - `src/world/cityBuilder.ts`: an option `keepOut?: (p: Vec2) => boolean`. Trees, lamps, props, shelters, stops, Metro entrances and signal poles inside the course are skipped; only when racing a circuit.
  - `src/world/spectators.ts`: crowds behind fences.
  - `src/world/signalBuilder.ts` / `src/gameplay/trafficLights.ts`: lights on the course flash amber.
- Test: `tests/circuit.test.ts`.

What to build:
- Concrete jersey barriers (0.8 m, light grey with red/white top stripes every few metres) along `left`/`right` for the whole lap, one smooth frictionless `railSolid` trimesh per side run. A run breaks only at mouths, and the mouth gets its own wall.
- Side-street mouths: barrier wall + 2 m mesh fence across the opening, set back to the barrier line.
- Sidewalk fences behind the barriers where the crowd stands.
- Crowds (`crowdSpots`-style placement on the sidewalk strip behind the fence): dense ±60 m around the line, at Plaza Foch and in the Calama–JL Mera–L. García chicane, sparse elsewhere.
- SALIDA/META gantry over the line (reuse the track gantry code).
- Everything is merged static tiles or instanced.

- [ ] **Step 1: Tests:**
  - `'course is clear'`: ray probes along the lap every 2 m, across the course, at 0.6/1.5/3.3 m, hit nothing static before the barrier offsets (kerbs excepted: start the rays 0.2 m up);
  - `'every mouth is closed'`: a ray along each mouth's road from outside hits a solid within the opening width;
  - `'barriers are continuous'`: no gap > 0.3 m along each side except at mouths.
- [ ] **Step 2:** Run. Fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/circuit.test.ts`. Pass. Confirm `tests/lanesClear.test.ts` (Mariscal without the circuit) is unchanged.

### Task 13: AI on the circuit; streets that fit every vehicle

**Files:**
- Modify:
  - `src/gameplay/raceDriver.ts`: speed profile and line use `edges` where present; corners may cut over the inner sidewalk, but stay ≥ 1 m off the barrier;
  - `tools/sim-race.ts`: accepts `zonarosa`;
  - `tools/zones.ts` (`via`): only if a corner fails;
  - `tests/track.test.ts`: zonarosa in the invariant list (grid fits six, AI finish).

- [ ] **Step 1:** For every vehicle in `VEHICLES` (articulado, gusanito, trailer, popular, buseta, interparroquial, ae86), run `npx tsx tools/sim-race.ts zonarosa <vehicle> hard` and `normal`, one at a time. Each must finish 3 laps with 0 rescues.
- [ ] **Step 2:** A corner that fails for a vehicle after a line/speed fix: replace that leg with a wider street from the spec's list (7.6 m streets: Juan León Mera, Reina Victoria, Veintimilla, Colón, the 6 de Diciembre carriageways, the Amazonas south end). Rebuild (Task 9 tests still pass) and rerun Step 1.
- [ ] **Step 3:** Pin per-vehicle lap times in `tests/track.test.ts` like the other tracks. Add the grid test on zonarosa: six 19.6 m gusanitos fit in `CIRCUIT_LEAD`; raise `CIRCUIT_LEAD` if not.
- [ ] **Step 4:** Run `npx vitest run tests/track.test.ts`. Pass.

### Task 14: Online, e2e, docs

**Files:**
- Modify:
  - `e2e/track.spec.ts`: zonarosa: grid, a lap, screenshots at the line, the chicane and Plaza Foch;
  - `e2e/race.spec.ts`: lap counter shows "Vuelta 1/3";
  - `src/menu/menu.ts` lobby (if not done in Task 11);
  - `CLAUDE.md`: new circuit bullet, with how to add another circuit (a `circuits` entry in `tools/zones.ts` plus a rebuild);
  - `src/world/CLAUDE.md`: `circuits` data;
  - the Créditos text needs no change (same OSM area).

- [ ] **Step 1:** Run `npx playwright test e2e/track.spec.ts e2e/race.spec.ts`. Pass. Look at the screenshots.
- [ ] **Step 2:** Run `npm run e2e:online` with the room track set to zonarosa in one added assertion. Pass.
- [ ] **Step 3: Full verification, one at a time:**
  - `npm test`;
  - `npm run build`;
  - `npm run test:underpass`;
  - `npm run test:rooms`;
  - `npm run e2e`.

  All green. `git diff --stat data/cities` shows papallacta and silante untouched.
- [ ] **Step 4: STOP for the M3 playtest.**
