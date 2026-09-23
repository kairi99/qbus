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
- `npx tsx tools/fetch-osm.ts [zone]`: download a zone from Overpass into `data/raw/` (servers are flaky; mirrors are tried in order)
- `npx tsx tools/build-city.ts [zone]`: raw OSM + Copernicus DEM → `data/cities/<zone>.json` (zones live in `tools/zones.ts`)
  The DEM tile is not in git (41 MB): `curl -o data/raw/copernicus-S01-W079.tif https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S01_00_W079_00_DEM/Copernicus_DSM_COG_10_S01_00_W079_00_DEM.tif`

## Conventions
- Chassis/physics space: +X forward, +Y up, +Z right. Heading 0 = facing +X.
- Physics code (`src/vehicle/bus.ts`, `src/physics/`) must not import three.js so it stays testable in Node.
- All driving feel lives in `data/buses/*.json`; tune there, not in code.
- UI text in Spanish (Quito slang welcome); code and comments in English.
- Playwright uses a manually downloaded Chrome at `~/.cache/qbus-chrome/` (the CDN install times out here) with SwiftShader WebGL.
- `window.__qbus` exposes game state in dev builds for e2e tests.
- Cities are `CityData` (`src/world/cityData.ts`): `procCity.ts` generates one, `osm/import.ts` imports a real one, `cityBuilder.ts` renders it. URL: default `La Mariscal`; `?city=grid` or `?seed=N` for the generated city; `?hills=N` scales real elevation (default 1.3).
- Ground: `terrainHeight` interpolates the same two triangles per cell as the rendered terrain mesh and Rapier's heightfield (diagonal (r, c+1)–(r+1, c)); keep all three in sync. Road, sidewalk and junction surfaces are draped vertex by vertex over the terrain (`DRAPE` spacing), never kept level, or the ground pokes through (`tests/groundLayers.test.ts`).
- Coordinates for imported cities: x = east, z = south, meters from the bbox center. Heights are city-relative (lowest point in the city = 0). Anything placed in the world must use `groundHeightAt(city, p)`, never y = 0.
- `roadGraph.ts` handles any layout: polyline edges, one-way streets, intersection clustering, paved junction hulls, and `drivable` (largest strongly connected part, with map exits joined to entries). Cars leaving the map are recycled near the bus.
- Menus (`src/menu/`): `/` shows the title/setup menu; the game starts only with `?play=1` (from the menu) or a direct `?city=`/`?seed=`. Choices and settings live in localStorage (`settings.ts`). Buses are listed in `src/vehicle/buses.ts`; every preset must pass `tests/bus.test.ts`. Routes come from `routesFor(city)` (`src/gameplay/routes.ts`).
- Navigation (`src/gameplay/navigation.ts`): Dijkstra over the directed lane graph, so guidance and route building respect one-way streets. The in-game arrow and minimap follow the legal path (`session.path`), never a straight line to the stop. Routes only keep stops whose legs can be driven legally without big detours.
- Map data is ODbL: keep the on-screen OpenStreetMap credit (`city.attribution`).
- Headless Chrome renders with software WebGL (~5–20 fps), which slows the simulation (frame dt is capped at 0.1 s). In e2e, poll for conditions (`expect.poll`) rather than fixed sleeps.
- Traffic/pedestrians: `traffic.ts` and `pedestrians.ts` are pure sims (unit-tested for overlaps and gridlock on both cities); `trafficBodies.ts` makes Rapier bodies chase the sim poses (height and pitch from the terrain) and releases a car to free physics when the bus hits it. Junctions admit one incoming edge at a time; there is no forced entry (stuck cars are recycled instead). Pedestrians walk sidewalk strips derived from the road graph and have no colliders by design.
