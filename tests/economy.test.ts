import { describe, expect, it } from 'vitest';
import { COMMODITIES, FINANCE, LOCOS, TIME, WAGON, type CommodityId } from '../src/sim/config';
import { availableCredit, creditLimit, earn, monthlyRate, price } from '../src/sim/economy';
import { exec, newGame, runDays, tick } from '../src/sim/sim';
import type { GameState } from '../src/sim/types';
import { SEED, TPD, bookCash, expectUnchanged, must, snapshot } from './helpers';

const limitOf = (s: GameState) => Math.round((FINANCE.baseCreditLimit + s.finance.assetValue * FINANCE.creditPerAssetDollar + (s.finance.restructured ? FINANCE.restructureCredit : 0)) / 100) * 100;

describe('credit limits', () => {
  it('the bank lends up to the limit and not a dollar more', () => {
    const s = newGame(SEED);
    const limit = creditLimit(s);
    expect(limit).toBe(limitOf(s));
    expect(limit).toBeGreaterThanOrEqual(FINANCE.baseCreditLimit);
    expect(availableCredit(s)).toBe(limit);
    const before = snapshot(s);
    const over = exec(s, { type: 'borrow', amount: limit + 1 });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/lend at most/);
    expectUnchanged(s, before);
    must(s, { type: 'borrow', amount: limit });
    expect(s.finance.debt).toBe(limit);
    expect(s.finance.cash).toBe(FINANCE.startCash + limit);
    expect(availableCredit(s)).toBe(0);
    const b2 = snapshot(s);
    expect(exec(s, { type: 'borrow', amount: 1 }).ok).toBe(false);
    expectUnchanged(s, b2);
  });

  it('borrowing in pieces stops at the same limit', () => {
    const s = newGame(SEED);
    const limit = creditLimit(s);
    let drawn = 0;
    while (exec(s, { type: 'borrow', amount: 7000 }).ok) drawn += 7000;
    expect(drawn).toBe(Math.floor(limit / 7000) * 7000);
    expect(exec(s, { type: 'borrow', amount: limit - drawn + 1 }).ok).toBe(false);
    must(s, { type: 'borrow', amount: limit - drawn });
    expect(s.finance.debt).toBe(limit);
    expect(s.finance.totals.borrowed).toBe(limit);
  });

  it('borrow and repay arithmetic is exact, in whole dollars', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 1234.9 });
    expect(s.finance.debt).toBe(1234);
    expect(s.finance.cash).toBe(FINANCE.startCash + 1234);
    expect(s.finance.totals.borrowed).toBe(1234);
    expect(s.stats.borrowedOnce).toBe(true);
    must(s, { type: 'repay', amount: 234 });
    expect(s.finance.debt).toBe(1000);
    expect(s.finance.cash).toBe(FINANCE.startCash + 1000);
    expect(s.finance.totals.repaid).toBe(234);
    // a loan is not income and not an expense
    expect(s.finance.totals.revenue).toBe(0);
    expect(s.finance.totals.operating + s.finance.totals.capital + s.finance.totals.interest).toBe(0);
    expect(s.finance.cash).toBeCloseTo(bookCash(s), 9);
  });

  it('nonsense amounts are refused', () => {
    const s = newGame(SEED);
    const before = snapshot(s);
    for (const amount of [0, -500, 0.4, NaN, Infinity, -Infinity]) expect(exec(s, { type: 'borrow', amount }).ok, String(amount)).toBe(false);
    must(s, { type: 'borrow', amount: 5000 });
    const b2 = snapshot(s);
    for (const amount of [0, -500, 0.4, NaN, -Infinity]) expect(exec(s, { type: 'repay', amount }).ok, String(amount)).toBe(false);
    expectUnchanged(s, b2);
    void before;
  });

  it('repayment can exceed neither the debt nor the cash on hand', () => {
    const s = newGame(SEED);
    const none = exec(s, { type: 'repay', amount: 100 });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/nothing to repay/);
    must(s, { type: 'borrow', amount: 5000 });
    // asking to repay more than is owed repays exactly what is owed
    must(s, { type: 'repay', amount: 999999 });
    expect(s.finance.debt).toBe(0);
    expect(s.finance.cash).toBe(FINANCE.startCash);
    expect(s.finance.totals.repaid).toBe(5000);
    // spend the loan, then try to repay it out of an empty till
    must(s, { type: 'borrow', amount: 30000 });
    must(s, { type: 'buyLoco', loco: 'consolidation' });
    must(s, { type: 'buyLoco', loco: 'consolidation' });
    expect(s.finance.cash).toBeLessThan(30000);
    const before = snapshot(s);
    const r = exec(s, { type: 'repay', amount: 30000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Not enough cash/);
    expectUnchanged(s, before);
    must(s, { type: 'repay', amount: Math.floor(s.finance.cash) });
    expect(s.finance.cash).toBeGreaterThanOrEqual(0);
    expect(s.finance.cash).toBeLessThan(1);
    expect(s.finance.debt).toBeGreaterThan(0);
  });

  it('the limit grows with booked assets and shrinks when they are sold', () => {
    const s = newGame(SEED);
    const l0 = creditLimit(s), a0 = s.finance.assetValue;
    must(s, { type: 'buyLoco', loco: 'tank' });
    expect(s.finance.assetValue).toBeCloseTo(a0 + LOCOS.tank.price * FINANCE.assetBookFactor, 9);
    const l1 = creditLimit(s);
    expect(l1).toBe(limitOf(s));
    expect(l1).toBeGreaterThan(l0);
    expect(l1 - l0).toBeCloseTo(LOCOS.tank.price * FINANCE.assetBookFactor * FINANCE.creditPerAssetDollar, -2);
    must(s, { type: 'buyWagons' });
    expect(s.finance.assetValue).toBeCloseTo(a0 + (LOCOS.tank.price + WAGON.price * WAGON.batch) * FINANCE.assetBookFactor, 9);
    expect(creditLimit(s)).toBeGreaterThanOrEqual(l1);
    // the larger limit is real money
    must(s, { type: 'borrow', amount: creditLimit(s) });
    expect(s.finance.debt).toBeGreaterThan(l0);
    // selling the engine takes the collateral away again
    must(s, { type: 'sellTrain', train: s.trains[1].id });
    must(s, { type: 'sellWagons' });
    expect(s.finance.assetValue).toBeCloseTo(a0, 9);
    expect(creditLimit(s)).toBe(l0);
    expect(availableCredit(s)).toBe(0);
    expect(exec(s, { type: 'borrow', amount: 1 }).ok).toBe(false);
  });

  it('earthmoving is spent money, not collateral', () => {
    const s = newGame(SEED);
    const a0 = s.finance.assetValue, l0 = creditLimit(s);
    must(s, { type: 'terrain', op: { tool: 'fill', x: 50, z: 100, radius: 3 } });
    expect(s.finance.totals.capital).toBeGreaterThan(0);
    expect(s.finance.assetValue).toBe(a0);
    expect(creditLimit(s)).toBe(l0);
  });
});

describe('interest calculations', () => {
  it('daily interest is debt × monthly rate / 30, taken from cash and booked as interest', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 30000 });
    const daily = (30000 * FINANCE.monthlyRate) / TIME.daysPerMonth;
    expect(daily).toBe(15);
    let cash = s.finance.cash;
    for (let d = 1; d <= 12; d++) {
      for (let i = 0; i < TPD - 1; i++) { tick(s); expect(s.finance.cash).toBe(cash); } // nothing accrues inside the day
      tick(s);
      expect(s.day).toBe(d);
      expect(cash - s.finance.cash).toBeCloseTo(daily, 9);
      cash = s.finance.cash;
      expect(s.finance.totals.interest).toBeCloseTo(daily * d, 9);
      expect(s.finance.period.interest).toBeCloseTo(daily * d, 9);
      expect(s.finance.period.by.interest).toBeCloseTo(daily * d, 9);
    }
    expect(s.finance.debt).toBe(30000); // interest is paid, not capitalised, while there is cash
    expect(s.finance.totals.operating).toBe(0);
    expect(s.finance.cash).toBeCloseTo(bookCash(s), 9);
  });

  it('no debt, no interest; and interest follows the balance after a repayment', () => {
    const s = newGame(SEED);
    runDays(s, 5);
    expect(s.finance.totals.interest).toBe(0);
    expect(s.finance.cash).toBe(FINANCE.startCash);
    must(s, { type: 'borrow', amount: 20000 });
    runDays(s, 1);
    expect(s.finance.totals.interest).toBeCloseTo(10, 9);
    must(s, { type: 'repay', amount: 10000 });
    runDays(s, 1);
    expect(s.finance.totals.interest).toBeCloseTo(15, 9);
  });

  it('a loss-making month after the first sale raises the rate; a month in the black restores it', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 30000 });
    // before the first sale the bank is patient
    runDays(s, 30);
    expect(s.finance.history.length).toBe(1);
    expect(s.finance.rateAdd).toBe(0);
    expect(monthlyRate(s)).toBe(FINANCE.monthlyRate);
    // once the line has sold ore, a month that only pays interest is a loss
    s.stats.firstSale = true;
    runDays(s, 30);
    expect(s.finance.history.length).toBe(2);
    expect(s.finance.history[1].revenue - s.finance.history[1].operating - s.finance.history[1].interest).toBeLessThan(0);
    expect(s.finance.rateAdd).toBe(FINANCE.stressedRateAdd);
    expect(monthlyRate(s)).toBeCloseTo(FINANCE.monthlyRate + FINANCE.stressedRateAdd, 12);
    const cash = s.finance.cash;
    runDays(s, 1);
    expect(cash - s.finance.cash).toBeCloseTo((30000 * (FINANCE.monthlyRate + FINANCE.stressedRateAdd)) / 30, 9);
    expect(cash - s.finance.cash).toBeCloseTo(21, 9);
    // the bump does not compound month on month
    runDays(s, 29);
    expect(s.finance.rateAdd).toBe(FINANCE.stressedRateAdd);
    // a profitable month puts the rate back
    earn(s, 5000, 'sales');
    runDays(s, 30);
    expect(s.finance.history.length).toBe(4);
    expect(s.stats.profitableMonth).toBe(true);
    expect(s.finance.rateAdd).toBe(0);
    const c2 = s.finance.cash;
    runDays(s, 1);
    expect(c2 - s.finance.cash).toBeCloseTo(15, 9);
  });

  it('when cash runs out the shortfall is drawn on the credit line automatically', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 60000 });
    // spend everything on rolling stock, leaving less than a day's interest
    while (exec(s, { type: 'buyLoco', loco: 'consolidation' }).ok) { /* keep buying */ }
    while (exec(s, { type: 'buyLoco', loco: 'tank' }).ok) { /* keep buying */ }
    while (exec(s, { type: 'buyWagons' }).ok) { /* keep buying */ }
    must(s, { type: 'repay', amount: Math.floor(s.finance.cash) });
    expect(s.finance.cash).toBeLessThan(1);
    const debt0 = s.finance.debt, borrowed0 = s.finance.totals.borrowed;
    const interest = (debt0 * FINANCE.monthlyRate) / 30;
    expect(interest).toBeGreaterThan(1);
    expect(availableCredit(s)).toBeGreaterThan(1000);
    const cash0 = s.finance.cash;
    runDays(s, 1);
    const draw = Math.ceil(interest - cash0);
    expect(s.finance.debt).toBe(debt0 + draw);
    expect(s.finance.totals.borrowed).toBe(borrowed0 + draw);
    expect(s.finance.cash).toBeCloseTo(cash0 - interest + draw, 9);
    expect(s.finance.cash).toBeGreaterThanOrEqual(0);
    expect(s.finance.cash).toBeLessThan(1);
    expect(s.finance.insolventDays).toBe(0);
    for (let d = 0; d < 20; d++) { runDays(s, 1); expect(s.finance.cash).toBeGreaterThanOrEqual(0); expect(s.finance.insolventDays).toBe(0); }
    expect(s.finance.debt).toBeGreaterThan(debt0 + draw); // interest on interest
    expect(s.finance.cash).toBeCloseTo(bookCash(s), 6);
  });

  function broke(): GameState {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: creditLimit(s) });
    must(s, { type: 'terrain', op: { tool: 'fill', x: 50, z: 100, radius: 4 } }); // unbooked spending: no new collateral
    while (s.finance.cash > 2000) { if (!exec(s, { type: 'terrain', op: { tool: 'fill', x: 44 + (s.stats.terrainEdits % 9) * 4, z: 108, radius: 4 } }).ok) break; }
    while (exec(s, { type: 'prospect', x: 5, z: 5 }).ok) { /* barren ground, money gone */ }
    expect(availableCredit(s)).toBe(0);
    expect(s.finance.cash).toBeLessThan(700);
    return s;
  }

  it('out of cash and credit, the insolvency clock runs to receivership in exactly 45 days', () => {
    const s = broke();
    const debt = s.finance.debt;
    const interest = (debt * FINANCE.monthlyRate) / 30;
    const solventDays = Math.floor((s.finance.cash + 0.5) / interest);
    runDays(s, solventDays);
    expect(s.finance.insolventDays).toBe(0);
    expect(s.finance.receivership).toBe(false);
    for (let d = 1; d <= FINANCE.insolvencyDays; d++) {
      expect(s.finance.receivership).toBe(false);
      runDays(s, 1);
      expect(s.finance.insolventDays).toBe(d);
      expect(s.finance.cash).toBeLessThan(0);
      expect(s.finance.debt).toBe(debt); // no credit left to draw
    }
    expect(s.finance.receivership).toBe(true);
    expect(s.notes.some((n) => /receivership/.test(n.text))).toBe(true);
    // the company is frozen: time stops and nothing can be ordered
    const frozen = snapshot(s), t = s.tick;
    runDays(s, 3);
    expect(s.tick).toBe(t);
    for (const c of [{ type: 'borrow', amount: 100 }, { type: 'buyWagons' }, { type: 'sellWagons' }, { type: 'terrain', op: { tool: 'fill', x: 60, z: 100, radius: 1 } }] as const) {
      const r = exec(s, c);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/receivership/);
    }
    expectUnchanged(s, frozen);
    expect(s.finance.cash).toBeCloseTo(bookCash(s), 6);
  });

  it('the bank restructures once: more credit, a higher rate, and no second rescue', () => {
    const s = broke();
    runDays(s, 60 + FINANCE.insolvencyDays);
    expect(s.finance.receivership).toBe(true);
    const limit0 = creditLimit(s), cash0 = s.finance.cash, debt0 = s.finance.debt, rate0 = monthlyRate(s);
    expect(cash0).toBeLessThan(0);
    must(s, { type: 'restructure' });
    expect(s.finance.receivership).toBe(false);
    expect(s.finance.restructured).toBe(true);
    expect(s.finance.insolventDays).toBe(0);
    expect(creditLimit(s)).toBe(limit0 + FINANCE.restructureCredit);
    expect(monthlyRate(s)).toBeCloseTo(rate0 + FINANCE.restructureRateAdd, 12);
    const draw = Math.min(limit0 + FINANCE.restructureCredit - debt0, -cash0 + 5000);
    expect(s.finance.debt).toBeCloseTo(debt0 + draw, 9);
    expect(s.finance.cash).toBeCloseTo(cash0 + draw, 9);
    expect(s.finance.cash).toBeGreaterThan(0);
    expect(s.finance.cash).toBeCloseTo(bookCash(s), 6);
    // time moves again, at the new rate
    const c = s.finance.cash, t = s.tick;
    runDays(s, 1);
    expect(s.tick).toBe(t + TPD);
    expect(c - s.finance.cash).toBeCloseTo((s.finance.debt * (rate0 + FINANCE.restructureRateAdd)) / 30, 6);
    const before = snapshot(s);
    const again = exec(s, { type: 'restructure' });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already restructured/);
    expectUnchanged(s, before);
  });

  it('a healthy company cannot ask for a restructure', () => {
    const s = newGame(SEED);
    const before = snapshot(s);
    const r = exec(s, { type: 'restructure' });
    expect(r.ok).toBe(false);
    expectUnchanged(s, before);
  });
});

describe('commodity prices', () => {
  const ALL = Object.keys(COMMODITIES) as CommodityId[];
  it('are fixed by the seed and the day, whatever else has happened', () => {
    const a = newGame(SEED), b = newGame(SEED);
    must(b, { type: 'borrow', amount: 20000 });
    runDays(b, 40);
    for (const c of ALL) for (let day = 0; day < 400; day += 7) {
      expect(price(a, c, day)).toBe(price(b, c, day));
      expect(price({ seed: SEED }, c, day)).toBe(price(a, c, day));
    }
  });
  it('stay within base × (1 ± swing) for every commodity over ten years', () => {
    for (const seed of [1, 7, SEED, 4242]) for (const c of ALL) {
      const def = COMMODITIES[c];
      let lo = Infinity, hi = -Infinity;
      for (let day = 0; day <= 3600; day++) {
        const p = price({ seed }, c, day);
        if (p < lo) lo = p; if (p > hi) hi = p;
        expect(Math.round(p * 100)).toBeCloseTo(p * 100, 6); // whole cents
      }
      expect(lo).toBeGreaterThanOrEqual(def.basePrice * (1 - def.swing) - 0.005);
      expect(hi).toBeLessThanOrEqual(def.basePrice * (1 + def.swing) + 0.005);
      expect(hi).toBeGreaterThan(def.basePrice); // and they do move
      expect(lo).toBeLessThan(def.basePrice);
    }
  });
  it('differ between seeds', () => {
    let differ = 0;
    for (let day = 0; day < 200; day++) if (price({ seed: 1 }, 'gold_ore', day) !== price({ seed: 2 }, 'gold_ore', day)) differ++;
    expect(differ).toBeGreaterThan(150);
  });
});
