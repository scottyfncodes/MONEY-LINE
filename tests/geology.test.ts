import { describe, expect, it } from 'vitest';
import { FINANCE, RESOURCES, SURVEY } from '../src/sim/config';
import { claimPrice, estimate, surveyCost } from '../src/sim/geology';
import { exec, newGame } from '../src/sim/sim';
import type { Deposit, GameState } from '../src/sim/types';
import { SEED, expectUnchanged, must, roundTrip, snapshot, world } from './helpers';

const silverOf = (s: GameState) => s.deposits[1];
const coalOf = (s: GameState) => s.deposits[2];

describe('geology is fixed by the seed', () => {
  it('the same seed buries the same deposits; another seed buries different tonnages', () => {
    const a = newGame(SEED), b = newGame(SEED), c = newGame(SEED + 1);
    expect(a.deposits).toEqual(b.deposits);
    expect(a.deposits.map((d) => d.actualTons)).not.toEqual(c.deposits.map((d) => d.actualTons));
    expect(a.deposits.map((d) => [d.resource, d.discovered, d.owned])).toEqual([['gold', true, true], ['silver', false, false], ['coal', false, false]]);
    expect(silverOf(a).rumor).not.toBeNull();
    expect(silverOf(a).hiddenExtension).toBeGreaterThan(0);
    for (const d of a.deposits) { expect(d.remaining).toBe(d.actualTons); expect(Math.abs(d.bias)).toBeLessThanOrEqual(0.25); }
  });

  it('prospecting the same spot in two fresh games finds the same deposit', () => {
    const runs = [newGame(SEED), newGame(SEED)].map((s) => {
      const at = silverOf(s).rumor!;
      const found = must<Deposit[]>(s, { type: 'prospect', x: at.x, z: at.z });
      return { s, found };
    });
    expect(runs[0].found.length).toBe(1);
    expect(runs[0].found).toEqual(runs[1].found);
    expect(runs[0].found[0]).toMatchObject({ resource: 'silver', discovered: true, owned: false, surveyLevel: 0, rumor: null, extensionFound: false });
    expect(runs[0].s.deposits).toEqual(runs[1].s.deposits);
    expect(runs[0].s.finance.cash).toBe(FINANCE.startCash - SURVEY.prospectCost);
    expect(runs[0].s.stats.discoveries).toBe(1);
    expect(runs[0].s.events.filter((e) => e.type === 'discovery').length).toBe(1);
  });

  it('prospecting barren ground costs the fee and finds nothing, every time', () => {
    const s = newGame(SEED);
    for (let k = 1; k <= 3; k++) {
      const found = must<Deposit[]>(s, { type: 'prospect', x: 110, z: 115 });
      expect(found).toEqual([]);
      expect(s.finance.cash).toBe(FINANCE.startCash - k * SURVEY.prospectCost);
    }
    expect(s.stats.discoveries).toBe(0);
    expect(s.deposits).toEqual(newGame(SEED).deposits);
  });

  it('a deposit is discovered once: prospecting it again finds nothing new and resets nothing', () => {
    const s = newGame(SEED);
    const d = silverOf(s);
    must(s, { type: 'prospect', x: d.x, z: d.z });
    must(s, { type: 'survey', deposit: d.id });
    must(s, { type: 'survey', deposit: d.id });
    expect(d.surveyLevel).toBe(2);
    const again = must<Deposit[]>(s, { type: 'prospect', x: d.x, z: d.z });
    expect(again).toEqual([]);
    expect(d.surveyLevel).toBe(2);
    expect(s.stats.discoveries).toBe(1);
  });

  it('prospecting reaches about nine cells: near the vein finds it, across the valley does not', () => {
    const reach = SURVEY.prospectRadius + 5 * 0.4;
    const near = newGame(SEED), far = newGame(SEED);
    const d = silverOf(near);
    expect(must<Deposit[]>(near, { type: 'prospect', x: d.x + reach - 0.1, z: d.z }).length).toBe(1);
    expect(must<Deposit[]>(far, { type: 'prospect', x: d.x + reach + 0.1, z: d.z }).length).toBe(0);
    // coal lies elsewhere and is found on its own
    const c = coalOf(far);
    expect(must<Deposit[]>(far, { type: 'prospect', x: c.x, z: c.z }).map((q) => q.id)).toEqual([c.id]);
  });

  it('undiscovered ground cannot be surveyed, claimed or sold', () => {
    const s = newGame(SEED);
    const before = snapshot(s);
    for (const c of [{ type: 'survey', deposit: silverOf(s).id }, { type: 'buyClaim', deposit: silverOf(s).id }, { type: 'sellClaim', deposit: silverOf(s).id }, { type: 'survey', deposit: 777 }] as const) {
      expect(exec(s, c).ok).toBe(false);
    }
    expectUnchanged(s, before);
  });
});

describe('the hidden extension of the Sawtooth vein', () => {
  const drill = (s: GameState) => {
    const d = silverOf(s);
    must(s, { type: 'prospect', x: d.x, z: d.z });
    const log: Array<{ level: number; found: boolean; actual: number; remaining: number; cost: number }> = [];
    for (let k = 0; k < 3; k++) {
      const cash = s.finance.cash;
      must(s, { type: 'survey', deposit: d.id });
      log.push({ level: d.surveyLevel, found: d.extensionFound, actual: d.actualTons, remaining: d.remaining, cost: cash - s.finance.cash });
    }
    return log;
  };

  it('is the same size in every run of the seed and differs between seeds', () => {
    const sizes = [SEED, SEED, SEED].map((seed) => silverOf(newGame(seed)).hiddenExtension);
    expect(new Set(sizes).size).toBe(1);
    const base = silverOf(newGame(SEED)).actualTons;
    expect(sizes[0]).toBeGreaterThanOrEqual(Math.round(base * 0.3) - 1);
    expect(sizes[0]).toBeLessThanOrEqual(Math.round(base * 0.5) + 1);
    expect(new Set([1, 7, SEED, 4242].map((seed) => silverOf(newGame(seed)).hiddenExtension)).size).toBeGreaterThan(1);
  });

  it('is found only by core drilling (survey level 3), exactly once, identically in two runs', () => {
    const a = newGame(SEED), b = newGame(SEED);
    const base = silverOf(a).actualTons, ext = silverOf(a).hiddenExtension;
    const la = drill(a), lb = drill(b);
    expect(la).toEqual(lb);
    expect(la.map((q) => q.level)).toEqual([1, 2, 3]);
    expect(la.map((q) => q.found)).toEqual([false, false, true]);
    expect(la.map((q) => q.actual)).toEqual([base, base, base + ext]);
    expect(la.map((q) => q.remaining)).toEqual([base, base, base + ext]);
    expect(la.map((q) => q.cost)).toEqual([SURVEY.prospectCost, SURVEY.testPitCost, SURVEY.drillCost]);
    expect(a.stats.discoveries).toBe(2); // the vein, then its extension
    expect(a.events.filter((e) => e.type === 'discovery').length).toBe(2);
    expect(a.deposits).toEqual(b.deposits);

    // there is nothing more to learn, and no second extension
    const before = snapshot(a);
    const r = exec(a, { type: 'survey', deposit: silverOf(a).id });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already been core-drilled/);
    expect(surveyCost(a, silverOf(a))).toBeNull();
    expectUnchanged(a, before);
    // not after a save and load either
    const loaded = roundTrip(a);
    expect(loaded.deposits).toEqual(a.deposits);
    expect(exec(loaded, { type: 'survey', deposit: silverOf(loaded).id }).ok).toBe(false);
    expect(silverOf(loaded).actualTons).toBe(base + ext);
    // nor by re-prospecting, nor by selling the claim and filing it again
    a.finance.cash = 100000;
    must(a, { type: 'prospect', x: silverOf(a).x, z: silverOf(a).z });
    must(a, { type: 'buyClaim', deposit: silverOf(a).id });
    must(a, { type: 'sellClaim', deposit: silverOf(a).id });
    must(a, { type: 'buyClaim', deposit: silverOf(a).id });
    expect(exec(a, { type: 'survey', deposit: silverOf(a).id }).ok).toBe(false);
    expect(silverOf(a).actualTons).toBe(base + ext);
    expect(silverOf(a).remaining).toBe(base + ext);
    expect(a.stats.discoveries).toBe(2);
  });

  it('gold and coal have no extension: drilling them adds no ore', () => {
    const s = newGame(SEED);
    s.finance.cash = 100000;
    const g = s.deposits[0], tons = g.actualTons;
    must(s, { type: 'survey', deposit: g.id });
    must(s, { type: 'survey', deposit: g.id });
    expect(g.surveyLevel).toBe(3);
    expect(g.actualTons).toBe(tons);
    expect(g.remaining).toBe(tons);
    expect(g.extensionFound).toBe(false);
    expect(exec(s, { type: 'survey', deposit: g.id }).ok).toBe(false);
  });
});

describe('estimates, surveys and claims', () => {
  it('the estimate narrows with every survey and always brackets the truth', () => {
    for (const seed of [1, 7, SEED, 4242]) {
      const s = newGame(seed);
      s.finance.cash = 100000;
      for (const d of s.deposits) {
        if (!d.discovered) must(s, { type: 'prospect', x: d.x, z: d.z });
        let width = Infinity;
        for (;;) {
          const e = estimate(d);
          expect(e.low).toBeLessThanOrEqual(e.mid);
          expect(e.mid).toBeLessThanOrEqual(e.high);
          expect(e.low - 50).toBeLessThanOrEqual(d.actualTons);
          expect(e.high + 50).toBeGreaterThanOrEqual(d.actualTons);
          expect(e.confidence).toBeCloseTo(1 - SURVEY.uncertainty[d.surveyLevel], 12);
          const w = (e.high - e.low) / e.mid; // relative width: the silver vein itself grows when the drill finds its extension
          expect(w).toBeLessThan(width);
          width = w;
          if (d.surveyLevel === 3) { expect(Math.abs(e.mid - d.actualTons) / d.actualTons).toBeLessThan(0.04); break; }
          must(s, { type: 'survey', deposit: d.id });
        }
      }
    }
  });

  it('the estimate follows the ore as it is mined', () => {
    const s = world.mine();
    const d = s.deposits[0];
    const e0 = estimate(d);
    d.remaining -= 1000;
    const e1 = estimate(d);
    expect(e0.mid - e1.mid).toBe(1000);
    d.remaining = 0;
    expect(estimate(d).low).toBe(0);
    expect(estimate(d).mid).toBeGreaterThanOrEqual(0);
  });

  it('an assay office takes 40% off test pits and drilling, not off prospecting', () => {
    const s = newGame(SEED);
    s.finance.cash = 100000;
    const d = silverOf(s);
    must(s, { type: 'prospect', x: d.x, z: d.z });
    must(s, { type: 'upgrade', id: 'assay_office' });
    expect(surveyCost(s, d)).toBe(SURVEY.prospectCost);
    must(s, { type: 'survey', deposit: d.id });
    expect(surveyCost(s, d)).toBe(Math.round(SURVEY.testPitCost * SURVEY.assayDiscount));
    must(s, { type: 'survey', deposit: d.id });
    expect(surveyCost(s, d)).toBe(Math.round(SURVEY.drillCost * SURVEY.assayDiscount));
    const cash = s.finance.cash;
    must(s, { type: 'survey', deposit: d.id });
    expect(cash - s.finance.cash).toBe(Math.round(SURVEY.drillCost * SURVEY.assayDiscount));
    expect(s.finance.totals.operating).toBe(SURVEY.prospectCost * 2 + Math.round(SURVEY.testPitCost * 0.6) + Math.round(SURVEY.drillCost * 0.6));
  });

  it('a claim is filed once at the quoted price; proven ground and a nearby railroad make it dearer', () => {
    const s = newGame(SEED);
    s.finance.cash = 100000;
    const d = silverOf(s);
    must(s, { type: 'prospect', x: d.x, z: d.z });
    const p0 = claimPrice(s, d);
    expect(p0).toBe(Math.round((RESOURCES.silver.claimBase * d.grade * 0.5) / 50) * 50);
    must(s, { type: 'survey', deposit: d.id });
    const p1 = claimPrice(s, d);
    expect(p1).toBeGreaterThan(p0);
    const cash = s.finance.cash;
    must(s, { type: 'buyClaim', deposit: d.id });
    expect(cash - s.finance.cash).toBe(p1);
    expect(d.owned).toBe(true);
    expect(s.finance.period.by.claims).toBe(p1);
    const before = snapshot(s);
    const again = exec(s, { type: 'buyClaim', deposit: d.id });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already holds/);
    expectUnchanged(s, before);

    const railed = world.line();
    const c = coalOf(railed);
    railed.finance.cash = 100000;
    must(railed, { type: 'prospect', x: c.x, z: c.z });
    const lone = newGame(SEED);
    must(lone, { type: 'prospect', x: c.x, z: c.z });
    expect(claimPrice(railed, coalOf(railed))).toBeGreaterThan(claimPrice(lone, coalOf(lone)));
  });

  it('flipping a claim always loses money, and a claim with a mine on it cannot be sold', () => {
    const s = newGame(SEED);
    s.finance.cash = 100000;
    const d = silverOf(s);
    must(s, { type: 'prospect', x: d.x, z: d.z });
    for (let k = 0; k < 3; k++) must(s, { type: 'survey', deposit: d.id });
    for (let k = 0; k < 4; k++) {
      const cash = s.finance.cash;
      const p = claimPrice(s, d);
      must(s, { type: 'buyClaim', deposit: d.id });
      must(s, { type: 'sellClaim', deposit: d.id });
      expect(d.owned).toBe(false);
      expect(s.finance.cash).toBe(cash - p + Math.round(p * FINANCE.resaleFactor));
      expect(s.finance.cash).toBeLessThan(cash);
    }
    expect(s.finance.totals.revenue).toBe(0); // a claim sale is never booked as revenue
    const before = snapshot(s);
    expect(exec(s, { type: 'sellClaim', deposit: d.id }).ok).toBe(false);
    expectUnchanged(s, before);

    const m = world.mine();
    const b2 = snapshot(m);
    const r = exec(m, { type: 'sellClaim', deposit: m.deposits[0].id });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/working mine/);
    expectUnchanged(m, b2);
  });
});
