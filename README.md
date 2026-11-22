# MONEY LINE

**Dig Deep. Lay Track. Strike Rich.** A railroad, mining and terrain-engineering game set on an 1890 frontier. by HaveAnApp.

You start in the city of Prosperity with $18,000, a bank credit line, one small tank engine, four ore hoppers and a gold claim across the river. Draw a line to the claim, borrow what the contract needs, open the mine, haul ore to market, raise a stamp mill, and decide what the next ridge is worth.

## Run it

```
npm install
npm run dev          # play at http://localhost:5173
npm test             # 193 deterministic simulation tests (Vitest)
npm run build && npm run preview &
npm run test:e2e     # the whole mining-to-market loop through the real UI (Playwright + Chromium)
```

## What is playable (first vertical slice)

| System | In the game |
|---|---|
| World | One seeded 128×128 valley (seed 1890): city, river, forested foothills, the Sawtooth massif, a western ridge with a single saddle, three deposits (gold owned, silver rumoured, coal hidden). |
| Terrain | Excavate, fill, grade, blast and clear with a priced brush. Soil over bedrock; rock must be blasted. Spoil, stone and timber are kept and reused. Every change persists and shows as worked earth. |
| Railroad | Draw the line on the map with a finger or the mouse, from the terminal or any track you own; the price runs beside your hand. Carry on from the end, bend it by its markers, or let the surveyor propose a route. The engineer designs a grade line within 3.5%, decides cuts, embankments, trestles and tunnels, and prices each item. Crews build it day by day and reshape the ground as they go. Lines can be lifted. |
| Trains | Real vehicles on the built geometry. Tractive effort against grade sets how many hoppers an engine can take; single track carries one train at a time. Loading, hauling, unloading and sale are all simulated; nothing teleports. |
| Mining | Surveys narrow a reserve estimate toward a truth fixed by the seed. Mines need a held claim, a level pad and nearby track. Deposits run out. |
| Processing | A stamp mill turns ore into concentrate (one-eighth the weight, most of the value) at a daily cost. |
| Economy | Cash, debt, a credit line that grows with assets, daily interest, operating costs, monthly profit and loss, a moving market, overdraft, insolvency, one restructuring, receivership. |
| Progression | Nine objectives through the first loop, six improvements, a second locomotive class, more hoppers. |
| Saves | Autosave to IndexedDB (localStorage fallback), versioned schema, exact round trip. |

Not in this slice yet: fog of war, passenger and contract freight, junction signalling beyond whole-route reservation, day/night, multiple save slots, campaign scenarios, sandbox settings.

## Architecture

```
src/sim/      pure, deterministic simulation: no DOM, no three.js
  config.ts     every gameplay number (resources, engines, costs, upgrades)
  worldgen.ts   seeded heightmap, soil, forest, river, deposits
  terrain.ts    brush operations, costs, protected ground
  route.ts      curve layout, grade-line design, quantities, itemised price
  stroke.ts     a hand-drawn stroke turned into waypoints a train can follow
  autoroute.ts  the surveyor's proposed corridor (A* over the heightmap)
  rail.ts       track graph, construction jobs, earthworks, pathfinding
  trains.ts     dispatch, tractive effort, movement, loading, sale
  facilities.ts mines, mills, platforms
  geology.ts    prospecting, surveys, claims
  economy.ts    ledger, loans, interest, market, insolvency
  objectives.ts the guided path
  sim.ts        fixed tick (20 per game day) and the single command entry point
  save.ts       versioned save schema
src/render/   three.js view of the state: chunked terrain, instanced forest, track, models, smoke, camera, picking
src/ui/       React HUD and panels; src/store.ts (Zustand) holds interface state only
src/audio/    produced samples plus a synthesised whistle and exhaust
src/persist/  IndexedDB
tests/        Vitest: terrain, economy, affordability, rail, trains, works, cargo conservation, geology, saves, exploits, full loop
e2e/          Playwright: the loop through the real interface
```

Key decisions:

- **Terrain** is a quantised heightmap (one level ≈ 3 m, one cell ≈ 30 m) with a soil-depth layer, not voxels: fast to edit, cheap to save, and trains only ever need a height.
- **Track** is a graph of nodes and edges; each edge stores its own sampled 3D polyline, so a train's trip is a copy of real geometry and can never cross a gap.
- **Time** is a fixed tick independent of frame rate; money only moves in a tick or a validated command. Rendering interpolates.
- **Determinism**: the world, the market and every discovery derive from the seed. Reloading never rerolls anything.

Sound effects, ambience and music were generated for this project (see `assets/audio/*.license.json`). Fonts are Abril Fatface and Archivo (SIL OFL 1.1, `public/fonts`).
