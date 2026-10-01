# QBus

Arcade "Crazy Taxi"-style game: drive a reckless Quito bus, pick up passengers at stops.
Browser game: Three.js (rendering) + Rapier (`@dimforge/rapier3d-compat`, physics), TypeScript, Vite.
Full roadmap (milestones M0–M6): `~/.claude/plans/pasted-content-id-88c6-i-want-synchronous-wren.md`.

## Commands
Node comes from nvm: run `. ~/.nvm/nvm.sh` first in non-login shells.
- `npm run dev`: dev server on http://localhost:5173
- `npm test`: Vitest unit tests (`tests/`), physics runs headless in Node
- `npm run e2e`: Playwright smoke test (`e2e/`), writes screenshots to `e2e/screenshots/`
- `npm run build`: typecheck + production build
- `npx tsx tools/fetch-osm.ts [zone] [osm|routes|stations|areas]`: download a zone from Overpass into `data/raw/` (`<zone>.osm.json`, `.routes.json`, `.stations.json`, `.areas.json`; all by default; servers are flaky, mirrors are tried in order)
- `npx tsx tools/build-city.ts [zone]`: raw OSM + Copernicus DEM → `data/cities/<zone>.json` (zones live in `tools/zones.ts`)
  The DEM tile is not in git (41 MB): `curl -o data/raw/copernicus-S01-W079.tif https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S01_00_W079_00_DEM/Copernicus_DSM_COG_10_S01_00_W079_00_DEM.tif`

## Conventions
- Chassis/physics space: +X forward, +Y up, +Z right. Heading 0 = facing +X.
- Physics code (`src/vehicle/bus.ts`, `src/physics/`) must not import three.js so it stays testable in Node.
- All driving feel lives in `data/buses/*.json` (buses, and the AE86 car with `kind: "car"`, free roam only); tune there, not in code (including `nitro`: extra acceleration and how far past top speed it pushes). The nitro tank rules (1.5 s full burn, a burst needs half a tank, refilled only by drifting and close calls) are gameplay, in `src/gameplay/nitro.ts`.
- UI text in Spanish (Quito slang welcome); code and comments in English.
- Playwright uses a manually downloaded Chrome at `~/.cache/qbus-chrome/` (the CDN install times out here) with SwiftShader WebGL.
- `window.__qbus` exposes game state in dev builds for e2e tests.
- City data, terrain, the road graph, and OSM import (bridges/underpasses, rapid transit, map edge, campus walls, far view): see `src/world/CLAUDE.md`.
- Settings (`src/menu/settings.ts`) carry a version: when a default changes, bump it and decide what an old saved value means (version 2: a saved 1.3 hills was the old default, so it becomes the new one, "Reales").
- Menus (`src/menu/`): `/` shows the title/setup menu; the game starts only with `?play=1` (from the menu) or a direct `?city=`/`?seed=`. Choices and settings live in localStorage (`settings.ts`). Buses are listed in `src/vehicle/buses.ts`; every preset must pass `tests/bus.test.ts`. Routes come from `routesFor(city)` (`src/gameplay/routes.ts`).
- Navigation (`src/gameplay/navigation.ts`): Dijkstra over the directed lane graph, so guidance and route building respect one-way streets. The in-game arrow and minimap follow the legal path (`session.path`), never a straight line to the stop. Routes only keep stops whose legs can be driven legally without big detours. The menu map draws each leg's legal path (`routePaths`), and the bus starts on the lane leading into the first stop, facing it (`startPose`, via `Navigator.behind`).
- Map data is ODbL: keep the on-screen OpenStreetMap credit (`city.attribution`).
- Headless Chrome renders with software WebGL (~5–20 fps), which slows the simulation (frame dt is capped at 0.1 s). In e2e, poll for conditions (`expect.poll`) rather than fixed sleeps.
- Traffic/pedestrians: `traffic.ts` and `pedestrians.ts` are pure sims (unit-tested for overlaps and gridlock on both cities); `trafficBodies.ts` makes Rapier bodies chase the sim poses (height and pitch from the terrain) and releases a car to free physics when the bus hits it. Junctions admit one incoming edge at a time; there is no forced entry (stuck cars are recycled instead). Pedestrians walk sidewalk strips derived from the road graph and have no colliders by design. Traffic in its lane is in collision group TRAFFIC and ignores the STATIC world (`markStatic` in `physics/world.ts`, called at the end of `buildCity`): the sim keeps cars on the road, so seams in ramps or walls can't knock them off; a car hit by the bus becomes a wreck that collides with everything (`tests/interchanges.test.ts` runs traffic through both interchanges).
- Free roam (`?play=1&mode=free&city=&bus=`): `GameSession` with `route: null` (`game` is null): traffic, people and nitro, but no stops, clock, fares or trick money; starts at `freeStartPose`. The menu's "Paseo libre" mode offers `VEHICLES` (buses + `CARS`); a route shift always uses a bus. Cars have their own model (`vehicle/carBody.ts`) and a `cockpit.seat` in the preset.
- Phones/tablets (`(pointer: coarse)`): `ui/touchControls.ts` draws on-screen controls that write `Input.touch` (left thumb steers relative to where it lands, right thumb pedals/nitro/handbrake, small buttons send `Input.press` actions); `body.touch` CSS moves the HUD out of the thumbs' way and hides key hints (`.keys-only`/`.touch-only`). `e2e/mobile.spec.ts` drives on an emulated phone. iPhone Safari ignores `user-scalable=no` and has no fullscreen API: `stopBrowserGestures` cancels touches on the controls and pinches (two thumbs look like one) and undoes any zoom that slips through; the canvas is sized from its own box (a `ResizeObserver`), never `100vw/100vh`; HUD and controls keep clear of the notch with `env(safe-area-inset-*)`; `public/manifest.webmanifest` makes "Add to Home Screen" open full screen and sideways.
- Hosting: `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub Pages on each push to master (`base: './'` in `vite.config.ts`, so it runs from any sub-path). Pages needs the repo public, or a paid plan for a private one. github.com is blocked from the dev VM: push from the host.
