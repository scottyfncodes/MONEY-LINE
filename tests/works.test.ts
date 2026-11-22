import { describe, expect, it } from 'vitest';
import { MILL, MINE, RESOURCES, TIME } from '../src/sim/config';
import { dailyOpsCost, millSite, millTier, mineSite, mineTier } from '../src/sim/facilities';
import { exec, newGame, tick } from '../src/sim/sim';
import { padRelief } from '../src/sim/terrain';
import type { GameState, Mill, Mine } from '../src/sim/types';
import { Auditor, SEED, TPD, expectUnchanged, goldOf, levelSite, lineEnd, must, prepareSite, roughSite, runTicks, snapshot, world } from './helpers';

const dt = 1 / TIME.ticksPerDay;
const park = (s: GameState) => must(s, { type: 'assign', train: s.trains[0].id, station: null });

describe('siting the works', () => {
  it('a mine needs a known, owned ore body, the railroad within reach and a level pad', () => {
    const fresh = newGame(SEED);
    const g = goldOf(fresh);
    fresh.finance.cash = 100000;
    expect(mineSite(fresh, g.x, g.z).error).toMatch(/No railroad here yet/);
    expect(mineSite(fresh, 40, 100).error).toMatch(/No known ore body/);
    const silver = fresh.deposits[1];
    expect(mineSite(fresh, silver.x, silver.z).error).toMatch(/No known ore body/); // not discovered yet
    const before = snapshot(fresh);
    expect(exec(fresh, { type: 'mine', x: g.x, z: g.z }).ok).toBe(false);
    expect(exec(fresh, { type: 'mine', x: silver.x, z: silver.z }).ok).toBe(false);
    expectUnchanged(fresh, before);

    const s = world.line();
    s.finance.cash = 100000;
    // a pad with too much relief is refused, with the ground and the till left alone
    const bad = roughSite(s, 'mine', g.x, g.z, 5);
    expect(padRelief(s, bad.x, bad.z, MINE.footprint)).toBeGreaterThan(MINE.maxPadRelief);
    const b2 = snapshot(s);
    const r = exec(s, { type: 'mine', x: bad.x, z: bad.z });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Grade it level first/);
    expectUnchanged(s, b2);
    // too far from the railhead is refused as well, however good the ground
    expect(mineSite(world.building(), g.x, g.z).error).toMatch(/No railroad here yet/);
    // sold claims cannot be mined
    must(s, { type: 'sellClaim', deposit: g.id });
    expect(mineSite(s, g.x, g.z).error).toMatch(/not yours yet/);
  });

  it('grading the pad with the terrain tools makes the site buildable, and the mine levels it', () => {
    const s = world.line();
    const g = goldOf(s);
    s.finance.cash = 100000;
    const site = roughSite(s, 'mine', g.x, g.z, 5);
    expect(mineSite(s, site.x, site.z).error).toMatch(/too uneven/);
    const edits = s.stats.terrainEdits, spent = s.finance.totals.capital, cash0 = s.finance.cash;
    const graded = levelSite(s, 'mine', site.x, site.z);
    expect(graded).toBeGreaterThan(0);
    expect(s.stats.terrainEdits).toBe(edits + graded);
    expect(s.finance.totals.capital).toBeGreaterThan(spent); // the earthmoving was paid for
    expect(cash0 - s.finance.cash).toBe(s.finance.totals.capital - spent);
    expect(padRelief(s, site.x, site.z, MINE.footprint)).toBeLessThanOrEqual(MINE.maxPadRelief);
    expect(mineSite(s, site.x, site.z)).toMatchObject({ error: null, deposit: { id: g.id } });
    const cash = s.finance.cash;
    const mine = must<Mine>(s, { type: 'mine', x: site.x, z: site.z });
    expect(cash - s.finance.cash).toBe(MINE.cost);
    expect(padRelief(s, site.x, site.z, MINE.footprint)).toBe(0);
    expect(mine).toMatchObject({ deposit: g.id, stock: 0, active: true, exhausted: false, producedTotal: 0 });
    expect(s.stats.minesBuilt).toBe(1);
    // one mine per ore body, and no building on top of another
    expect(mineSite(s, site.x + 4, site.z).error).toMatch(/already has a mine/);
    expect(exec(s, { type: 'mine', x: site.x, z: site.z }).ok).toBe(false);
    expect(s.mines.length).toBe(1);
  });

  it('a mill has to stand beside a mine that has none, on a level pad clear of the track', () => {
    const s = world.mine();
    s.finance.cash = 100000;
    const m = s.mines[0];
    expect(millSite(s, 40, 100).error).toMatch(/beside the mine/);
    expect(millSite(s, m.x + 1, m.z).error).toMatch(/Too close to another works/);
    const end = lineEnd(s);
    expect(millSite(s, Math.round(end.x), Math.round(end.z)).error).toMatch(/Too close to the track/);
    const site = prepareSite(s, 'mill', m.x, m.z, 6);
    const mill = must<Mill>(s, { type: 'mill', x: site.x, z: site.z });
    expect(mill.mine).toBe(m.id);
    expect(padRelief(s, site.x, site.z, MILL.footprint)).toBe(0);
    const again = millSite(s, m.x, m.z - 3);
    expect(again.error).toMatch(/already feeds a mill/);
    expect(s.mills.length).toBe(1);
    expect(exec(s, { type: 'upgrade', id: 'second_battery' }).ok).toBe(true);
  });

  it('improvements need something to improve', () => {
    const s = world.line();
    s.finance.cash = 100000;
    const before = snapshot(s);
    expect(exec(s, { type: 'upgrade', id: 'steam_drills' }).error).toMatch(/no mine/);
    expect(exec(s, { type: 'upgrade', id: 'second_battery' }).error).toMatch(/no mill/);
    expectUnchanged(s, before);
    must(s, { type: 'upgrade', id: 'steel_rails' });
    const b2 = snapshot(s);
    expect(exec(s, { type: 'upgrade', id: 'steel_rails' }).error).toMatch(/Already installed/);
    expectUnchanged(s, b2);
  });
});

describe('ore extraction and depletion', () => {
  it('a mine extracts at its tier rate into the stockpile, tick by tick, out of the deposit', () => {
    const s = world.mine();
    park(s);
    const m = s.mines[0], d = goldOf(s);
    const rate = MINE.tiers[0].rate / d.difficulty;
    for (let i = 1; i <= 3 * TPD; i++) {
      const before = { stock: m.stock, rem: d.remaining };
      tick(s);
      expect(m.stock - before.stock).toBeCloseTo(rate * dt, 9);
      expect(before.rem - d.remaining).toBeCloseTo(rate * dt, 9);
    }
    expect(m.stock).toBeCloseTo(3 * rate, 6);
    expect(m.producedTotal).toBeCloseTo(3 * rate, 6);
    expect(d.actualTons - d.remaining).toBeCloseTo(3 * rate, 6);
    expect(m.status).toMatch(/Hand mining: 14 t\/day/);
  });

  it('the stockpile has a capacity: a full pile stops the mine and stops the deposit depleting', () => {
    const s = world.mine();
    park(s);
    const m = s.mines[0], d = goldOf(s);
    const cap = MINE.tiers[0].capacity;
    runTicks(s, 25 * TPD, () => expect(m.stock).toBeLessThanOrEqual(cap + 1e-9));
    expect(m.stock).toBeCloseTo(cap, 9);
    expect(d.actualTons - d.remaining).toBeCloseTo(cap, 9);
    const rem = d.remaining;
    runTicks(s, 5 * TPD);
    expect(d.remaining).toBe(rem);
    expect(m.producedTotal).toBeCloseTo(cap, 9);
    expect(m.status).toMatch(/Stockpile full/);
  });

  it('steam drills raise the rate to 27 t/day, the pile to 420 t and the wages to $96', () => {
    const s = world.mine();
    park(s);
    s.finance.cash = 50000;
    expect(mineTier(s)).toBe(MINE.tiers[0]);
    expect(dailyOpsCost(s).mines).toBe(68);
    must(s, { type: 'upgrade', id: 'steam_drills' });
    expect(mineTier(s)).toBe(MINE.tiers[1]);
    expect(dailyOpsCost(s).mines).toBe(96);
    const m = s.mines[0];
    runTicks(s, TPD);
    expect(m.producedTotal).toBeCloseTo(27, 9);
    runTicks(s, 20 * TPD);
    expect(m.stock).toBeCloseTo(420, 9);
  });

  it('a suspended mine produces nothing and pays no wages; back at work it carries on', () => {
    const s = world.mine();
    park(s);
    const m = s.mines[0], d = goldOf(s);
    must(s, { type: 'setActive', kind: 'mine', id: m.id, active: false });
    expect(dailyOpsCost(s).mines).toBe(0);
    const ops = s.finance.totals.operating, maint = dailyOpsCost(s).maintenance;
    runTicks(s, 4 * TPD);
    expect(m.stock).toBe(0);
    expect(d.remaining).toBe(d.actualTons);
    expect(m.status).toBe('Suspended');
    expect(s.finance.totals.operating - ops).toBeCloseTo(4 * maint, 9);
    expect(s.finance.period.by.mine_ops ?? 0).toBe(0);
    must(s, { type: 'setActive', kind: 'mine', id: m.id, active: true });
    runTicks(s, 2 * TPD);
    expect(m.stock).toBeCloseTo(28, 9);
    expect(s.finance.period.by.mine_ops).toBe(2 * 68);
    expect(exec(s, { type: 'setActive', kind: 'mine', id: 9999, active: false }).ok).toBe(false);
  });

  it('a small deposit is mined out: remaining only falls, never below zero, and the mine stops for good', () => {
    const s = world.mine();
    const m = s.mines[0], d = goldOf(s);
    d.actualTons = d.remaining = 100.5; // a pocket, not a lode
    const startRemaining = d.remaining;
    const a = new Auditor(s);
    let last = d.remaining, exhaustedTick = -1;
    a.days(40, () => {
      expect(d.remaining).toBeLessThanOrEqual(last);
      expect(d.remaining).toBeGreaterThanOrEqual(0);
      expect(m.exhausted).toBe(d.remaining === 0);
      if (m.exhausted && exhaustedTick < 0) exhaustedTick = s.tick;
      expect(m.producedTotal).toBeLessThanOrEqual(startRemaining + 1e-9);
      last = d.remaining;
    });
    expect(d.remaining).toBe(0);
    expect(m.exhausted).toBe(true);
    expect(exhaustedTick).toBeGreaterThan(0);
    // exactly what was in the ground came out — no more
    expect(m.producedTotal).toBeCloseTo(startRemaining, 9);
    expect(m.status).toBe('Worked out');
    expect(s.notes.filter((n) => /worked out/.test(n.text)).length).toBe(1);
    // the last ore is hauled and sold, and that is all there ever is
    expect(a.sold.gold_ore).toBeCloseTo(startRemaining, 6);
    expect(m.stock).toBeCloseTo(0, 6);
    expect(s.stats.tonsSold).toBeCloseTo(startRemaining, 6);
    // no wages for a dead mine, and no second mine on dead ground
    expect(dailyOpsCost(s).mines).toBe(0);
    const produced = m.producedTotal, revenue = s.finance.totals.revenue;
    a.days(15);
    expect(m.producedTotal).toBe(produced);
    expect(s.finance.totals.revenue).toBe(revenue);
    must(s, { type: 'setActive', kind: 'mine', id: m.id, active: true });
    a.days(2);
    expect(m.producedTotal).toBe(produced);
    expect(mineSite(s, m.x + 4, m.z).error).toMatch(/worked out/);
  });

  it('with a mill beside it, an exhausted mine still never yields more than the deposit held', () => {
    const s = world.mill();
    const m = s.mines[0], l = s.mills[0], d = goldOf(s);
    d.actualTons = d.remaining = 180;
    const a = new Auditor(s);
    a.days(60);
    expect(m.exhausted).toBe(true);
    expect(m.producedTotal).toBeCloseTo(180, 9);
    expect(l.processedTotal + a.sold.gold_ore + m.stock + a.wagons('gold_ore')).toBeCloseTo(180, 6);
    expect(a.concMade.gold_conc).toBeCloseTo(l.processedTotal * 0.125 * 0.82, 9);
  });
});

describe('processing yields', () => {
  const yieldOf = (s: GameState) => RESOURCES.gold.concentrateRatio * goldOf(s).grade * millTier(s).recovery;

  /** A mill with a deep pile of ore in front of it and no train to disturb the bins. */
  function stockedMill(tier2 = false) {
    const s = world.mill();
    park(s);
    s.finance.cash = 80000;
    must(s, { type: 'setActive', kind: 'mill', id: s.mills[0].id, active: false });
    runTicks(s, 12 * TPD);
    expect(s.mines[0].stock).toBeCloseTo(168, 9);
    if (tier2) must(s, { type: 'upgrade', id: 'second_battery' });
    must(s, { type: 'setActive', kind: 'mill', id: s.mills[0].id, active: true });
    return s;
  }

  it('five stamps: each ton of ore yields ratio × grade × 82% of concentrate, at no more than 20 t/day', () => {
    const s = stockedMill();
    const m = s.mines[0], l = s.mills[0];
    expect(yieldOf(s)).toBeCloseTo(0.125 * 1 * 0.82, 12);
    const p0 = l.processedTotal, st0 = l.stock;
    for (let i = 0; i < 3 * TPD; i++) {
      const before = { ore: m.stock, conc: l.stock, done: l.processedTotal, produced: m.producedTotal };
      tick(s);
      const took = l.processedTotal - before.done;
      expect(took).toBeCloseTo(MILL.tiers[0].throughput * dt, 9); // ore is plentiful: the battery runs flat out, and no faster
      expect(took).toBeLessThanOrEqual(MILL.tiers[0].throughput * dt + 1e-12);
      expect(l.stock - before.conc).toBeCloseTo(took * yieldOf(s), 12);
      expect(m.stock - before.ore).toBeCloseTo(m.producedTotal - before.produced - took, 9);
    }
    expect(l.processedTotal - p0).toBeCloseTo(60, 9);
    expect(l.stock - st0).toBeCloseTo(60 * 0.1025, 9);
    expect(l.status).toMatch(/Five-stamp mill/);
  });

  it('ten stamps (second battery): 42 t/day at 90% recovery', () => {
    const s = stockedMill(true);
    const l = s.mills[0];
    expect(millTier(s)).toBe(MILL.tiers[1]);
    expect(yieldOf(s)).toBeCloseTo(0.125 * 0.9, 12);
    for (let i = 0; i < 2 * TPD; i++) {
      const before = { conc: l.stock, done: l.processedTotal };
      tick(s);
      const took = l.processedTotal - before.done;
      expect(took).toBeCloseTo(42 * dt, 9);
      expect(l.stock - before.conc).toBeCloseTo(took * 0.1125, 12);
    }
    expect(l.processedTotal).toBeCloseTo(84, 9);
    expect(l.stock).toBeCloseTo(84 * 0.1125, 9);
  });

  it('a richer deposit yields proportionally more', () => {
    const s = stockedMill();
    goldOf(s).grade = 1.4;
    const l = s.mills[0];
    const c0 = l.stock, p0 = l.processedTotal;
    runTicks(s, TPD);
    expect(l.stock - c0).toBeCloseTo((l.processedTotal - p0) * 0.125 * 1.4 * 0.82, 9);
  });

  it('when ore is short the mill treats only what the mine delivers', () => {
    const s = world.mill();
    park(s);
    const m = s.mines[0], l = s.mills[0];
    runTicks(s, 10 * TPD);
    expect(l.processedTotal).toBeCloseTo(m.producedTotal, 9); // 14 t/day mined < 20 t/day capacity
    expect(l.processedTotal).toBeCloseTo(140, 9);
    expect(m.stock).toBeCloseTo(0, 9);
    expect(l.stock).toBeCloseTo(140 * 0.1025, 9);
  });

  it('the mill stops when the concentrate bins are full, and the ore backs up at the mine', () => {
    const s = world.mill();
    park(s);
    const m = s.mines[0], l = s.mills[0];
    const cap = MILL.tiers[0].capacity;
    runTicks(s, 50 * TPD, () => expect(l.stock).toBeLessThanOrEqual(cap + 1e-9));
    expect(l.stock).toBeCloseTo(cap, 9);
    expect(l.processedTotal * 0.1025).toBeCloseTo(cap, 9);
    const done = l.processedTotal, ore = m.stock;
    runTicks(s, 3 * TPD);
    expect(l.processedTotal).toBeCloseTo(done, 9);
    expect(l.stock).toBeCloseTo(cap, 9);
    expect(m.stock).toBeGreaterThan(ore);
    expect(l.status).toMatch(/bins full/);
  });

  it('a suspended mill treats nothing', () => {
    const s = stockedMill();
    const m = s.mines[0], l = s.mills[0];
    must(s, { type: 'setActive', kind: 'mill', id: l.id, active: false });
    const before = { conc: l.stock, done: l.processedTotal, ore: m.stock };
    runTicks(s, 3 * TPD);
    expect(l.stock).toBe(before.conc);
    expect(l.processedTotal).toBe(before.done);
    expect(m.stock).toBeCloseTo(before.ore + 42, 9);
    expect(l.status).toBe('Suspended');
  });

  it('running costs are charged only while the works are active', () => {
    const s = world.mill();
    park(s);
    const m = s.mines[0], l = s.mills[0];
    const maint = dailyOpsCost(s).maintenance;
    expect(dailyOpsCost(s)).toMatchObject({ mines: 68, mills: 62, trains: 0 });
    const day = (fn?: () => void) => { fn?.(); const o = s.finance.totals.operating; runTicks(s, TPD); return s.finance.totals.operating - o; };
    expect(day()).toBeCloseTo(68 + 62 + maint, 9);
    expect(day(() => must(s, { type: 'setActive', kind: 'mill', id: l.id, active: false }))).toBeCloseTo(68 + maint, 9);
    expect(day(() => must(s, { type: 'setActive', kind: 'mine', id: m.id, active: false }))).toBeCloseTo(maint, 9);
    expect(day(() => must(s, { type: 'setActive', kind: 'mill', id: l.id, active: true }))).toBeCloseTo(62 + maint, 9);
    s.finance.cash = 50000;
    must(s, { type: 'upgrade', id: 'second_battery' });
    must(s, { type: 'upgrade', id: 'steam_drills' });
    expect(day(() => must(s, { type: 'setActive', kind: 'mine', id: m.id, active: true }))).toBeCloseTo(96 + 88 + maint, 9);
    const by = { ...s.finance.period.by };
    for (const p of s.finance.history) for (const [k, v] of Object.entries(p.by)) (by as Record<string, number>)[k] = ((by as Record<string, number>)[k] ?? 0) + (v ?? 0);
    expect(by.mill_ops).toBe(62 + 62 + 88);
    expect(by.mine_ops).toBe(68 + 68 + 96);
  });
});
