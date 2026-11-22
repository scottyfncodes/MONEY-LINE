/**
 * Shared drivers and auditors for the MONEY LINE simulation tests.
 * Everything here goes through the public sim API (newGame / exec / tick) exactly as the client does.
 */
import { expect } from 'vitest';
import { FINANCE, MILL, MINE, RESOURCES, STATION, TIME, WORLD, type CommodityId } from '../src/sim/config';
import { suggestRoute } from '../src/sim/autoroute';
import { price } from '../src/sim/economy';
import { millSite, millTier, mineSite } from '../src/sim/facilities';
import { previewLine } from '../src/sim/rail';
import { decodeSave, encodeSave, fromSave, toSave, type SaveFile } from '../src/sim/save';
import { exec, newGame, tick, type Command } from '../src/sim/sim';
import { padRelief, type TerrainPlan } from '../src/sim/terrain';
import type { GameState, Result, Train } from '../src/sim/types';
import { vi } from '../src/sim/worldgen';

export const SEED = 1890;
export const TPD = TIME.ticksPerDay;
export const N = WORLD.size;

/** Run a command that must succeed. */
export function must<T = unknown>(s: GameState, c: Command): T {
  const r = exec(s, c) as Result<T>;
  if (!r.ok) throw new Error(`command ${c.type} failed: ${r.error}`);
  return r.value as T;
}

/** FNV-1a over the bytes of a typed array: a cheap exact fingerprint. */
export function hashArray(a: Float32Array | Uint8Array): number {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Everything that defines the simulation, in a JSON-comparable form (typed arrays by hash). */
export function fingerprint(s: GameState) {
  return {
    tick: s.tick, day: s.day, seed: s.seed, nextId: s.nextId, objective: s.objective,
    height: hashArray(s.height), soil: hashArray(s.soil), forest: hashArray(s.forest), locked: hashArray(s.locked),
    water: hashArray(s.water), waterLevel: hashArray(s.waterLevel), baseHeight: hashArray(s.baseHeight),
    finance: structuredClone(s.finance), materials: { ...s.materials }, wagonsOwned: s.wagonsOwned,
    deposits: structuredClone(s.deposits), nodes: structuredClone(s.nodes),
    edges: s.edges.map((e) => ({ id: e.id, a: e.a, b: e.b, n: e.pts.length, length: e.length, maxGrade: e.maxGrade })),
    jobs: s.jobs.map((j) => ({ id: j.id, progress: j.progress, applied: j.applied, n: j.pts.length })),
    stations: structuredClone(s.stations), mines: structuredClone(s.mines), mills: structuredClone(s.mills),
    trains: s.trains.map((t) => ({ ...t, cargo: { ...t.cargo }, trip: t.trip ? { dist: t.trip.dist, prev: t.trip.prev, length: t.trip.length, edges: [...t.trip.edges], n: t.trip.pts.length } : null })),
    upgrades: { ...s.upgrades }, stats: { ...s.stats }, notes: s.notes.length,
  };
}

/** A complete picture of player-visible value, used to prove that a refused command changed nothing. */
export function snapshot(s: GameState) {
  const { tick: _t, ...rest } = fingerprint(s);
  void _t;
  return rest;
}
export function expectUnchanged(s: GameState, before: ReturnType<typeof snapshot>) {
  expect(snapshot(s)).toEqual(before);
}

export function runTicks(s: GameState, n: number, each?: (s: GameState) => void) {
  for (let i = 0; i < n; i++) { tick(s); each?.(s); }
}
export function runUntil(s: GameState, cond: (s: GameState) => boolean, maxDays: number, each?: (s: GameState) => void): boolean {
  for (let i = 0; i < maxDays * TPD; i++) { if (cond(s)) return true; tick(s); each?.(s); }
  return cond(s);
}

export const roundTrip = (s: GameState): GameState => fromSave(decodeSave(encodeSave(toSave(s, 0))));

/* ------------------------------------------------------------------ sites */

export const goldOf = (s: GameState) => s.deposits[0];
/** Where the first line ends: just short of the Eureka claim. */
export const claimRailhead = (s: GameState) => ({ x: goldOf(s).x - 3, z: goldOf(s).z + 4 });

function padVerts(x: number, z: number, half: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let vz = Math.floor(z - half); vz <= Math.ceil(z + half); vz++) for (let vx = Math.floor(x - half); vx <= Math.ceil(x + half); vx++) out.push([vx, vz]);
  return out;
}
const siteError = (s: GameState, kind: 'mine' | 'mill', x: number, z: number) => (kind === 'mine' ? mineSite(s, x, z).error : millSite(s, x, z).error);

function candidates(cx: number, cz: number, maxR: number): Array<{ x: number; z: number; d: number }> {
  const out: Array<{ x: number; z: number; d: number }> = [];
  for (let dz = -maxR; dz <= maxR; dz++) for (let dx = -maxR; dx <= maxR; dx++) {
    const d = Math.hypot(dx, dz);
    if (d <= maxR) out.push({ x: Math.round(cx) + dx, z: Math.round(cz) + dz, d });
  }
  return out.sort((a, b) => a.d - b.d || a.z - b.z || a.x - b.x);
}

/** First cell near a point where the works could be built as the ground stands. */
export function findSite(s: GameState, kind: 'mine' | 'mill', cx: number, cz: number, maxR = 6, also: (x: number, z: number) => boolean = () => true) {
  for (const c of candidates(cx, cz, maxR)) if (also(c.x, c.z) && siteError(s, kind, c.x, c.z) === null) return { x: c.x, z: c.z };
  return null;
}

/**
 * Terrain engineering: make a building pad level enough at (x,z) with the player's own tools.
 * Grades toward the pad's mean height, blasting any bedrock knob that picks and shovels cannot move.
 * Returns the number of paid terrain commands used, or -1 if the site could not be made.
 */
export function levelSite(s: GameState, kind: 'mine' | 'mill', x: number, z: number, maxOps = 40): number {
  const half = kind === 'mine' ? MINE.footprint : MILL.footprint;
  const limit = kind === 'mine' ? MINE.maxPadRelief : MILL.maxPadRelief;
  const verts = padVerts(x, z, half);
  let ops = 0;
  while (padRelief(s, x, z, half) > limit && ops < maxOps) {
    const hs = verts.map(([vx, vz]) => s.height[vi(vx, vz)]);
    const target = Math.round((hs.reduce((a, b) => a + b, 0) / hs.length) * 20) / 20;
    const r = exec(s, { type: 'terrain', op: { tool: 'grade', x, z, radius: 3, target } }) as Result<TerrainPlan>;
    ops++;
    if (r.ok && !r.value!.blockedByRock) continue;
    if (!r.ok && !/Bedrock/.test(r.error ?? '')) return -1;
    // bedrock stands proud of the pad: shoot the highest rock vertex
    let best: [number, number] | null = null, bh = -Infinity;
    for (const [vx, vz] of verts) { const i = vi(vx, vz); if (s.soil[i] < 0.05 && !s.locked[i] && s.height[i] > target + 0.2 && s.height[i] > bh) { bh = s.height[i]; best = [vx, vz]; } }
    if (!best) { if (!r.ok) return -1; continue; }
    const b = exec(s, { type: 'terrain', op: { tool: 'blast', x: best[0], z: best[1], radius: 0.5 } });
    ops++;
    if (!b.ok) return -1;
  }
  return padRelief(s, x, z, half) <= limit ? ops : -1;
}

/**
 * A spot near a point where the only thing wrong is that the ground is too uneven — and where the player's own tools
 * can put that right (proved on a scratch copy of the game). Nothing in the real game is touched.
 */
export function findRoughSite(s: GameState, kind: 'mine' | 'mill', cx: number, cz: number, maxR = 6, also: (x: number, z: number) => boolean = () => true) {
  const half = kind === 'mine' ? MINE.footprint : MILL.footprint;
  const rough = candidates(cx, cz, maxR)
    .filter((c) => also(c.x, c.z) && /too uneven/.test(siteError(s, kind, c.x, c.z) ?? ''))
    .filter((c) => padVerts(c.x, c.z, half).every(([vx, vz]) => !s.locked[vi(vx, vz)]))
    .sort((a, b) => padRelief(s, a.x, a.z, half) - padRelief(s, b.x, b.z, half));
  for (const c of rough.slice(0, 12)) {
    const trial = structuredClone(s);
    trial.finance.cash = 1e9;
    if (levelSite(trial, kind, c.x, c.z) >= 0 && siteError(trial, kind, c.x, c.z) === null) return { x: c.x, z: c.z };
  }
  return null;
}

/**
 * A site that is too uneven to build on as it stands. Where the world offers none within reach (a ready-made bench),
 * one good site is spoiled the way a careless player would: by dumping fill on one corner of the pad (paid for).
 */
export function roughSite(s: GameState, kind: 'mine' | 'mill', cx: number, cz: number, maxR = 6, also: (x: number, z: number) => boolean = () => true) {
  const natural = findRoughSite(s, kind, cx, cz, maxR, also);
  if (natural) return { ...natural, spoiled: false };
  const half = kind === 'mine' ? MINE.footprint : MILL.footprint;
  const site = findSite(s, kind, cx, cz, maxR, also);
  if (!site) throw new Error(`no ${kind} site of any kind near ${cx},${cz}`);
  const corner = { x: Math.floor(site.x - half), z: Math.floor(site.z - half) };
  for (let k = 0; k < 8 && siteError(s, kind, site.x, site.z) === null; k++) must(s, { type: 'terrain', op: { tool: 'fill', x: corner.x, z: corner.z, radius: 0.5 } });
  if (!/too uneven/.test(siteError(s, kind, site.x, site.z) ?? '')) throw new Error('could not spoil the pad');
  return { ...site, spoiled: true };
}

/**
 * Find a site for a mine or mill near a point; where the ground is too rough everywhere, grade one.
 * `graded` tells the caller how many paid earthmoving commands were needed (0 if the ground was ready).
 */
export function prepareSite(s: GameState, kind: 'mine' | 'mill', cx: number, cz: number, maxR = 6, also: (x: number, z: number) => boolean = () => true): { x: number; z: number; graded: number } {
  const ready = findSite(s, kind, cx, cz, maxR, also);
  if (ready) return { ...ready, graded: 0 };
  const c = findRoughSite(s, kind, cx, cz, maxR, also);
  if (!c) throw new Error(`no ${kind} site can be made near ${cx},${cz}`);
  const graded = levelSite(s, kind, c.x, c.z);
  if (graded < 0) throw new Error('could not afford to grade the site');
  return { x: c.x, z: c.z, graded };
}

/* --------------------------------------------------------------- fixtures */

export interface Built { s: GameState; way: Array<{ x: number; z: number }> }

/** Fresh game, bank loan drawn, contract for the Eureka line signed (construction still running). */
export function startLine(seed = SEED, loan = 45000): Built {
  const s = newGame(seed);
  must(s, { type: 'borrow', amount: loan });
  const way = suggestRoute(s, s.nodes[0], claimRailhead(s))!;
  must(s, { type: 'buildLine', way });
  return { s, way };
}
export function finishLine(s: GameState) {
  if (!runUntil(s, (q) => q.jobs.length === 0, 80)) throw new Error('line never finished');
}
/** Open the Eureka mine and its siding on a finished line. */
export function openMine(s: GameState) {
  const g = goldOf(s);
  const end = lineEnd(s);
  const site = prepareSite(s, 'mine', g.x, g.z, 5, (x, z) => Math.hypot(x - end.x, z - end.z) <= STATION.serviceRadius - 0.5);
  const mine = must<GameState['mines'][number]>(s, { type: 'mine', x: site.x, z: site.z });
  const station = must<GameState['stations'][number]>(s, { type: 'platform', x: end.x, z: end.z });
  return { mine, station, site };
}
export function openMill(s: GameState) {
  const mine = s.mines[0], st = s.stations.find((t) => !t.city)!;
  const site = prepareSite(s, 'mill', mine.x, mine.z, 6, (x, z) => Math.hypot(x - st.x, z - st.z) <= STATION.serviceRadius - 0.5);
  const mill = must<GameState['mills'][number]>(s, { type: 'mill', x: site.x, z: site.z });
  return { mill, site };
}
/** The node farthest from the city: the railhead of the first line. */
export function lineEnd(s: GameState) {
  let best = s.nodes[0], bd = -1;
  for (const n of s.nodes) { const d = Math.hypot(n.x - s.city.x, n.z - s.city.z); if (d > bd) { bd = d; best = n; } }
  return best;
}

const cache = new Map<string, SaveFile>();
function staged(key: string, build: () => GameState): GameState {
  let f = cache.get(key);
  if (!f) { f = toSave(build(), 0); cache.set(key, f); }
  return fromSave(f);
}
/** Cached stages of the standard opening (each call returns an independent copy). */
export const world = {
  fresh: (seed = SEED) => newGame(seed),
  /** line under construction, day 0 */
  building: () => staged('building', () => startLine().s),
  /** line finished, nothing on it yet; extra cash so later steps are not about money */
  line: () => staged('line', () => { const { s } = startLine(); finishLine(s); return s; }),
  /** mine + siding open, the Prospector assigned */
  mine: () => staged('mine', () => { const s = world.line(); openMine(s); return s; }),
  /** mine + siding + stamp mill */
  mill: () => staged('mill', () => { const s = world.mine(); must(s, { type: 'borrow', amount: 12000 }); openMill(s); return s; }),
};

/** A short spur off the first line that the engineers accept as it stands (optionally one that runs through forest). */
export function findBranch(s: GameState, opts: { forest?: boolean; length?: number } = {}) {
  const L = opts.length ?? 12;
  for (const e of s.edges) for (let i = 10; i < e.pts.length - 10; i += 5) {
    const p = e.pts[i];
    if (p.k >= 2) continue;
    for (let a = 0; a < 8; a++) {
      const way = [{ x: p.x, z: p.z }, { x: p.x + Math.cos((a * Math.PI) / 4) * L, z: p.z + Math.sin((a * Math.PI) / 4) * L }];
      const pv = previewLine(s, way);
      if (!pv.error && (!opts.forest || pv.plan.forestCells > 0)) return { way, plan: pv.plan };
    }
  }
  throw new Error('no branch line found');
}

/** Exact element-wise equality of two typed arrays (much faster than a deep-equal matcher on 16k elements). */
export function expectSame(a: ArrayLike<number>, b: ArrayLike<number>, label = 'array') {
  if (a.length !== b.length) throw new Error(`${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${label}: differs at ${i}: ${a[i]} != ${b[i]}`);
  expect(true).toBe(true);
}
export const countDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

/* ---------------------------------------------------------------- auditor */

const COMMS: CommodityId[] = ['gold_ore', 'gold_conc', 'silver_ore', 'silver_conc', 'coal'];
const zero = (): Record<CommodityId, number> => ({ gold_ore: 0, gold_conc: 0, silver_ore: 0, silver_conc: 0, coal: 0 });
export const cargoOf = (t: Train, c: CommodityId) => t.cargo[c] ?? 0;
export const assetSales = (s: GameState) => s.finance.history.reduce((a, p) => a + (p.by.asset_sale ?? 0), 0) + (s.finance.period.by.asset_sale ?? 0);
/** Cash the books say the company should hold. */
export const bookCash = (s: GameState) => {
  const t = s.finance.totals;
  return FINANCE.startCash + t.borrowed - t.repaid + t.revenue + assetSales(s) - t.operating - t.interest - t.capital;
};
export const yieldPerTon = (s: GameState, depositId: number) => {
  const d = s.deposits.find((q) => q.id === depositId)!;
  return RESOURCES[d.resource].concentrateRatio * d.grade * millTier(s).recovery;
};

/**
 * Steps the simulation one tick at a time and proves, on every tick, that nothing is created or lost:
 * ore leaves the ground only into stockpiles, mills, wagons and the market; concentrate comes only from milled ore;
 * money moves only through the ledger; revenue appears only when a train finishes unloading, at that day's price.
 */
export class Auditor {
  sold = zero();
  /** concentrate that milling should have produced, from ore milled × yield at the time */
  concMade = zero();
  expectedRevenue: number;
  sales: Array<{ tick: number; day: number; train: number; cargo: Partial<Record<CommodityId, number>>; revenue: number }> = [];
  ticks = 0;
  private remaining = new Map<number, number>();
  private produced = new Map<number, number>();
  /** cash the test put in the till by hand before the audit began (0 in an honest game) */
  readonly cashOffset: number;

  constructor(public s: GameState) {
    this.expectedRevenue = s.finance.totals.revenue;
    this.cashOffset = s.finance.cash - bookCash(s);
    // a state picked up mid-game: whatever is already unaccounted for was sold before we started watching
    for (const d of s.deposits) {
      const def = RESOURCES[d.resource];
      this.sold[def.ore] = this.mined(d.id) - this.oreHeld(d.id);
      if (def.concentrate) {
        const made = s.mills.filter((l) => this.mineDeposit(l.mine) === d.id).reduce((a, l) => a + l.processedTotal, 0) * yieldPerTon(s, d.id);
        this.concMade[def.concentrate] = made;
        this.sold[def.concentrate] = made - this.concHeld(def.concentrate);
      }
      this.remaining.set(d.id, d.remaining);
    }
    for (const m of s.mines) this.produced.set(m.id, m.producedTotal);
  }

  /** Carry the books over to another copy of the same game (after a save/load). */
  adopt(s: GameState) { this.s = s; return this; }

  private mineDeposit(mineId: number) { return this.s.mines.find((m) => m.id === mineId)?.deposit; }
  mined(depositId: number) { const d = this.s.deposits.find((q) => q.id === depositId)!; return d.actualTons - d.remaining; }
  wagons(c: CommodityId) { return this.s.trains.reduce((a, t) => a + cargoOf(t, c), 0); }
  /** ore of a deposit that is above ground and still raw or already fed to a mill */
  oreHeld(depositId: number) {
    const s = this.s, d = s.deposits.find((q) => q.id === depositId)!;
    const mines = s.mines.filter((m) => m.deposit === depositId);
    return mines.reduce((a, m) => a + m.stock, 0)
      + s.mills.filter((l) => mines.some((m) => m.id === l.mine)).reduce((a, l) => a + l.processedTotal, 0)
      + this.wagons(RESOURCES[d.resource].ore);
  }
  concHeld(c: CommodityId) {
    const s = this.s;
    const dep = s.deposits.find((d) => RESOURCES[d.resource].concentrate === c);
    if (!dep) return 0;
    return s.mills.filter((l) => this.mineDeposit(l.mine) === dep.id).reduce((a, l) => a + l.stock, 0) + this.wagons(c);
  }

  /** One audited tick. */
  step() {
    const s = this.s;
    const day = s.day, revBefore = s.finance.totals.revenue;
    const before = s.trains.map((t) => ({ id: t.id, phase: t.phase, cargo: { ...t.cargo }, dist: t.trip?.dist ?? 0, hauled: t.hauled }));
    const processed = s.mills.map((l) => ({ id: l.id, p: l.processedTotal, dep: this.mineDeposit(l.mine)! }));
    const extFound = s.deposits.map((d) => d.extensionFound);
    tick(s);
    this.ticks++;

    // milling: concentrate owed for the ore that went through the battery this tick
    for (const b of processed) {
      const l = s.mills.find((q) => q.id === b.id)!;
      const dep = s.deposits.find((d) => d.id === b.dep)!;
      const took = l.processedTotal - b.p;
      expect(took).toBeGreaterThanOrEqual(0);
      this.concMade[RESOURCES[dep.resource].concentrate!] += took * yieldPerTon(s, dep.id);
    }

    // trains: cargo only grows while loading and only leaves by being sold at the terminal
    let due = 0, sellers = 0;
    for (const b of before) {
      const t = s.trains.find((q) => q.id === b.id);
      if (!t) continue;
      const finished = b.phase === 'unloading' && t.phase === 'idle';
      if (finished) {
        let value = 0, tons = 0;
        for (const c of COMMS) { const q = b.cargo[c] ?? 0; if (q > 0) { value += q * price(s, c, day); tons += q; this.sold[c] += q; } }
        expect(Object.values(t.cargo).reduce((a, q) => a + (q ?? 0), 0), 'wagons empty after the sale').toBe(0);
        const revenue = value > 0 ? Math.round(value) : 0;
        due += revenue; if (revenue > 0) sellers++;
        expect(t.hauled - b.hauled).toBeCloseTo(tons, 9);
        this.sales.push({ tick: s.tick, day, train: t.id, cargo: b.cargo, revenue });
      } else {
        for (const c of COMMS) {
          const was = b.cargo[c] ?? 0, now = cargoOf(t, c);
          if (b.phase === 'loading') expect(now, `cargo ${c} while loading`).toBeGreaterThanOrEqual(was);
          else expect(now, `cargo ${c} changed in phase ${b.phase}`).toBe(was);
        }
      }
    }
    this.expectedRevenue += due;
    // no revenue without a train unloading at the city, and exactly that day's price when there is one
    expect(s.finance.totals.revenue - revBefore, 'revenue this tick').toBeCloseTo(due, 6);
    if (sellers === 0) expect(s.finance.totals.revenue).toBe(revBefore);
    expect(s.finance.totals.revenue).toBeCloseTo(this.expectedRevenue, 6);

    this.check(extFound);
  }

  /** The standing invariants. */
  check(extFound?: boolean[]) {
    const s = this.s;
    for (const [i, d] of s.deposits.entries()) {
      expect(d.remaining, `${d.name} remaining`).toBeGreaterThanOrEqual(0);
      expect(d.remaining).toBeLessThanOrEqual(d.actualTons);
      const grew = extFound ? d.extensionFound && !extFound[i] : false;
      if (!grew) expect(d.remaining, `${d.name} only depletes`).toBeLessThanOrEqual(this.remaining.get(d.id)! + 1e-12);
      this.remaining.set(d.id, d.remaining);
      const def = RESOURCES[d.resource];
      // ore out of the ground == stockpiles + milled + in wagons + sold raw
      expect(this.mined(d.id) - this.oreHeld(d.id) - this.sold[def.ore], `${d.name} ore balance`).toBeCloseTo(0, 6);
      const total = s.mines.filter((m) => m.deposit === d.id).reduce((a, m) => a + m.producedTotal, 0);
      expect(total, `${d.name} produced == mined`).toBeCloseTo(this.mined(d.id), 6);
      expect(total).toBeLessThanOrEqual(d.actualTons + 1e-9);
      if (def.concentrate) expect(this.concMade[def.concentrate] - this.concHeld(def.concentrate) - this.sold[def.concentrate], `${def.concentrate} balance`).toBeCloseTo(0, 6);
    }
    for (const m of s.mines) {
      expect(m.stock, 'mine stock').toBeGreaterThanOrEqual(0);
      expect(m.producedTotal).toBeGreaterThanOrEqual((this.produced.get(m.id) ?? 0) - 1e-12);
      this.produced.set(m.id, m.producedTotal);
    }
    for (const l of s.mills) expect(l.stock, 'mill stock').toBeGreaterThanOrEqual(0);
    for (const t of s.trains) {
      for (const q of Object.values(t.cargo)) expect(q ?? 0, 'cargo').toBeGreaterThanOrEqual(0);
      expect(t.wagons).toBeGreaterThanOrEqual(0);
    }
    expect(s.materials.spoil).toBeGreaterThanOrEqual(0);
    expect(s.materials.stone).toBeGreaterThanOrEqual(0);
    expect(s.materials.timber).toBeGreaterThanOrEqual(-1e-9);
    expect(s.wagonsOwned).toBeGreaterThanOrEqual(s.trains.reduce((a, t) => a + t.wagons, 0));
    expect(s.finance.debt).toBeGreaterThanOrEqual(0);
    // every dollar is in the ledger
    expect(Math.abs(s.finance.cash - bookCash(s) - this.cashOffset), 'cash == books').toBeLessThan(0.01);
  }

  run(ticks: number, each?: (s: GameState) => void) { for (let i = 0; i < ticks; i++) { this.step(); each?.(this.s); } return this; }
  days(n: number, each?: (s: GameState) => void) { return this.run(n * TPD, each); }
  until(cond: (s: GameState) => boolean, maxDays: number, each?: (s: GameState) => void) {
    for (let i = 0; i < maxDays * TPD && !cond(this.s); i++) { this.step(); each?.(this.s); }
    return cond(this.s);
  }
}

export { previewLine };
