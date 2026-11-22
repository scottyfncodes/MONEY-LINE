import { describe, expect, it } from 'vitest';
import { FINANCE, MILL, MINE, STATION, UPGRADES, WAGON } from '../src/sim/config';
import { suggestRoute } from '../src/sim/autoroute';
import { availableCredit, price } from '../src/sim/economy';
import { millSite, mineSite, mineTier } from '../src/sim/facilities';
import { claimPrice, estimate } from '../src/sim/geology';
import { OBJECTIVES } from '../src/sim/objectives';
import { connected, findPath, previewLine } from '../src/sim/rail';
import { exec, newGame } from '../src/sim/sim';
import { heightAt, padRelief } from '../src/sim/terrain';
import { cargoTons, planService, tripPose } from '../src/sim/trains';
import type { Deposit, GameState, Mill, Mine, SimEvent, Station } from '../src/sim/types';
import { Auditor, SEED, TPD, bookCash, claimRailhead, countDiff, goldOf, levelSite, lineEnd, must, prepareSite } from './helpers';

/**
 * The complete first mining-to-market loop, played through the public command API on one continuous game.
 * Every tick of the whole run goes through the Auditor: no negative inventory anywhere, ore and concentrate conserved,
 * revenue only from trains unloading at the day's price, and
 *   cash == startCash + borrowed − repaid + revenue + asset sales − operating − interest − capital   (to the cent).
 */
describe('the first mining-to-market loop, end to end', () => {
  const s: GameState = newGame(SEED);
  const a = new Auditor(s);
  const pristine = newGame(SEED);
  const titles = OBJECTIVES.map((o) => o.title);
  const objectiveEvents = () => s.events.filter((e): e is Extract<SimEvent, { type: 'objective' }> => e.type === 'objective').map((e) => e.index);
  const objectiveDay: number[] = [];
  const each = () => { while (objectiveDay.length < s.objective) objectiveDay.push(s.day); };
  const step = (n = 1) => a.run(n, each);
  let way: Array<{ x: number; z: number }> = [];
  let mine: Mine, mill: Mill, siding: Station;
  let millPad = { x: 0, z: 0 };

  it('the objectives list is the guided path this test follows', () => {
    expect(titles).toEqual(['Raise the capital', 'Lay track to the Eureka claim', 'Open the Eureka mine', 'Build a loading platform',
      'Sell the first shipment', 'Raise a stamp mill', 'Close a month in the black', 'Improve the works', 'Find the second strike']);
    expect(titles.indexOf('Improve the works')).toBe(7);
  });

  it('1. begins in the city: one engine at the terminal, four hoppers, $18,000, no debt, no railroad', () => {
    expect(a.cashOffset).toBe(0);
    expect(s.day).toBe(0);
    expect(s.objective).toBe(0);
    expect(s.finance.cash).toBe(FINANCE.startCash);
    expect(s.finance.debt).toBe(0);
    expect(s.edges.length + s.jobs.length + s.mines.length + s.mills.length).toBe(0);
    expect(s.stations.length).toBe(1);
    expect(s.stations[0]).toMatchObject({ city: true, node: s.city.node, id: s.city.station });
    expect(s.trains.length).toBe(1);
    expect(s.trains[0]).toMatchObject({ phase: 'idle', at: s.city.station, home: s.city.station, dest: null, wagons: 4, loco: 'tank' });
    expect(s.wagonsOwned).toBe(4);
    expect(Math.hypot(s.nodes[0].x - s.city.x, s.nodes[0].z - s.city.z)).toBeLessThan(s.city.radius);
    // time passes and nothing happens: nothing is earned or spent
    step(TPD);
    expect(s.day).toBe(1);
    expect(s.finance.cash).toBe(FINANCE.startCash);
    expect(s.objective).toBe(0);
  });

  it('2. inspects the terrain and the claim: the gold is owned, up in the hills across the river, and out of reach of $18,000', () => {
    const g = goldOf(s);
    expect(g).toMatchObject({ resource: 'gold', owned: true, discovered: true, surveyLevel: 1 });
    const e = estimate(g);
    expect(e.low).toBeGreaterThan(0);
    expect(e.low).toBeLessThan(e.high);
    expect(e.low - 50).toBeLessThanOrEqual(g.actualTons);
    expect(e.high + 50).toBeGreaterThanOrEqual(g.actualTons);
    expect(e.confidence).toBeCloseTo(0.55, 9);
    // the claim is higher than the city, and the river lies between
    expect(heightAt(s, g.x, g.z)).toBeGreaterThan(s.city.h + 5);
    let river = false;
    for (let x = Math.floor(s.city.x); x < g.x; x++) if (s.water[Math.floor(80) * s.size + x]) river = true;
    expect(river).toBe(true);
    // nothing can be built up there yet: machinery comes by rail
    expect(mineSite(s, g.x, g.z).error).toMatch(/No railroad here yet/);
    // the surveyor's line is sound but costs more than the company has
    way = suggestRoute(s, s.nodes[0], claimRailhead(s))!;
    const pv = previewLine(s, way);
    expect(pv.error).toBeNull();
    expect(pv.plan.total).toBeGreaterThan(s.finance.cash);
    const r = exec(s, { type: 'buildLine', way });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Short by/);
    expect(s.jobs.length).toBe(0);
    expect(s.finance.cash).toBe(FINANCE.startCash);
  });

  it('3. borrows from the bank → objective "Raise the capital"', () => {
    expect(availableCredit(s)).toBeGreaterThanOrEqual(45000);
    must(s, { type: 'borrow', amount: 45000 });
    expect(s.finance.cash).toBe(FINANCE.startCash + 45000);
    expect(s.finance.debt).toBe(45000);
    expect(s.objective).toBe(0); // objectives are checked by the simulation, on the next tick
    step();
    expect(s.objective).toBe(1);
    expect(s.notes.some((n) => n.text === 'Done: Raise the capital.')).toBe(true);
  });

  it('4. modifies the landscape: pays to grade a hillside beside the claim into a level pad for the future mill', () => {
    const g = goldOf(s), head = claimRailhead(s);
    const line = previewLine(s, way).plan.pts;
    const clearOfLine = (x: number, z: number) => line.every((p) => Math.hypot(p.x - x, p.z - z) >= 4);
    // rough ground near the claim, within reach of where the siding will stand, clear of the line and of the lode's centre
    const spots: Array<{ x: number; z: number; relief: number }> = [];
    for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) {
      const x = g.x + dx, z = g.z + dz, d = Math.hypot(dx, dz);
      if (d < 4.5 || d > 6 || Math.hypot(x - head.x, z - head.z) > STATION.serviceRadius - 1 || !clearOfLine(x, z)) continue;
      const relief = padRelief(s, x, z, MILL.footprint);
      if (relief > MILL.maxPadRelief && Number.isFinite(relief)) spots.push({ x, z, relief });
    }
    spots.sort((p, q) => p.relief - q.relief);
    const spot = spots.find((c) => { const trial = structuredClone(s); trial.finance.cash = 1e9; return levelSite(trial, 'mill', c.x, c.z) > 0; })!;
    expect(spot, 'a hillside that can be graded').toBeDefined();
    const cash = s.finance.cash;
    const ops = levelSite(s, 'mill', spot.x, spot.z);
    expect(ops).toBeGreaterThan(0);
    const cost = cash - s.finance.cash;
    expect(cost).toBeGreaterThan(0);
    expect(s.finance.period.by.terrain).toBe(cost);
    expect(s.finance.totals.capital).toBe(cost);
    expect(s.stats.terrainEdits).toBe(ops);
    expect(padRelief(s, spot.x, spot.z, MILL.footprint)).toBeLessThan(spot.relief);
    expect(padRelief(s, spot.x, spot.z, MILL.footprint)).toBeLessThanOrEqual(MILL.maxPadRelief);
    expect(countDiff(s.height, pristine.height)).toBeGreaterThan(5);
    expect(s.events.some((e) => e.type === 'dig' || e.type === 'blast')).toBe(true);
    millPad = { x: spot.x, z: spot.z };
    a.check();
  });

  it('5. builds a railroad to the deposit → objective "Lay track to the Eureka claim"', () => {
    const pv = previewLine(s, way);
    expect(pv.error).toBeNull();
    const cash = s.finance.cash, changedBefore = countDiff(s.height, pristine.height);
    must(s, { type: 'buildLine', way });
    expect(cash - s.finance.cash).toBe(pv.plan.total);
    expect(s.jobs.length).toBe(1);
    step(TPD);
    expect(s.objective).toBe(1); // signing the contract is not reaching the claim
    expect(a.until(() => s.jobs.length === 0, 80, each)).toBe(true);
    expect(Math.abs(s.day - 1 - pv.plan.buildDays)).toBeLessThan(1.5);
    expect(s.edges.length).toBe(1);
    const end = lineEnd(s);
    expect(connected(s, s.city.node, end.id)).toBe(true);
    expect(findPath(s, s.city.node, end.id)!.length).toBeCloseTo(pv.plan.length, 6);
    expect(Math.hypot(end.x - goldOf(s).x, end.z - goldOf(s).z)).toBeLessThanOrEqual(7);
    expect(s.stats.reachedClaim).toBe(true);
    expect(countDiff(s.height, pristine.height)).toBeGreaterThan(changedBefore + 100); // cuts and embankments are in the ground
    expect(s.edges[0].bridgeCells).toBeGreaterThan(0); // and a bridge over the river
    step();
    expect(s.objective).toBe(2);
    expect(s.finance.totals.revenue).toBe(0);
  });

  it('6. establishes a mine on the claim → objective "Open the Eureka mine"', () => {
    const g = goldOf(s), end = lineEnd(s);
    const cash = s.finance.cash, edits = s.stats.terrainEdits;
    // on the lode, within reach of the railhead, leaving the graded pad free for the mill
    const site = prepareSite(s, 'mine', g.x, g.z, 5, (x, z) => Math.hypot(x - end.x, z - end.z) <= STATION.serviceRadius - 0.5
      && Math.hypot(x - millPad.x, z - millPad.z) >= 4.5 && Math.hypot(x - millPad.x, z - millPad.z) <= MILL.mineRadius - 0.5);
    const grading = cash - s.finance.cash;
    expect(s.stats.terrainEdits).toBe(edits + site.graded);
    expect(mineSite(s, site.x, site.z)).toMatchObject({ error: null, deposit: { id: g.id } });
    mine = must<Mine>(s, { type: 'mine', x: site.x, z: site.z });
    expect(cash - s.finance.cash).toBe(MINE.cost + grading);
    expect(s.mines).toHaveLength(1);
    expect(mine.deposit).toBe(g.id);
    expect(padRelief(s, mine.x, mine.z, MINE.footprint)).toBe(0);
    step();
    expect(s.objective).toBe(3);
  });

  it('7. extracts ore: the stockpile grows by exactly what the deposit loses', () => {
    const g = goldOf(s);
    const rem = g.remaining;
    expect(rem).toBeCloseTo(g.actualTons - mine.stock, 9);
    step(2 * TPD);
    const outOfGround = rem - g.remaining;
    expect(outOfGround).toBeCloseTo(2 * MINE.tiers[0].rate, 6);
    expect(mine.stock).toBeCloseTo(g.actualTons - g.remaining, 9);
    expect(mine.stock).toBeGreaterThan(27);
    expect(s.objective).toBe(3);
    expect(s.finance.totals.revenue).toBe(0); // ore on a stockpile is a cost, not a business
    expect(s.finance.period.by.mine_ops ?? 0).toBeGreaterThan(0);
  });

  it('8a. opens a loading platform at the railhead → objective "Build a loading platform"; the Prospector takes the service', () => {
    const end = lineEnd(s);
    const cash = s.finance.cash;
    siding = must<Station>(s, { type: 'platform', x: end.x, z: end.z });
    expect(cash - s.finance.cash).toBe(STATION.platformCost);
    expect(Math.hypot(siding.x - mine.x, siding.z - mine.z)).toBeLessThanOrEqual(STATION.serviceRadius);
    expect(s.trains[0].dest).toBe(siding.id);
    const plan = planService(s, s.trains[0], siding);
    expect(plan.ok).toBe(true);
    expect(plan.consist).toBe(4);
    step();
    expect(s.objective).toBe(4);
    expect(s.trains[0].phase).toBe('outbound');
  });

  it('8b. first raw-ore shipment: loaded at the siding, hauled to the city, sold → objective "Sell the first shipment"', () => {
    const t = s.trains[0];
    expect(a.until(() => t.phase === 'loading', 10, each)).toBe(true);
    expect(t.at).toBe(siding.id);
    expect(a.until(() => t.phase === 'inbound', 10, each)).toBe(true);
    expect(t.cargo.gold_ore).toBeCloseTo(4 * WAGON.capacity, 6);
    expect(s.finance.totals.revenue).toBe(0);
    expect(a.until(() => s.stats.firstSale, 10, each)).toBe(true);
    const sale = a.sales[0];
    expect(sale.revenue).toBe(Math.round(48 * price(s, 'gold_ore', sale.day)));
    expect(s.finance.totals.revenue).toBe(sale.revenue);
    expect(s.objective).toBe(5);
  });

  it('9. builds a stamp mill beside the mine and processes ore into concentrate', () => {
    expect(s.finance.cash).toBeGreaterThan(MILL.cost);
    // the pad graded in step 4 is what makes this site buildable
    expect(millSite(s, millPad.x, millPad.z)).toMatchObject({ error: null, mine: { id: mine.id } });
    const cash = s.finance.cash;
    mill = must<Mill>(s, { type: 'mill', x: millPad.x, z: millPad.z });
    expect(cash - s.finance.cash).toBe(MILL.cost);
    expect(Math.hypot(mill.x - siding.x, mill.z - siding.z)).toBeLessThanOrEqual(STATION.serviceRadius);
    expect(mill.mine).toBe(mine.id);
    const before = { ore: mine.stock, produced: mine.producedTotal, hauled: a.sold.gold_ore + a.wagons('gold_ore') };
    step(3 * TPD);
    expect(mill.processedTotal).toBeGreaterThan(20);
    // every ton treated yields ratio × grade × recovery of concentrate — and it came off the ore pile
    const made = mill.processedTotal * 0.125 * goldOf(s).grade * 0.82;
    expect(mill.stock + a.wagons('gold_conc') + a.sold.gold_conc).toBeCloseTo(made, 6);
    expect(made).toBeGreaterThan(2);
    const shippedRaw = a.sold.gold_ore + a.wagons('gold_ore') - before.hauled;
    expect(mine.stock).toBeCloseTo(before.ore + (mine.producedTotal - before.produced) - mill.processedTotal - shippedRaw, 6);
    expect(s.objective).toBe(5); // a mill alone does not complete "Raise a stamp mill": its concentrate has to sell
  });

  it('10. loads a train with concentrate at the siding', () => {
    const t = s.trains[0];
    expect(a.until(() => t.phase === 'loading' && (t.cargo.gold_conc ?? 0) > 1, 30, each)).toBe(true);
    expect(t.at).toBe(siding.id);
    // tick by tick: what goes into the wagons comes out of the bins (plus what the battery made that tick), and nowhere else
    let loaded = 0;
    for (let i = 0; i < 10 && t.phase === 'loading'; i++) {
      const aboard = t.cargo.gold_conc ?? 0, bins = mill.stock, treated = mill.processedTotal;
      step();
      const made = (mill.processedTotal - treated) * 0.125 * goldOf(s).grade * 0.82;
      expect((t.cargo.gold_conc ?? 0) - aboard).toBeCloseTo(bins + made - mill.stock, 9);
      expect((t.cargo.gold_conc ?? 0) - aboard).toBeLessThanOrEqual(STATION.loadRate / TPD + 1e-9);
      loaded += (t.cargo.gold_conc ?? 0) - aboard;
    }
    expect(loaded).toBeGreaterThan(0);
    expect(cargoTons(t)).toBeLessThanOrEqual(t.consist * WAGON.capacity + 1e-9);
  });

  it('11. transports it to the city: the loaded train runs the built line, across the bridge, down to the terminal', () => {
    const t = s.trains[0];
    expect(a.until(() => t.phase === 'inbound', 60, each)).toBe(true);
    const conc = t.cargo.gold_conc ?? 0;
    expect(conc).toBeGreaterThan(1);
    const start = tripPose(t.trip!, t.trip!.dist);
    expect(Math.hypot(start.x - siding.x, start.z - siding.z)).toBeLessThan(3);
    let last = t.trip!.dist, crossedBridge = false;
    const revenue = s.finance.totals.revenue;
    expect(a.until(() => t.phase !== 'inbound', 10, () => {
      each();
      if (!t.trip) return;
      expect(t.trip.dist).toBeGreaterThanOrEqual(last);
      last = t.trip.dist;
      if (tripPose(t.trip, t.trip.dist).k === 2) crossedBridge = true;
      expect(t.cargo.gold_conc ?? 0).toBe(conc); // nothing falls off on the way
      expect(s.finance.totals.revenue).toBe(revenue);
    })).toBe(true);
    expect(crossedBridge).toBe(true);
    expect(t.phase).toBe('unloading');
    expect(t.at).toBe(s.city.station);
    expect(t.cargo.gold_conc ?? 0).toBe(conc);
  });

  it('12. sells it at the day\'s price → objectives "Raise a stamp mill" and "Close a month in the black"', () => {
    const t = s.trains[0];
    const cargo = { ...t.cargo };
    const revenue = s.finance.totals.revenue, cash = s.finance.cash, sales = a.sales.length;
    expect(a.until(() => t.phase === 'idle', 3, each)).toBe(true);
    const sale = a.sales[sales];
    expect(a.sales.length).toBe(sales + 1);
    const due = Math.round((cargo.gold_conc ?? 0) * price(s, 'gold_conc', sale.day) + (cargo.gold_ore ?? 0) * price(s, 'gold_ore', sale.day));
    expect(sale.revenue).toBe(due);
    expect(s.finance.totals.revenue - revenue).toBe(due);
    expect(s.finance.cash).toBeGreaterThan(cash);
    expect(cargoTons(t)).toBe(0);
    expect(s.stats.firstConcSale).toBe(true);
    // a ton of concentrate is worth far more than a ton of ore
    expect(price(s, 'gold_conc', sale.day)).toBeGreaterThan(10 * price(s, 'gold_ore', sale.day));
    expect(s.objective).toBeGreaterThanOrEqual(6);
    // keep running the line until a calendar month closes with revenue above operating costs and interest
    expect(a.until(() => s.stats.profitableMonth, 120, each)).toBe(true);
    const month = s.finance.history.find((p) => p.revenue > 0 && p.revenue - p.operating - p.interest > 0)!;
    expect(month).toBeDefined();
    step();
    expect(s.objective).toBe(7);
  });

  it('13. uses the proceeds to buy an improvement → objective "Improve the works"', () => {
    const drills = UPGRADES.find((u) => u.id === 'steam_drills')!;
    expect(a.until(() => s.finance.cash >= drills.cost + 2000, 200, each)).toBe(true);
    expect(s.finance.totals.revenue).toBeGreaterThan(drills.cost); // it is paid for out of what the line has earned
    const cash = s.finance.cash, borrowed = s.finance.totals.borrowed;
    must(s, { type: 'upgrade', id: 'steam_drills' });
    expect(cash - s.finance.cash).toBe(drills.cost);
    expect(s.finance.totals.borrowed).toBe(borrowed);
    expect(s.upgrades.steam_drills).toBe(true);
    expect(mineTier(s).rate).toBe(27);
    step();
    expect(s.objective).toBe(8);
    // the improvement is real: the mine now raises 27 t/day
    const produced = mine.producedTotal, stock = mine.stock;
    step(TPD);
    if (stock < 300) expect(mine.producedTotal - produced).toBeCloseTo(27, 6);
  });

  it('the eight objectives of the first loop completed in order, each on or after the one before', () => {
    expect(objectiveEvents().slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(objectiveDay.length).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < objectiveDay.length; i++) expect(objectiveDay[i]).toBeGreaterThanOrEqual(objectiveDay[i - 1]);
    for (const title of titles.slice(0, 8)) expect(s.notes.some((n) => n.text === `Done: ${title}.`) || s.notes.length === 60, title).toBe(true);
    expect(s.stats).toMatchObject({ borrowedOnce: true, reachedClaim: true, firstSale: true, firstConcSale: true, profitableMonth: true, minesBuilt: 1, millsBuilt: 1, platformsBuilt: 1, upgrades: 1 });
    expect(s.stats.terrainEdits).toBeGreaterThan(0);
  });

  it('beyond the slice — the ninth objective "Find the second strike": prospect, file a claim, build a spur, open a second mine', () => {
    const coal = s.deposits[2];
    expect(a.until(() => s.finance.cash >= 16000, 200, each)).toBe(true);
    const found = must<Deposit[]>(s, { type: 'prospect', x: coal.x, z: coal.z });
    expect(found.map((d) => d.id)).toEqual([coal.id]);
    const p = claimPrice(s, coal);
    const cash = s.finance.cash;
    must(s, { type: 'buyClaim', deposit: coal.id });
    expect(cash - s.finance.cash).toBe(p);
    // a spur from the nearest point of the main line
    let from = s.edges[0].pts[5], bd = Infinity;
    for (const e of s.edges) e.pts.forEach((q, i) => { const d = Math.hypot(q.x - coal.x, q.z - coal.z); if (q.k < 2 && i > 2 && i < e.pts.length - 3 && d < bd) { bd = d; from = q; } });
    let built = false;
    for (const [dx, dz] of [[-3, -3], [-4, 0], [3, -3], [-3, 3], [4, 0], [0, 4], [3, 3]]) {
      const w = suggestRoute(s, from, { x: coal.x + dx, z: coal.z + dz });
      if (w && exec(s, { type: 'buildLine', way: w }).ok) { built = true; break; }
    }
    expect(built).toBe(true);
    expect(a.until(() => s.jobs.length === 0, 40, each)).toBe(true);
    const site = prepareSite(s, 'mine', coal.x, coal.z, 4);
    must(s, { type: 'mine', x: site.x, z: site.z });
    expect(s.objective).toBe(8);
    step();
    expect(s.stats.minesBuilt).toBe(2);
    expect(s.objective).toBe(OBJECTIVES.length);
    expect(objectiveEvents()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    step(10 * TPD);
    expect(s.mines[1].stock).toBeGreaterThan(100); // coal is softer: it comes out faster than gold ore
  });

  it('the books balance over the whole run, to the cent', () => {
    const f = s.finance, t = f.totals;
    expect(a.ticks).toBe(s.tick);
    expect(a.ticks).toBeGreaterThan(60 * TPD);
    expect(f.history.length).toBeLessThan(24); // the monthly history still holds every period, so asset sales can be summed
    expect(Math.abs(f.cash - bookCash(s))).toBeLessThan(0.01);
    expect(t.revenue).toBe(a.sales.reduce((x, q) => x + q.revenue, 0));
    const sumBy = (k: 'revenue' | 'operating' | 'interest' | 'capital') => f.history.reduce((x, p) => x + p[k], 0) + f.period[k];
    expect(sumBy('revenue')).toBeCloseTo(t.revenue, 6);
    expect(sumBy('operating')).toBeCloseTo(t.operating, 6);
    expect(sumBy('interest')).toBeCloseTo(t.interest, 6);
    expect(sumBy('capital')).toBeCloseTo(t.capital, 6);
    expect(t.borrowed - t.repaid).toBeCloseTo(f.debt, 6);
    expect(f.receivership).toBe(false);
    a.check();
  });
});
