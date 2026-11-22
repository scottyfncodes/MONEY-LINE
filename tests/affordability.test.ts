import { describe, expect, it } from 'vitest';
import { LOCOS, MILL, MINE, STATION, SURVEY, UPGRADES, WAGON } from '../src/sim/config';
import { suggestRoute } from '../src/sim/autoroute';
import { claimPrice, surveyCost } from '../src/sim/geology';
import { previewLine } from '../src/sim/rail';
import { exec, newGame, type Command } from '../src/sim/sim';
import { heightAt, planTerrainOp, type TerrainOp } from '../src/sim/terrain';
import type { GameState } from '../src/sim/types';
import { SEED, claimRailhead, expectUnchanged, findBranch, lineEnd, must, prepareSite, snapshot, world } from './helpers';

/**
 * The rule under test: a command that costs more than the cash on hand fails and leaves the company exactly as it was —
 * no money gone, no earth moved, no track, no materials, no half-built anything. And the same command with exactly
 * enough cash succeeds and charges exactly its price (so the refusal really was about the money).
 */
function refusesThenCharges(make: () => GameState, cmd: (s: GameState) => Command, cost: (s: GameState) => number) {
  const poor = make();
  const price = cost(poor);
  expect(price).toBeGreaterThan(0);
  poor.finance.cash = price - 1;
  const before = snapshot(poor);
  const r = exec(poor, cmd(poor));
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Short by \$/);
  expectUnchanged(poor, before);
  // a dollar short is still short
  poor.finance.cash = price - 0.01;
  const b2 = snapshot(poor);
  expect(exec(poor, cmd(poor)).ok).toBe(false);
  expectUnchanged(poor, b2);

  const exact = make();
  exact.finance.cash = price;
  const done = exec(exact, cmd(exact));
  expect(done.error).toBeUndefined();
  expect(done.ok).toBe(true);
  expect(exact.finance.cash).toBeCloseTo(0, 9);
  expect(exact.finance.cash).toBeGreaterThanOrEqual(-1e-9);
}

describe('construction affordability: no money, no change', () => {
  const terrainOps = (s: GameState): TerrainOp[] => [
    { tool: 'excavate', x: 60, z: 100.5, radius: 3 },
    { tool: 'fill', x: 45, z: 90, radius: 3.5 },
    { tool: 'blast', x: 100, z: 40, radius: 2.5 },
    { tool: 'grade', x: 80, z: 70, radius: 3, target: Math.round(heightAt(s, 80, 70)) + 2 },
    { tool: 'clear', ...forestSpot(s), radius: 4 },
  ];
  const forestSpot = (s: GameState) => { for (let z = 20; z < 110; z++) for (let x = 20; x < 110; x++) if (s.forest[z * s.size + x]) return { x: x + 0.5, z: z + 0.5 }; throw new Error('no forest'); };
  for (const [i, tool] of (['excavate', 'fill', 'blast', 'grade', 'clear'] as const).entries()) {
    it(`terrain: ${tool}`, () => {
      refusesThenCharges(() => newGame(SEED), (s) => ({ type: 'terrain', op: terrainOps(s)[i] }), (s) => planTerrainOp(s, terrainOps(s)[i]).cost);
    });
  }

  it('the opening position cannot afford the Eureka line at all', () => {
    const s = newGame(SEED);
    const way = suggestRoute(s, s.nodes[0], claimRailhead(s))!;
    const pv = previewLine(s, way);
    expect(pv.error).toBeNull();
    expect(pv.plan.total).toBeGreaterThan(s.finance.cash);
    const before = snapshot(s);
    const r = exec(s, { type: 'buildLine', way });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Short by \$/);
    expectUnchanged(s, before);
    expect(s.jobs.length).toBe(0);
  });

  it('railway contract from the terminal', () => {
    const way = (s: GameState) => suggestRoute(s, s.nodes[0], claimRailhead(s))!;
    refusesThenCharges(() => newGame(SEED), (s) => ({ type: 'buildLine', way: way(s) }), (s) => previewLine(s, way(s)).plan.total);
  });

  it('railway contract branching off mid-line (the junction is not cut in when the money is short)', () => {
    const make = () => { const s = world.line(); s.materials.timber = 6; s.materials.stone = 2; s.materials.spoil = 3; return s; };
    refusesThenCharges(make, (s) => ({ type: 'buildLine', way: findBranch(s).way }), (s) => findBranch(s).plan.total);
  });

  it('mine', () => {
    const sites = new WeakMap<GameState, { x: number; z: number }>();
    const make = () => { const s = world.line(); s.finance.cash = 1e6; sites.set(s, prepareSite(s, 'mine', s.deposits[0].x, s.deposits[0].z, 5)); return s; };
    refusesThenCharges(make, (s) => ({ type: 'mine', ...sites.get(s)! }), () => MINE.cost);
  });

  it('loading platform', () => {
    refusesThenCharges(() => world.line(), (s) => { const e = lineEnd(s); return { type: 'platform', x: e.x, z: e.z }; }, () => STATION.platformCost);
  });

  it('loading platform on the middle of a line (the line is not cut when the money is short)', () => {
    const mid = (s: GameState) => s.edges[0].pts[40];
    refusesThenCharges(() => world.line(), (s) => ({ type: 'platform', x: mid(s).x, z: mid(s).z }), () => STATION.platformCost);
  });

  it('stamp mill', () => {
    const sites = new WeakMap<GameState, { x: number; z: number }>();
    const make = () => { const s = world.mine(); s.finance.cash = 1e6; const m = s.mines[0]; sites.set(s, prepareSite(s, 'mill', m.x, m.z, 6)); return s; };
    refusesThenCharges(make, (s) => ({ type: 'mill', ...sites.get(s)! }), () => MILL.cost);
  });

  for (const u of UPGRADES) {
    it(`improvement: ${u.name}`, () => {
      refusesThenCharges(() => world.mill(), () => ({ type: 'upgrade', id: u.id }), () => u.cost);
    });
  }

  for (const id of Object.keys(LOCOS)) {
    it(`locomotive: ${LOCOS[id].name}`, () => {
      refusesThenCharges(() => newGame(SEED), () => ({ type: 'buyLoco', loco: id }), () => LOCOS[id].price);
    });
  }

  it('ore hoppers', () => {
    refusesThenCharges(() => newGame(SEED), () => ({ type: 'buyWagons' }), () => WAGON.price * WAGON.batch);
  });

  it('prospecting', () => {
    refusesThenCharges(() => newGame(SEED), (s) => ({ type: 'prospect', x: s.deposits[1].x, z: s.deposits[1].z }), () => SURVEY.prospectCost);
  });

  it('test pits and core drilling', () => {
    refusesThenCharges(() => newGame(SEED), (s) => ({ type: 'survey', deposit: s.deposits[0].id }), (s) => surveyCost(s, s.deposits[0])!);
    const drilled = () => { const s = newGame(SEED); must(s, { type: 'survey', deposit: s.deposits[0].id }); return s; };
    expect(surveyCost(drilled(), drilled().deposits[0])).toBe(SURVEY.drillCost);
    refusesThenCharges(drilled, (s) => ({ type: 'survey', deposit: s.deposits[0].id }), (s) => surveyCost(s, s.deposits[0])!);
  });

  it('mining claims', () => {
    const found = () => { const s = newGame(SEED); must(s, { type: 'prospect', x: s.deposits[1].x, z: s.deposits[1].z }); return s; };
    refusesThenCharges(found, (s) => ({ type: 'buyClaim', deposit: s.deposits[1].id }), (s) => claimPrice(s, s.deposits[1]));
    const s = found();
    s.finance.cash = claimPrice(s, s.deposits[1]) - 1;
    exec(s, { type: 'buyClaim', deposit: s.deposits[1].id });
    expect(s.deposits[1].owned).toBe(false);
  });
});
