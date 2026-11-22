import { describe, expect, it } from 'vitest';
import { FINANCE } from '../src/sim/config';
import { suggestRoute } from '../src/sim/autoroute';
import { creditLimit, price } from '../src/sim/economy';
import { previewLine } from '../src/sim/rail';
import { SAVE_VERSION, decodeSave, encodeSave, fromSave, toSave, type SaveFile } from '../src/sim/save';
import { newGame, tick } from '../src/sim/sim';
import { padRelief } from '../src/sim/terrain';
import { cargoTons } from '../src/sim/trains';
import type { GameState } from '../src/sim/types';
import { vi } from '../src/sim/worldgen';
import { Auditor, SEED, TPD, claimRailhead, expectSame, findBranch, fingerprint, finishLine, hashArray, must, openMine, roundTrip, runTicks, runUntil, startLine, world } from './helpers';

/** A busy moment: a spur under construction, the train on the road with ore aboard, ore on the pile, a loan outstanding. */
function midGame(): GameState {
  const s = world.mine();
  const t = s.trains[0];
  if (!runUntil(s, () => t.phase === 'loading', 10)) throw new Error('never reached the mine');
  must(s, { type: 'buildLine', way: findBranch(s, { forest: true }).way });
  if (!runUntil(s, () => t.phase === 'inbound' && t.trip!.dist > 12, 10)) throw new Error('never left the mine');
  runTicks(s, 3);
  return s;
}
const ARRAYS = ['height', 'soil', 'baseHeight', 'forest', 'water', 'waterLevel', 'locked'] as const;
function expectIdentical(a: GameState, b: GameState) {
  for (const k of ARRAYS) expectSame(a[k], b[k], k);
  expect(fingerprint(a)).toEqual(fingerprint(b));
  expect(a.edges).toEqual(b.edges);
  expect(a.jobs).toEqual(b.jobs);
  expect(a.trains).toEqual(b.trains);
  expect(a.notes).toEqual(b.notes);
}

describe('save / load consistency', () => {
  it('a mid-game save restores every part of the simulation exactly', () => {
    const s = midGame();
    const t = s.trains[0];
    // the moment really is busy
    expect(s.jobs.length).toBe(1);
    expect(s.jobs[0].progress).toBeGreaterThan(0);
    expect(s.jobs[0].progress).toBeLessThan(s.jobs[0].length);
    expect(t.phase).toBe('inbound');
    expect(t.trip!.dist).toBeGreaterThan(0);
    expect(cargoTons(t)).toBeGreaterThan(40);
    expect(s.mines[0].stock).toBeGreaterThan(0);
    expect(s.finance.debt).toBeGreaterThan(0);
    expect(s.tick % TPD).not.toBe(0); // mid-day, too

    const file = toSave(s, 1234567);
    expect(file.version).toBe(SAVE_VERSION);
    expect(file.savedAt).toBe(1234567);
    expect(file.summary).toEqual({ day: s.day, cash: Math.round(s.finance.cash), debt: Math.round(s.finance.debt), seed: SEED });
    const text = encodeSave(file);
    expect(typeof text).toBe('string');
    const loaded = fromSave(decodeSave(text));
    expectIdentical(loaded, s);
    expect(loaded.trains[0].trip!.pts).toEqual(t.trip!.pts);
    expect(loaded.trains[0].cargo).toEqual(t.cargo);
    expect(loaded.height).toBeInstanceOf(Float32Array);
    expect(loaded.forest).toBeInstanceOf(Uint8Array);
    // transient client queues start empty
    expect(loaded.events).toEqual([]);
    expect(loaded.dirtyCells).toEqual([]);
    // the text form is stable from one generation to the next (only the renderer's revision counters restart on load)
    const text2 = encodeSave(toSave(loaded, 1234567));
    expect(encodeSave(toSave(fromSave(decodeSave(text2)), 1234567))).toBe(text2);
    expect(text2.length).toBe(text.length - (JSON.stringify(s.rev).length - JSON.stringify(loaded.rev).length));
    // and the in-memory (structured clone) path gives the same game as the text path
    expectIdentical(fromSave(structuredClone(file)), loaded);
  });

  it('the original and the loaded game stay identical for 200 more days', () => {
    const a = midGame();
    const b = roundTrip(a);
    const audit = new Auditor(b); // the loaded copy must also keep honest books
    for (let day = 1; day <= 200; day++) {
      for (let i = 0; i < TPD; i++) { tick(a); audit.step(); }
      // cheap comparison every day, the full one every twenty
      expect(b.finance.cash).toBe(a.finance.cash);
      expect(b.finance.debt).toBe(a.finance.debt);
      expect(b.day).toBe(a.day);
      expect(b.deposits.map((d) => d.remaining)).toEqual(a.deposits.map((d) => d.remaining));
      expect(b.trains.map((t) => [t.phase, t.at, t.trip?.dist ?? -1, cargoTons(t)])).toEqual(a.trains.map((t) => [t.phase, t.at, t.trip?.dist ?? -1, cargoTons(t)]));
      if (day % 20 === 0) {
        expect(hashArray(b.height)).toBe(hashArray(a.height));
        expect(fingerprint(b)).toEqual(fingerprint(a));
      }
    }
    expectIdentical(a, b);
    expect(a.day).toBeGreaterThan(220);
    expect(a.jobs.length).toBe(0);
    expect(a.edges.length).toBe(3);
    expect(a.trains[0].tripsDone).toBeGreaterThan(30);
    expect(a.finance.history.length).toBeGreaterThanOrEqual(7);
  });

  it('saving does not disturb the running game, and a save is a frozen copy', () => {
    const a = midGame(), b = midGame();
    const file = toSave(a, 0);
    const text = encodeSave(file);
    runTicks(a, 30 * TPD); runTicks(b, 30 * TPD);
    expectIdentical(a, b); // taking the save changed nothing in a
    expect(encodeSave(file)).toBe(text); // and playing on changed nothing in the save
    const l1 = fromSave(file), l2 = fromSave(file);
    runTicks(l1, 5 * TPD);
    expect(l2.day).toBe(file.summary.day); // two loads of one file share nothing
    expect(encodeSave(file)).toBe(text);
  });

  it('save → load at any point of a run never changes its outcome', () => {
    const straight = world.mill();
    let hopped = world.mill();
    for (let d = 0; d < 60; d++) {
      runTicks(straight, TPD);
      runTicks(hopped, 7);
      hopped = roundTrip(hopped); // mid-day, every day
      runTicks(hopped, TPD - 7);
      if (d % 9 === 0) hopped = fromSave(toSave(hopped));
    }
    expectIdentical(hopped, straight);
  });

  it('rejects saves from a newer version, damaged terrain arrays and things that are not saves', () => {
    const s = world.line();
    const good = () => decodeSave(encodeSave(toSave(s, 0)));
    expect(() => fromSave(good())).not.toThrow();

    const newer = good(); newer.version = SAVE_VERSION + 1;
    expect(() => fromSave(newer)).toThrow(/newer version/);

    for (const k of ['height', 'soil', 'baseHeight', 'forest', 'water', 'waterLevel'] as const) {
      const plain = good(); plain.state[k] = Array.from(plain.state[k] as Float32Array);
      expect(() => fromSave(plain), `${k} as a plain array`).toThrow(/damaged/);
      const missing = good(); delete plain.state[k]; delete missing.state[k];
      expect(() => fromSave(missing), `${k} missing`).toThrow(/damaged/);
      const short = good(); short.state[k] = (short.state[k] as Float32Array).slice(0, 1000);
      expect(() => fromSave(short), `${k} truncated`).toThrow(/damaged/);
    }
    const text = encodeSave(toSave(s, 0));
    // bytes lost in transit: the text still parses, the terrain is short, the load is refused
    const clipped = text.replace(/"__f32":"[A-Za-z0-9+/]{40}/, (m) => m.slice(0, 9) + m.slice(17));
    expect(clipped.length).toBe(text.length - 8);
    expect(() => fromSave(decodeSave(clipped))).toThrow(/damaged/);
    // mangled encoding is refused one way or the other, never loaded
    const mangled = text.replace(/"__u8":"[A-Za-z0-9+/]{12}/, (m) => m.slice(0, 8) + '!!' + m.slice(10));
    expect(mangled).not.toBe(text);
    expect(() => fromSave(decodeSave(mangled))).toThrow();

    expect(() => fromSave(null as unknown as SaveFile)).toThrow(/Not a MONEY LINE save/);
    expect(() => fromSave({} as SaveFile)).toThrow(/Not a MONEY LINE save/);
    expect(() => fromSave({ version: 1, savedAt: 0, summary: {}, state: null } as unknown as SaveFile)).toThrow(/Not a MONEY LINE save/);
    expect(() => decodeSave('not json at all')).toThrow();
    // a refused file leaves the source untouched and usable
    expect(() => fromSave(good())).not.toThrow();
  });
});

describe('determinism', () => {
  const script = (seed: number) => {
    const { s } = startLine(seed);
    finishLine(s);
    openMine(s);
    runTicks(s, 40 * TPD);
    must(s, { type: 'buyWagons' });
    must(s, { type: 'terrain', op: { tool: 'excavate', x: 60, z: 100, radius: 3 } });
    runTicks(s, 20 * TPD);
    return s;
  };

  it('two fresh games on one seed given the same commands are identical, tick for tick', () => {
    const a = script(SEED), b = script(SEED);
    expectIdentical(a, b);
    expect(a.events).toEqual(b.events);
    expect(a.stats.shipmentsSold).toBeGreaterThan(5);
  });

  it('a new game is a pure function of its seed', () => {
    const a = newGame(SEED), b = newGame(SEED), c = newGame(SEED + 1);
    expectIdentical(a, b);
    expect(hashArray(a.height)).not.toBe(hashArray(c.height));
    expect(a.finance.cash).toBe(FINANCE.startCash);
  });

  for (const seed of [1, 7, 1890, 4242]) {
    it(`seed ${seed}: the world is playable — level city pad, river, forest, and a buildable line to the gold claim`, () => {
      const s = newGame(seed);
      // the city stands on a level, dry, locked pad with its terminal on it
      expect(padRelief(s, s.city.x, s.city.z, 2)).toBeLessThanOrEqual(0.05);
      expect(s.locked[vi(s.city.x, s.city.z)]).toBe(1);
      const node = s.nodes[0];
      expect(node.id).toBe(s.city.node);
      expect(Math.hypot(node.x - s.city.x, node.z - s.city.z)).toBeLessThan(s.city.radius);
      expect(Math.abs(node.h - s.height[vi(Math.round(node.x), Math.round(node.z))])).toBeLessThan(0.3);
      expect(s.water.reduce((x, y) => x + y, 0)).toBeGreaterThan(200);
      expect(s.forest.reduce((x, y) => x + (y ? 1 : 0), 0)).toBeGreaterThan(500);
      for (let i = 0; i < s.height.length; i++) if (!Number.isFinite(s.height[i]) || s.soil[i] < 0) throw new Error('bad terrain');
      // the three ore bodies are there, the gold one owned
      expect(s.deposits.map((d) => d.resource)).toEqual(['gold', 'silver', 'coal']);
      expect(s.deposits[0]).toMatchObject({ owned: true, discovered: true });
      for (const d of s.deposits) expect(d.actualTons).toBeGreaterThan(1000);
      // the surveyor finds a line to the claim that the engineers accept and the bank will fund
      const way = suggestRoute(s, node, claimRailhead(s));
      expect(way).not.toBeNull();
      const pv = previewLine(s, way!);
      expect(pv.error).toBeNull();
      expect(pv.plan.valid).toBe(true);
      expect(pv.plan.total).toBeGreaterThan(0);
      expect(pv.plan.total).toBeLessThan(FINANCE.startCash + creditLimit(s) - 25000); // with room left for a mine and a mill
      // and it really can be built and reaches the claim
      must(s, { type: 'borrow', amount: 45000 });
      must(s, { type: 'buildLine', way: way! });
      finishLine(s);
      expect(s.stats.reachedClaim).toBe(true);
      const site = openMine(s);
      expect(site.mine.deposit).toBe(s.deposits[0].id);
    });
  }

  it('different seeds give different markets', () => {
    const series = (seed: number) => Array.from({ length: 120 }, (_, d) => price({ seed }, 'gold_conc', d));
    const all = [1, 7, 1890, 4242].map(series);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(all[i]).not.toEqual(all[j]);
    expect(series(7)).toEqual(series(7));
  });
});
