import { describe, expect, it } from 'vitest';
import { BLAST, TERRAIN, WORLD } from '../src/sim/config';
import { mulberry32 } from '../src/sim/rng';
import { exec, newGame } from '../src/sim/sim';
import { heightAt, planTerrainOp, remoteFactor, type TerrainOp, type TerrainPlan, type TerrainTool } from '../src/sim/terrain';
import type { GameState, Result } from '../src/sim/types';
import { K_BRIDGE, K_TUNNEL } from '../src/sim/types';
import { ci, vi } from '../src/sim/worldgen';
import { N, SEED, TPD, countDiff, expectSame, expectUnchanged, findBranch, finishLine, must, roundTrip, runTicks, snapshot, world } from './helpers';

const wetVertex = (s: GameState, x: number, z: number) => {
  for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
    const cx = x + dx, cz = z + dz;
    if (cx >= 0 && cz >= 0 && cx < N && cz < N && s.water[ci(cx, cz)]) return true;
  }
  return false;
};
const forestAround = (s: GameState, x: number, z: number) => {
  for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) if (s.forest[ci(x + dx, z + dz)]) return true;
  return false;
};
/** First open-ground vertex (no lock, no water, no trees beside it) that satisfies the predicate. */
function findVertex(s: GameState, pred: (h: number, soil: number, x: number, z: number) => boolean) {
  for (let z = 6; z < N - 6; z++) for (let x = 6; x < N - 6; x++) {
    const i = vi(x, z);
    if (s.locked[i] || wetVertex(s, x, z) || forestAround(s, x, z)) continue;
    if (pred(s.height[i], s.soil[i], x, z)) return { x, z, i };
  }
  throw new Error('no such vertex in this world');
}
const dot = (tool: TerrainTool, v: { x: number; z: number }, target?: number): TerrainOp => ({ tool, x: v.x, z: v.z, radius: 0.5, target });
const run = (s: GameState, op: TerrainOp) => exec(s, { type: 'terrain', op }) as Result<TerrainPlan>;

describe('terrain excavation costs', () => {
  it('excavating soil costs $22 per level, scaled by remoteness, and the spoil is kept', () => {
    const s = newGame(SEED);
    const v = findVertex(s, (h, so) => so >= 1.5 && h > 3);
    const remote = remoteFactor(s, v.x, v.z);
    const h0 = s.height[v.i], so0 = s.soil[v.i], cash0 = s.finance.cash;
    const r = run(s, dot('excavate', v));
    expect(r.ok).toBe(true);
    const cost = Math.round(TERRAIN.brushStep * TERRAIN.excavateSoil * remote);
    expect(cost).toBeGreaterThan(0);
    expect(r.value!.cost).toBe(cost);
    expect(r.value!.soilCut).toBeCloseTo(0.5, 9);
    expect(r.value!.rockCut).toBe(0);
    expect(cash0 - s.finance.cash).toBe(cost);
    expect(s.height[v.i]).toBeCloseTo(h0 - 0.5, 4);
    expect(s.soil[v.i]).toBeCloseTo(so0 - 0.5, 4);
    expect(s.materials.spoil).toBeCloseTo(0.5, 9);
    expect(s.finance.period.by.terrain).toBe(cost);
    expect(s.finance.totals.capital).toBe(cost);
    expect(s.stats.terrainEdits).toBe(1);
  });

  it('blasting rock costs $118 per level — more per level than digging soil — and yields stone', () => {
    const s = newGame(SEED);
    const rock = findVertex(s, (h, so) => so === 0 && h > 4);
    const soil = findVertex(s, (h, so) => so >= 1.5 && h > 3);
    const cash0 = s.finance.cash;
    const h0 = s.height[rock.i];
    const b = run(s, dot('blast', rock));
    expect(b.ok).toBe(true);
    const levels = TERRAIN.brushStep * 1.6;
    expect(b.value!.rockCut).toBeCloseTo(levels, 9);
    expect(b.value!.soilCut).toBe(0);
    expect(b.value!.cost).toBe(Math.round(levels * TERRAIN.blastRock * remoteFactor(s, rock.x, rock.z)));
    expect(cash0 - s.finance.cash).toBe(b.value!.cost);
    expect(s.height[rock.i]).toBeCloseTo(h0 - levels, 4);
    expect(s.soil[rock.i]).toBe(0);
    expect(s.materials.stone).toBeCloseTo(levels, 9);
    expect(s.materials.spoil).toBe(0);
    expect(s.events.at(-1)).toEqual({ type: 'blast', x: rock.x, z: rock.z });

    const e = run(s, dot('excavate', soil));
    expect(e.ok).toBe(true);
    const perLevelRock = b.value!.cost / b.value!.remote / b.value!.rockCut;
    const perLevelSoil = e.value!.cost / e.value!.remote / e.value!.soilCut;
    expect(perLevelRock).toBeGreaterThan(perLevelSoil * 4);
    expect(TERRAIN.blastRock).toBeGreaterThan(TERRAIN.excavateSoil);
  });

  it('a shot through thin soil pays the soil rate for the soil and the rock rate for the rock', () => {
    const s = newGame(SEED);
    const v = findVertex(s, (h, so) => so >= 0.1 && so <= 0.6 && h > 4);
    const so0 = s.soil[v.i];
    const plan = planTerrainOp(s, dot('blast', v));
    expect(plan.soilCut).toBeCloseTo(so0, 5);
    expect(plan.rockCut).toBeCloseTo(0.8 - so0, 5);
    expect(plan.cost).toBe(Math.round((plan.soilCut * TERRAIN.excavateSoil + plan.rockCut * TERRAIN.blastRock) * plan.remote));
    const r = run(s, dot('blast', v));
    expect(r.value!.cost).toBe(plan.cost);
    expect(s.soil[v.i]).toBe(0);
    expect(s.materials.spoil).toBeCloseTo(so0, 5);
    expect(s.materials.stone).toBeCloseTo(0.8 - so0, 5);
  });

  it('picks and shovels are refused on bedrock: only blasting moves it', () => {
    const s = newGame(SEED);
    const rock = findVertex(s, (h, so) => so === 0 && h > 4);
    const before = snapshot(s);
    const r = run(s, dot('excavate', rock));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Bedrock/);
    expectUnchanged(s, before);
    // grading down into rock is refused the same way
    const g = run(s, dot('grade', rock, s.height[rock.i] - 1));
    expect(g.ok).toBe(false);
    expect(g.error).toMatch(/Bedrock/);
    expectUnchanged(s, before);
    expect(run(s, dot('blast', rock)).ok).toBe(true);
  });

  it('digging stops at bedrock once the soil is gone', () => {
    const s = newGame(SEED);
    const v = findVertex(s, (h, so) => so >= 0.9 && so <= 1.2 && h > 4);
    const so0 = s.soil[v.i], h0 = s.height[v.i];
    let dug = 0, guard = 0;
    for (; guard < 10; guard++) { const r = run(s, dot('excavate', v)); if (!r.ok) { expect(r.error).toMatch(/Bedrock/); break; } dug += r.value!.soilCut; }
    expect(guard).toBeLessThan(10);
    expect(dug).toBeCloseTo(so0, 4);
    expect(s.soil[v.i]).toBe(0);
    expect(s.height[v.i]).toBeCloseTo(h0 - so0, 4);
  });

  it('giant powder takes 40% off the rock rate and nothing off the soil rate', () => {
    const a = newGame(SEED), b = newGame(SEED);
    b.upgrades.giant_powder = true;
    const rock = findVertex(a, (h, so) => so === 0 && h > 4);
    const soil = findVertex(a, (h, so) => so >= 1.5 && h > 3);
    const pa = planTerrainOp(a, dot('blast', rock)), pb = planTerrainOp(b, dot('blast', rock));
    expect(pb.cost).toBe(Math.round(0.8 * TERRAIN.blastRock * BLAST.rockDiscount * pb.remote));
    expect(pb.cost).toBeLessThan(pa.cost);
    expect(planTerrainOp(b, dot('excavate', soil)).cost).toBe(planTerrainOp(a, dot('excavate', soil)).cost);
  });

  it('fill is cheap from spoil on hand and dear when the material is brought in', () => {
    const s = newGame(SEED);
    const v = findVertex(s, (h, so) => so >= 1.5 && h > 3);
    const remote = remoteFactor(s, v.x, v.z);
    const h0 = s.height[v.i], so0 = s.soil[v.i];
    // no spoil: all borrowed
    let cash = s.finance.cash;
    const borrowed = run(s, dot('fill', v));
    expect(borrowed.ok).toBe(true);
    expect(borrowed.value!.fill).toBeCloseTo(0.5, 9);
    expect(borrowed.value!.cost).toBe(Math.round(0.5 * TERRAIN.fillBorrowed * remote));
    expect(cash - s.finance.cash).toBe(borrowed.value!.cost);
    expect(s.height[v.i]).toBeCloseTo(h0 + 0.5, 4);
    expect(s.soil[v.i]).toBeCloseTo(so0 + 0.5, 4);
    expect(s.materials.spoil).toBe(0);
    // dig it back out: half a level of spoil on hand
    must(s, { type: 'terrain', op: dot('excavate', v) });
    expect(s.materials.spoil).toBeCloseTo(0.5, 9);
    cash = s.finance.cash;
    const fromSpoil = run(s, dot('fill', v));
    expect(fromSpoil.value!.cost).toBe(Math.round(0.5 * TERRAIN.fillFromSpoil * remote));
    expect(fromSpoil.value!.cost).toBeLessThan(borrowed.value!.cost);
    expect(cash - s.finance.cash).toBe(fromSpoil.value!.cost);
    expect(s.materials.spoil).toBeCloseTo(0, 9);
    // partly from spoil: the shortfall is borrowed
    s.materials.spoil = 0.2;
    const mixed = planTerrainOp(s, dot('fill', v));
    expect(mixed.cost).toBe(Math.round((0.2 * TERRAIN.fillFromSpoil + 0.3 * TERRAIN.fillBorrowed) * remote));
    expect(run(s, dot('fill', v)).value!.cost).toBe(mixed.cost);
    expect(s.materials.spoil).toBe(0);
  });

  it('clearing forest costs $14 a cell and recovers timber', () => {
    const s = newGame(SEED);
    let cell: { x: number; z: number } | null = null;
    for (let z = 6; z < N - 6 && !cell; z++) for (let x = 6; x < N - 6; x++) if (s.forest[ci(x, z)]) { cell = { x, z }; break; }
    expect(cell).not.toBeNull();
    const op: TerrainOp = { tool: 'clear', x: cell!.x + 0.5, z: cell!.z + 0.5, radius: 0.5 };
    const heights = s.height.slice();
    const cash = s.finance.cash;
    const r = run(s, op);
    expect(r.ok).toBe(true);
    expect(r.value!.cleared).toBe(1);
    expect(r.value!.cost).toBe(Math.round(TERRAIN.clearForest * remoteFactor(s, op.x, op.z)));
    expect(cash - s.finance.cash).toBe(r.value!.cost);
    expect(s.forest[ci(cell!.x, cell!.z)]).toBe(0);
    expect(s.materials.timber).toBeCloseTo(TERRAIN.timberPerCell, 9);
    expectSame(s.height, heights);
    const before = snapshot(s);
    const again = run(s, op);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/Nothing to clear/);
    expectUnchanged(s, before);
  });

  it('earthmoving under trees clears them and charges for the clearing too', () => {
    const s = newGame(SEED);
    let at: { x: number; z: number } | null = null;
    for (let z = 6; z < N - 6 && !at; z++) for (let x = 6; x < N - 6; x++) {
      if (s.forest[ci(x, z)] && s.forest[ci(x - 1, z)] && s.forest[ci(x, z - 1)] && s.forest[ci(x - 1, z - 1)] && !s.locked[vi(x, z)] && s.soil[vi(x, z)] >= 1) { at = { x, z }; break; }
    }
    expect(at).not.toBeNull();
    const op: TerrainOp = { tool: 'excavate', x: at!.x, z: at!.z, radius: 1 };
    const plan = planTerrainOp(s, op);
    expect(plan.cleared).toBe(4);
    expect(plan.cost).toBe(Math.round((plan.soilCut * TERRAIN.excavateSoil + 4 * TERRAIN.clearForest) * plan.remote));
    const cash = s.finance.cash;
    expect(run(s, op).ok).toBe(true);
    expect(cash - s.finance.cash).toBe(plan.cost);
    for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) expect(s.forest[ci(at!.x + dx, at!.z + dz)]).toBe(0);
    expect(s.materials.timber).toBeCloseTo(4 * TERRAIN.timberPerCell, 9);
  });

  it('work far from the railhead carries a surcharge of up to 40%', () => {
    const s = newGame(SEED);
    const near = findVertex(s, (h, so, x, z) => so >= 1.5 && Math.hypot(x - s.nodes[0].x, z - s.nodes[0].z) < 8 + 6 && remoteFactor(s, x, z) === 1);
    const far = findVertex(s, (h, so, x, z) => so >= 1.5 && h > 3 && remoteFactor(s, x, z) >= 1 + TERRAIN.remoteSurchargeMax - 1e-9);
    expect(planTerrainOp(s, dot('excavate', near)).cost).toBe(Math.round(0.5 * TERRAIN.excavateSoil));
    expect(planTerrainOp(s, dot('excavate', far)).cost).toBe(Math.round(0.5 * TERRAIN.excavateSoil * 1.4));
  });

  it('the estimate is exactly what the work charges and does, for every tool and brush size', () => {
    const s = newGame(SEED);
    s.finance.cash = 5_000_000; // this test is about the quote, not about money
    const rnd = mulberry32(42);
    const tools: TerrainTool[] = ['excavate', 'fill', 'grade', 'blast', 'clear'];
    let done = 0, refused = 0, totalCost = 0;
    const kinds = new Set<string>();
    for (let k = 0; k < 160; k++) {
      const tool = tools[k % tools.length];
      const x = 4 + rnd() * (N - 8), z = 4 + rnd() * (N - 8);
      const op: TerrainOp = { tool, x, z, radius: 0.5 + rnd() * 3.5, target: tool === 'grade' ? Math.round(heightAt(s, x, z) + (rnd() - 0.5) * 3) : undefined };
      const plan = planTerrainOp(s, op);
      const cash = s.finance.cash, mat = { ...s.materials };
      const height = s.height.slice(), soil = s.soil.slice(), forest = s.forest.slice();
      const r = run(s, op);
      if (!r.ok) {
        refused++;
        expect(plan.changed + plan.cleared).toBe(0);
        expect(s.finance.cash).toBe(cash);
        expectSame(s.height, height); expectSame(s.soil, soil); expectSame(s.forest, forest);
        continue;
      }
      done++; kinds.add(tool); totalCost += plan.cost;
      expect(r.value!.cost).toBe(plan.cost);
      expect(cash - s.finance.cash).toBe(plan.cost);
      expect(plan.cost).toBe(Math.round((plan.soilCut * TERRAIN.excavateSoil + plan.rockCut * TERRAIN.blastRock
        + Math.min(plan.fill, mat.spoil) * TERRAIN.fillFromSpoil + Math.max(0, plan.fill - mat.spoil) * TERRAIN.fillBorrowed
        + plan.cleared * TERRAIN.clearForest) * plan.remote));
      // exactly the planned vertices moved, to exactly the planned heights; nothing else did
      for (const [i, h, so] of plan.dv) { height[i] = h; soil[i] = so; }
      for (const c of plan.cells) forest[c] = 0;
      expectSame(s.height, height); expectSame(s.soil, soil); expectSame(s.forest, forest);
      expect(plan.dv.length).toBe(plan.changed);
      expect(s.materials.spoil).toBeCloseTo(Math.max(0, mat.spoil + plan.soilCut - Math.min(plan.fill, mat.spoil)), 9);
      expect(s.materials.stone).toBeCloseTo(mat.stone + plan.rockCut, 9);
      expect(s.materials.timber).toBeCloseTo(mat.timber + plan.cleared * TERRAIN.timberPerCell, 9);
    }
    expect(done).toBeGreaterThan(100);
    expect(kinds.size).toBe(5);
    expect(totalCost).toBeGreaterThan(0);
    expect(s.finance.totals.capital).toBe(totalCost);
    expect(s.stats.terrainEdits).toBe(done);
    void refused;
    // soil cover can never go negative and heights stay on the 0.05 grid
    for (let i = 0; i < s.soil.length; i++) {
      if (s.soil[i] < 0) throw new Error('negative soil');
      const q = s.height[i] / WORLD.heightStep;
      if (Math.abs(q - Math.round(q)) > 1e-3) throw new Error(`height off the grid at ${i}: ${s.height[i]}`);
    }
  });

  it('nothing can be dug below the floor of the map, by shovel or by powder', () => {
    const s = newGame(SEED);
    s.finance.cash = 1_000_000;
    const v = findVertex(s, (h, so) => h < 4 && h > 1.5 && so >= 1);
    for (let k = 0; k < 20; k++) { if (!run(s, dot('excavate', v)).ok) break; expect(s.height[v.i]).toBeGreaterThanOrEqual(0.6 - 1e-4); }
    let last: Result<TerrainPlan> | null = null;
    for (let k = 0; k < 20; k++) { last = run(s, dot('blast', v)); if (!last.ok) break; expect(s.height[v.i]).toBeGreaterThanOrEqual(0.6 - 1e-4); }
    expect(last!.ok).toBe(false);
    expect(s.height[v.i]).toBeCloseTo(0.6, 4);
  });
});

describe('protected ground', () => {
  const allTools = (v: { x: number; z: number }, h: number): TerrainOp[] => [dot('excavate', v), dot('fill', v), dot('blast', v), dot('grade', v, h + 2), dot('grade', v, h - 2)];

  it('the city pad cannot be dug, filled, graded or blasted', () => {
    const s = newGame(SEED);
    const v = { x: s.city.x, z: s.city.z };
    const before = snapshot(s);
    for (const op of allTools(v, s.city.h)) {
      const r = run(s, op);
      expect(r.ok, op.tool).toBe(false);
      expect(r.error).toMatch(/cannot be dug up/);
    }
    expectUnchanged(s, before);
  });

  it('finished track, a line under construction, mines and mills are all locked', () => {
    const built = world.mill();
    const e = built.edges[0];
    const p = e.pts.find((q, i) => i > 30 && q.k !== K_BRIDGE && q.k !== K_TUNNEL && !wetVertex(built, Math.round(q.x), Math.round(q.z)))!;
    const spots = [{ x: Math.round(p.x), z: Math.round(p.z) }, { x: built.mines[0].x, z: built.mines[0].z }, { x: built.mills[0].x, z: built.mills[0].z }];
    const before = snapshot(built);
    for (const v of spots) for (const op of allTools(v, built.height[vi(v.x, v.z)])) {
      const r = run(built, op);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/cannot be dug up/);
    }
    expectUnchanged(built, before);

    const building = world.building();
    const jp = building.jobs[0].pts[Math.floor(building.jobs[0].pts.length * 0.8)];
    const jv = { x: Math.round(jp.x), z: Math.round(jp.z) };
    const b2 = snapshot(building);
    for (const op of allTools(jv, building.height[vi(jv.x, jv.z)])) expect(run(building, op).ok).toBe(false);
    expectUnchanged(building, b2);
  });

  it('a wide brush beside the track moves the open ground and leaves every locked vertex alone', () => {
    const s = world.line();
    s.finance.cash = 100000;
    const p = s.edges[0].pts[40];
    const lockedBefore: Array<[number, number, number]> = [];
    for (let i = 0; i < s.locked.length; i++) if (s.locked[i]) lockedBefore.push([i, s.height[i], s.soil[i]]);
    let moved = 0;
    for (const tool of ['fill', 'excavate', 'blast', 'grade'] as TerrainTool[]) {
      const r = run(s, { tool, x: p.x + 2, z: p.z + 2, radius: 4, target: p.h + 3 });
      if (r.ok) { moved += r.value!.changed; expect(r.value!.blockedByLock).toBe(true); }
    }
    expect(moved).toBeGreaterThan(0);
    for (const [i, h, so] of lockedBefore) { expect(s.height[i]).toBe(h); expect(s.soil[i]).toBe(so); }
  });

  it('the river cannot be edited', () => {
    const s = newGame(SEED);
    let cell: { x: number; z: number } | null = null;
    for (let z = 40; z < 80 && !cell; z++) for (let x = 2; x < N - 2; x++) if (s.water[ci(x, z)] && s.water[ci(x - 1, z)] && s.water[ci(x, z - 1)]) { cell = { x, z }; break; }
    expect(cell).not.toBeNull();
    const before = snapshot(s);
    for (const op of allTools(cell!, s.height[vi(cell!.x, cell!.z)])) {
      const r = run(s, op);
      expect(r.ok, op.tool).toBe(false);
      expect(r.error).toMatch(/Nothing to move/);
    }
    expectUnchanged(s, before);
    // a wide brush across the channel leaves every vertex that touches water where it was
    const wet: Array<[number, number]> = [];
    for (let z = 0; z <= N; z++) for (let x = 0; x <= N; x++) if (wetVertex(s, x, z)) wet.push([vi(x, z), s.height[vi(x, z)]]);
    expect(wet.length).toBeGreaterThan(100);
    s.finance.cash = 100000;
    let changed = 0;
    for (const tool of ['fill', 'excavate', 'blast'] as TerrainTool[]) { const r = run(s, { tool, x: cell!.x, z: cell!.z, radius: 4 }); if (r.ok) changed += r.value!.changed; }
    expect(changed).toBeGreaterThan(0);
    for (const [i, h] of wet) expect(s.height[i]).toBe(h);
    expectSame(s.water, newGame(SEED).water);
  });

  it('work outside the surveyed region is refused', () => {
    const s = newGame(SEED);
    const before = snapshot(s);
    for (const [x, z] of [[-3, 50], [50, -1], [N + 2, 50], [50, N + 0.5]]) {
      const r = run(s, { tool: 'fill', x, z, radius: 2 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Outside/);
    }
    expectUnchanged(s, before);
  });
});

describe('terrain modification persistence', () => {
  it('heights, soil and forest changed by the tools survive save → encode → decode → load exactly', () => {
    const s = newGame(SEED);
    s.finance.cash = 200000;
    const pristine = newGame(SEED);
    const soil = findVertex(s, (h, so) => so >= 1.5 && h > 3);
    const rock = findVertex(s, (h, so) => so === 0 && h > 4);
    must(s, { type: 'terrain', op: { tool: 'excavate', x: soil.x, z: soil.z, radius: 2.5 } });
    must(s, { type: 'terrain', op: { tool: 'fill', x: soil.x + 9, z: soil.z, radius: 3 } });
    must(s, { type: 'terrain', op: { tool: 'blast', x: rock.x, z: rock.z, radius: 2 } });
    must(s, { type: 'terrain', op: { tool: 'grade', x: 80, z: 70, radius: 4, target: Math.round(heightAt(s, 80, 70)) + 1 } });
    let cleared = 0;
    for (let z = 10; z < N - 10 && cleared < 3; z += 3) for (let x = 10; x < N - 10 && cleared < 3; x += 3)
      if (s.forest[ci(x, z)] && exec(s, { type: 'terrain', op: { tool: 'clear', x: x + 0.5, z: z + 0.5, radius: 3 } }).ok) cleared++;
    expect(cleared).toBe(3);

    const count = (a: ArrayLike<number>, b: ArrayLike<number>) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    expect(count(s.height, pristine.height)).toBeGreaterThan(40);
    expect(count(s.soil, pristine.soil)).toBeGreaterThan(40);
    expect(count(s.forest, pristine.forest)).toBeGreaterThan(10);

    const loaded = roundTrip(s);
    expectSame(loaded.height, s.height);
    expectSame(loaded.soil, s.soil);
    expectSame(loaded.forest, s.forest);
    expect(loaded.materials).toEqual(s.materials);
    expect(loaded.stats.terrainEdits).toBe(s.stats.terrainEdits);
    // the survey of the untouched land is kept alongside, unchanged
    expectSame(loaded.baseHeight, pristine.height);
    expectSame(s.baseHeight, pristine.height);
    // and a second generation is still identical
    expectSame(roundTrip(loaded).height, s.height);
  });

  it('railway cuts, embankments and cleared right-of-way survive the round trip exactly', () => {
    const s = world.line();
    const pristine = newGame(SEED);
    // add a spur through timber so the right-of-way clearing is part of what must persist
    const spur = findBranch(s, { forest: true });
    must(s, { type: 'buildLine', way: spur.way });
    finishLine(s);
    expect(s.edges.length).toBe(3);
    const moved = countDiff(s.height, pristine.height), felled = countDiff(s.forest, pristine.forest);
    expect(moved).toBeGreaterThan(100);
    expect(felled).toBeGreaterThanOrEqual(spur.plan.forestCells);
    expect(countDiff(s.soil, pristine.soil)).toBeGreaterThan(100);
    const loaded = roundTrip(s);
    expectSame(loaded.height, s.height);
    expectSame(loaded.soil, s.soil);
    expectSame(loaded.forest, s.forest);
    expectSame(loaded.locked, s.locked);
    // the formation is really in the ground: away from the river the surface sits on the grade line
    for (const p of loaded.edges.flatMap((e) => e.pts)) {
      if (p.k === K_BRIDGE || p.k === K_TUNNEL) continue;
      let nearWater = false;
      for (let dz = -3; dz <= 3 && !nearWater; dz++) for (let dx = -3; dx <= 3; dx++) { const cx = Math.floor(p.x) + dx, cz = Math.floor(p.z) + dz; if (cx >= 0 && cz >= 0 && cx < N && cz < N && loaded.water[ci(cx, cz)]) { nearWater = true; break; } }
      if (!nearWater) expect(Math.abs(heightAt(loaded, p.x, p.z) - p.h)).toBeLessThan(0.4);
    }
  });

  it('a half-built line keeps exactly the earthworks done so far', () => {
    const half = world.building();
    runTicks(half, 12 * TPD);
    expect(half.jobs.length).toBe(1);
    expect(half.jobs[0].applied).toBeGreaterThan(10);
    expect(countDiff(half.height, newGame(SEED).height)).toBeGreaterThan(20);
    const loaded = roundTrip(half);
    expectSame(loaded.height, half.height);
    expectSame(loaded.soil, half.soil);
    expectSame(loaded.forest, half.forest);
    expect(loaded.jobs[0].applied).toBe(half.jobs[0].applied);
    expect(loaded.jobs[0].progress).toBe(half.jobs[0].progress);
  });
});
