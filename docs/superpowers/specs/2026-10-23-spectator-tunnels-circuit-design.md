# Spectator camera, Río Verde tunnel looks, Circuito La Mariscal: design

Three independent add-ons. Order: 1 (spectator), 2 (tunnels), 3 (circuit). Stop after each one for a playtest.

## 1. Watching the others after you finish

**Why:** once the player crosses the line, the race is over for them. Today they get 4 s of photo-finish camera (`FINISH_CAM`) and then the results card. Online they wait with nothing to watch until the others finish. The user wants to switch between the other racers' cameras so they don't get bored.

**Behaviour (agreed with the user):**
- Finish line, then the photo-finish camera as today, then a spectator chase camera on the next racer still driving.
- ← / → (keyboard), LB / RB (pad) and two arrow buttons (touch) cycle through the racers still out: AI rivals, and remote players online. A small strip shows the watched racer's name, current place and gap to the one ahead.
- The results card becomes a compact side panel that updates live as each racer finishes. "Ver resultados" or Esc opens the full card at any time.
- Solo: AI rivals keep racing to the real line, so they get real times instead of "≈" estimates. A "Terminar ya" button ends it and fills the rest with estimates, as today.
- Online: same with remote buses and the host's AI. Online is already `estimate: false`.

**Constraints:**
- Spectating never changes the simulation. The player's own bus sits parked past the line. Today's behaviour for rivals after the player finishes must not regress: they keep driving and don't pile into the parked bus.
- Retired, offline or ghost remote racers can be watched only while their bus exists. A racer who finishes drops out of the cycle once their own photo-finish passes.
- Once everyone is done, the full results card opens on its own.

**Left to the builder:** HUD layout of the strip and panel, the chase camera parameters for another vehicle (reuse `CameraRig`), and how the camera eases between targets.

## 2. Río Verde tunnels and stage looks

**Why:** the user finds the tunnels "very artificial". From the e2e screenshots (`e2e/screenshots/t*-*.png`):
- the mound is a thin rock spine along the road, a wall rather than a mountain;
- the portal is a flat grey slab with big flat facets;
- the bore is a perfectly regular, evenly coloured pipe with no curb, gutter or wet patches, and walls the same colour as the ceiling;
- the cliffs beside the road are big flat grey planes.

**Agreed changes:**
- **Mountain over each tunnel:** widen the mound until it blends into the hillside (no spine), covered in grass, shrubs and trees like the slope around it, so each tunnel reads as boring through a spur. Ground logic must still never see a tunnel (see the `CLAUDE.md` tunnel notes). Plants on the mound must not hang into the road or the portal opening.
- **Portals:**
  - a concrete hood (short cut-and-cover section) sticking out a few metres;
  - a headwall with a name plate showing the OSM tunnel name (e.g. "TÚNEL CHIROSINGUNA"; only if OSM has a name, else no plate);
  - moss streaks, and ferns and vines hanging over the hood edge.
- **Inside the bore:**
  - raw rock whose cross-section wanders along the length (no perfect rings), still never inside the swept space;
  - wet dark streaks;
  - concrete curbs with a drainage gutter each side;
  - orange sodium lamps on one side;
  - reflective markers on the walls.
- **Rock texture:** a procedural rock texture with layered bands (canvas or shader, no image files needed), on the bore, portal rock and the steep cliff faces of the whole stage (canyon biome slope colours).

**Constraints:**
- Bore and mound colliders keep the one-sided winding rules.
- Draw calls stay roughly where they are: instanced plants, merged static tiles.
- Papallacta and Silante must look identical; their JSON stays byte-identical if import changes.
- `tests/tunnels.test.ts` and `e2e/tunnels.spec.ts` stay green; take before/after screenshots.

**Left to the builder:** exact dimensions, colours, texture technique and plant density.

## 3. Circuito La Mariscal (closed street circuit, 3 laps)

**Why:** a twisty city race as a change from the mountain point-to-point tracks. If it works, more Mariscal circuits follow, so a circuit must be data: a named list of streets or waypoints. Adding the next circuit should not need new code.

**Agreed with the user:**
- Twisty, 3 laps.
- Closed course: barriers along the route, side streets blocked, people behind the barriers. No traffic, no pedestrians.
- The builder picks the streets.
- Any street too narrow for the 18 m articulated bus (and the 17.7 m truck) gets replaced by another.

**Route, starting candidate** (coordinates are Mariscal city metres, x/z, measured at the street crossings in `data/cities/mariscal.json`):
- Start/finish and main straight on **Av. Río Amazonas**, Jerónimo Carrión (-141,1) to José Calama (214,-286), about 450 m.
- Calama, then Juan León Mera, then Lizardo García: a chicane of three tight corners.
- **Reina Victoria** down to Mariscal Foch (272,-94), past Plaza Foch.
- **Foch** to Diego de Almagro (333,-12).
- **Almagro** to Wilson (237,43).
- **Wilson** to Reina Victoria (180,-36).
- **Reina Victoria** down to Jerónimo Carrión (28,153).
- **Carrión** back to Amazonas.
- About 1.7 km a lap, 9 corners. Every street is driven both ways regardless of its one-way tag.

**Width rule:**
- Carriageways here are 6–7.6 m, and each sidewalk is 3 m (`SIDEWALK_WIDTH`, curb 0.15 m). The course is the carriageway plus both sidewalks: barriers stand at the back of the sidewalk where buildings allow, giving about 12 m wall to wall.
- Street furniture inside the course is left out in circuit mode: trees, poles, signal poles, shelters, props.
- Acceptance: every vehicle, the articulado and truck included, laps it under AI at race pace without a rescue. Any leg or corner that fails is swapped for a wider street from the list below. The 7.6 m streets here are Juan León Mera, Reina Victoria (parts), Veintimilla, Colón, the 6 de Diciembre carriageways, and the Amazonas south end (10.9 m).
- The finished lap should still be twisty: at least 7 corners and 1.5–2.5 km.

**What's on the course:**
- Concrete jersey barriers on both sides: solid, smooth, frictionless like the track guardrails (`railSolid`).
- Barrier walls with fences across every side-street mouth.
- Crowds behind fences on what's left of the sidewalks: dense at the start/finish, Plaza Foch and the chicane, thinner elsewhere. Reuse `world/spectators.ts`.
- SALIDA/META gantry on Amazonas.
- Traffic lights on the course flash amber.
- The rest of the city stays as built (buildings, parks, far view). No traffic or pedestrians anywhere during the race.

**Race rules:**
- Same as the mountain tracks: grid behind the line on Amazonas, launch, AI rivals (`RaceDriver` with a corner line the AI can follow), nitro pickups, slipstream, R reset with the wait and the ghost, rain, time of day, online rooms, and the spectator camera from part 1.
- New: laps.
  - The `RaceGame` progress wraps per lap; HUD shows "Vuelta 2/3" and the last and best lap times.
  - The results card shows each racer's best lap.
  - Records keep the best race time and best lap (solo and online records, per circuit).
  - Lapping a slower car must work: places come from total distance.
- Not on circuits: landslides, off-road timer, fall watch (nothing to fall off), mountain mist, track traffic option.
- Menu: a "Circuito La Mariscal" card in Carrera (map of the lap, length, laps, best time and best lap) and in the online lobby's track list.

**Constraints:**
- The mountain tracks' behaviour and JSON stay unchanged.
- Route shifts and free roam in Mariscal are unchanged; the circuit dressing exists only in circuit races.
- Names follow the existing rules: real street names, no companies.
- The circuit needs its own minimap view. The progress strip shows laps.

**Left to the builder:**
- How a circuit is stored: a list of streets or waypoints in zone data, turned into `race` data at build time or at load.
- How the racing line is rounded at corners.
- Barrier and fence models.
- Crowd density.
- Pickup spacing: about 2–3 per lap.
- Grid layout on the 7.6 m Amazonas carriageway, two lanes, with the sidewalks as part of the course.

## Calls made after the builder check (designer's calls, not the user's)

1. **Sidewalks are drivable on the circuit.**
   - The curbs stay as real 0.15 m kerbs. Buses climb them; that's street-circuit flavour, and no flattening is done.
   - Track width for locate, AI and barrier placement is curb plus sidewalk to the barrier.
   - The AI's racing line stays on the carriageway on straights and may cut over the inner sidewalk at corners.
2. **Circuit data.**
   - A circuit is a list of street waypoints in `tools/zones.ts`, stored as an optional `circuits` field in `mariscal.json`.
   - At race load it becomes a closed `TrackData`-like object with `laps`, and `s` wraps modulo the lap length.
   - `locateOnTrack` searches near the previous `s` with a looped hint.
   - Route shifts and free roam ignore the field. Mountain JSON stays unchanged.
3. **Finishers turn ghost.**
   - After the line, every finisher (player, AI, remote) eases to a stop and turns ghost.
   - The player's bus is hidden while spectating.
   - Lapped and still-racing cars drive through, never into a parked bus.
   - "Everyone is done" = every racer finished or retired; offline seats count as done after their grace.
4. **Mound.** Only Río Verde's JSON may change. The mound widens as its own mesh and collider above the cut ground. The heightfield and ground logic are unchanged.
5. **Rock texture:** canyon biome only. Papallacta and Silante render identically.
6. **Name plate** only when OSM gives the tunnel a name.
7. **Route:** the builder picks replacement streets using the width rule. The route listed above is a candidate, not binding.
