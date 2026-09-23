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

## Conventions
- Chassis/physics space: +X forward, +Y up, +Z right. Heading 0 = facing +X.
- Physics code (`src/vehicle/bus.ts`, `src/physics/`) must not import three.js so it stays testable in Node.
- All driving feel lives in `data/buses/*.json`; tune there, not in code.
- UI text in Spanish (Quito slang welcome); code and comments in English.
- Playwright uses a manually downloaded Chrome at `~/.cache/qbus-chrome/` (the CDN install times out here) with SwiftShader WebGL.
- `window.__qbus` exposes game state in dev builds for e2e tests.
- Cities are `CityData` (`src/world/cityData.ts`): `procCity.ts` generates one, `cityBuilder.ts` renders it. `?seed=N` in the URL picks the procedural city.
- Headless Chrome renders with software WebGL (~5–20 fps), which slows the simulation (frame dt is capped at 0.1 s). In e2e, poll for conditions (`expect.poll`) rather than fixed sleeps.
- Traffic/pedestrians: `traffic.ts` and `pedestrians.ts` are pure sims (unit-tested for overlaps and gridlock); `trafficBodies.ts` makes Rapier bodies chase the sim poses and releases a car to free physics when the bus hits it. Pedestrians have no colliders by design.
