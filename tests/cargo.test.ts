import { describe, expect, it } from 'vitest';
import { COMMODITIES, WAGON, type CommodityId } from '../src/sim/config';
import { price } from '../src/sim/economy';
import { exec } from '../src/sim/sim';
import { cargoTons } from '../src/sim/trains';
import type { GameState, SimEvent } from '../src/sim/types';
import { Auditor, SEED, TPD, bookCash, goldOf, must, openMill, world } from './helpers';

/**
 * The Auditor (tests/helpers.ts) checks on EVERY tick, to 1e-6 t:
 *   ore mined (actualTons − remaining) == mine stockpiles + ore milled + raw ore in wagons + raw ore sold
 *   concentrate owed (Σ ore milled × ratio × grade × recovery) == mill bins + concentrate in wagons + concentrate sold
 *   wagon contents change only while loading, and leave only by being sold at the terminal
 *   revenue changes only on a tick where a train finished unloading, by round(Σ tons × that day's price)
 *   no stock, cargo or material is ever negative; cash equals the ledger.
 */
describe('cargo conservation', () => {
  it('raw ore: every ton that leaves the ground is on a pile, in a wagon or sold — on every tick of 150 days', () => {
    const s = world.mine();
    const a = new Auditor(s);
    a.days(150);
    expect(a.ticks).toBe(150 * TPD);
    const d = goldOf(s), m = s.mines[0], t = s.trains[0];
    expect(a.sales.length).toBeGreaterThan(20);
    expect(d.actualTons - d.remaining).toBeGreaterThan(1500);
    expect(d.actualTons - d.remaining).toBeCloseTo(m.stock + cargoTons(t) + a.sold.gold_ore, 6);
    expect(a.sold.gold_ore).toBeCloseTo(t.hauled, 6);
    expect(a.sold.gold_ore).toBeCloseTo(s.stats.tonsSold, 6);
    expect(a.sold.gold_conc).toBe(0);
    expect(s.stats.shipmentsSold).toBe(a.sales.length);
    expect(t.tripsDone).toBe(a.sales.length);
  });

  it('with a mill: ore and concentrate both balance on every tick, and concentrate == ore milled × ratio × grade × recovery', () => {
    const s = world.mill();
    const a = new Auditor(s);
    a.days(150);
    const d = goldOf(s), m = s.mines[0], l = s.mills[0], t = s.trains[0];
    expect(l.processedTotal).toBeGreaterThan(1000);
    const made = l.processedTotal * 0.125 * d.grade * 0.82;
    expect(a.concMade.gold_conc).toBeCloseTo(made, 6);
    expect(made).toBeCloseTo(l.stock + (t.cargo.gold_conc ?? 0) + a.sold.gold_conc, 6);
    expect(d.actualTons - d.remaining).toBeCloseTo(m.stock + l.processedTotal + (t.cargo.gold_ore ?? 0) + a.sold.gold_ore, 6);
    expect(a.sold.gold_conc).toBeGreaterThan(50);
    // a ton of concentrate stands for about ten tons of rock: tonnage is not conserved across the mill, metal is
    expect(a.sold.gold_conc + a.sold.gold_ore).toBeCloseTo(s.stats.tonsSold, 6);
    expect(s.stats.tonsSold).toBeLessThan(d.actualTons - d.remaining);
  });

  it('stays exact through improvements bought mid-run (the yield changes only for ore milled afterwards)', () => {
    const s = world.mill();
    const a = new Auditor(s);
    a.days(45);
    const l = s.mills[0];
    const before = { done: l.processedTotal, made: a.concMade.gold_conc };
    expect(before.made).toBeCloseTo(before.done * 0.1025, 6);
    must(s, { type: 'borrow', amount: 5000 });
    a.until((q) => q.finance.cash >= 9000, 200);
    must(s, { type: 'upgrade', id: 'second_battery' });
    const at = { done: l.processedTotal, made: a.concMade.gold_conc };
    a.days(60);
    expect(a.concMade.gold_conc - at.made).toBeCloseTo((l.processedTotal - at.done) * 0.1125, 6);
    expect(a.concMade.gold_conc).toBeCloseTo(at.done * 0.1025 + (l.processedTotal - at.done) * 0.1125, 6);
    a.until((q) => q.finance.cash >= 10000, 200);
    must(s, { type: 'upgrade', id: 'steam_drills' });
    a.days(60);
    expect(s.mines[0].producedTotal).toBeCloseTo(goldOf(s).actualTons - goldOf(s).remaining, 6);
  });

  it('platform shipping rules move ore between the same three places and nowhere else', () => {
    const s = world.mill();
    const st = s.stations.find((q) => !q.city)!;
    const a = new Auditor(s);
    a.days(20);
    must(s, { type: 'shipRaw', station: st.id, value: false });
    const raw = a.sold.gold_ore;
    a.days(70);
    // with raw shipping off and a working mill, only concentrate travels (after the wagons already loaded are emptied)
    const lastRaw = a.sales.filter((q) => (q.cargo.gold_ore ?? 0) > 0).at(-1);
    expect(a.sold.gold_ore - raw).toBeLessThanOrEqual(4 * WAGON.capacity);
    if (lastRaw) expect(lastRaw.day).toBeLessThan(20 + 8);
    expect(a.sold.gold_conc).toBeGreaterThan(0);
    must(s, { type: 'shipRaw', station: st.id, value: true });
    a.days(30);
    expect(exec(s, { type: 'shipRaw', station: 4242, value: true }).ok).toBe(false);
  });
});

describe('commodity sales', () => {
  const saleEvents = (s: GameState) => s.events.filter((e): e is Extract<SimEvent, { type: 'sale' }> => e.type === 'sale');

  it('each shipment sells for Σ tons × the price on the day of sale, rounded to the dollar', () => {
    // a month of raw ore, then a mill goes up: raw, mixed and concentrate shipments in one history
    const s = world.mine();
    const a = new Auditor(s);
    a.days(32);
    must(s, { type: 'borrow', amount: 12000 });
    openMill(s);
    a.days(110);
    const events = saleEvents(s);
    expect(a.sales.length).toBeGreaterThanOrEqual(8);
    expect(events.length).toBe(a.sales.length);
    let total = 0, mixed = 0;
    a.sales.forEach((sale, i) => {
      let value = 0;
      for (const [c, q] of Object.entries(sale.cargo) as Array<[CommodityId, number]>) {
        const p = price({ seed: SEED }, c, sale.day);
        expect(p).toBeGreaterThanOrEqual(COMMODITIES[c].basePrice * (1 - COMMODITIES[c].swing) - 0.005);
        expect(p).toBeLessThanOrEqual(COMMODITIES[c].basePrice * (1 + COMMODITIES[c].swing) + 0.005);
        value += q * p;
      }
      expect(sale.revenue).toBe(Math.round(value));
      expect(events[i].amount).toBe(sale.revenue);
      expect(events[i]).toMatchObject({ x: s.stations[0].x, z: s.stations[0].z });
      if (Object.keys(sale.cargo).filter((c) => (sale.cargo[c as CommodityId] ?? 0) > 0).length > 1) mixed++;
      total += sale.revenue;
    });
    expect(mixed).toBeGreaterThan(0); // ore and concentrate in one train, each at its own price
    expect(s.finance.totals.revenue).toBe(total);
    const booked = s.finance.history.reduce((x, p) => x + (p.by.sales ?? 0), 0) + (s.finance.period.by.sales ?? 0);
    expect(booked).toBe(total);
    expect(s.finance.history.reduce((x, p) => x + p.revenue, 0) + s.finance.period.revenue).toBe(total);
    expect(s.finance.cash).toBeCloseTo(bookCash(s), 2);
  });

  it('the same cargo is worth more on a better day: the sale uses the price of the day the unloading finishes', () => {
    // two copies of one game, one of them delayed at the mine: same tons, different day, different money
    const a = world.mine(), b = world.mine();
    const aa = new Auditor(a), ab = new Auditor(b);
    must(b, { type: 'setActive', kind: 'mine', id: b.mines[0].id, active: false });
    ab.days(9);
    must(b, { type: 'setActive', kind: 'mine', id: b.mines[0].id, active: true });
    aa.until(() => aa.sales.length === 1, 40);
    ab.until(() => ab.sales.length === 1, 40);
    const sa = aa.sales[0], sb = ab.sales[0];
    expect(sa.cargo.gold_ore).toBeCloseTo(48, 6);
    expect(sb.cargo.gold_ore).toBeCloseTo(48, 6);
    expect(sb.day).toBeGreaterThan(sa.day);
    expect(sa.revenue).toBe(Math.round(sa.cargo.gold_ore! * price(a, 'gold_ore', sa.day)));
    expect(sb.revenue).toBe(Math.round(sb.cargo.gold_ore! * price(b, 'gold_ore', sb.day)));
    expect(price(a, 'gold_ore', sa.day)).not.toBe(price(b, 'gold_ore', sb.day));
    expect(sa.revenue).not.toBe(sb.revenue);
  });

  it('no train, no revenue: ore on the pile and concentrate in the bins earn nothing until they are hauled and unloaded', () => {
    const s = world.mill();
    must(s, { type: 'assign', train: s.trains[0].id, station: null });
    const a = new Auditor(s);
    a.days(40);
    expect(s.mills[0].stock).toBeGreaterThan(30);
    expect(s.finance.totals.revenue).toBe(0);
    expect(a.sales.length).toBe(0);
    expect(saleEvents(s).length).toBe(0);
    expect(s.stats.firstSale).toBe(false);
    // revenue appears on exactly the ticks the auditor saw a train finish unloading
    must(s, { type: 'assign', train: s.trains[0].id, station: s.stations[1].id });
    const revenueTicks: number[] = [];
    let rev = 0;
    a.days(30, (q) => { if (q.finance.totals.revenue !== rev) { revenueTicks.push(q.tick); rev = q.finance.totals.revenue; } });
    expect(revenueTicks.length).toBeGreaterThan(0);
    expect(revenueTicks).toEqual(a.sales.filter((x) => x.revenue > 0).map((x) => x.tick));
  });

  it('an empty run home sells nothing', () => {
    const s = world.mine();
    const t = s.trains[0];
    must(s, { type: 'setActive', kind: 'mine', id: s.mines[0].id, active: false });
    const a = new Auditor(s);
    a.until(() => t.phase === 'loading', 10);
    must(s, { type: 'assign', train: t.id, station: null }); // recalled with nothing aboard
    a.until(() => t.phase === 'idle', 20);
    expect(t.phase).toBe('idle');
    expect(s.finance.totals.revenue).toBe(0);
    expect(s.stats.shipmentsSold).toBe(0);
    expect(saleEvents(s).length).toBe(0);
  });
});
