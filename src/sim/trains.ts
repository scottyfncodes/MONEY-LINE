import { COMMODITIES, FINANCE, LOCOS, RESISTANCE, RESOURCES, STATION, TRACK, WAGON, gradePct, type CommodityId, type LocoDef } from './config';
import { canAfford, earn, note, price, shortfall, spend } from './economy';
import { stationWorks } from './facilities';
import { findPath, pathPoints, reservedEdges, stationById } from './rail';
import { cumulative } from './route';
import type { GameState, Result, Station, TrackPoint, Train, Trip } from './types';
import { fail, ok } from './types';

export const cargoTons = (t: Train) => Object.values(t.cargo).reduce((a, b) => a + (b ?? 0), 0);
export const trainById = (s: GameState, id: number) => s.trains.find((t) => t.id === id);
export const spareWagons = (s: GameState) => s.wagonsOwned - s.trains.reduce((a, t) => a + t.wagons, 0);

/** Steepest sustained climb along a polyline in the direction of travel, in percent (averaged over ~2 cells). */
export function rulingGrade(pts: TrackPoint[], cum: number[]): number {
  let worst = 0, j = 0;
  for (let i = 0; i < pts.length; i++) {
    while (j < pts.length - 1 && cum[j] - cum[i] < 2) j++;
    const d = cum[j] - cum[i];
    if (d > 0.5) worst = Math.max(worst, gradePct((pts[j].h - pts[i].h) / d));
  }
  return worst;
}

/** Gross trailing tons an engine can start on a grade. */
export function haulTons(loco: LocoDef, gradePercent: number): number {
  return loco.tractiveEffort / (RESISTANCE.rolling + RESISTANCE.perGradePct * Math.max(0, gradePercent)) - loco.weight;
}

/** Wagons the engine can take: loaded up the worst climb toward the city, empty up the worst climb toward the mine. */
export function maxWagons(loco: LocoDef, loadedGrade: number, emptyGrade: number): number {
  const loaded = Math.floor(haulTons(loco, loadedGrade) / (WAGON.tare + WAGON.capacity));
  const empty = Math.floor(haulTons(loco, emptyGrade) / WAGON.tare);
  return Math.max(0, Math.min(loaded, empty));
}

export interface ServicePlan { ok: boolean; reason: string; length: number; loadedGrade: number; emptyGrade: number; maxWagons: number; consist: number; roundTripDays: number; capacity: number }
/** What a train could do on a service as the track stands today. Used by the UI and by dispatch. */
export function planService(s: GameState, train: Train, dest: Station | undefined): ServicePlan {
  const none = (reason: string): ServicePlan => ({ ok: false, reason, length: 0, loadedGrade: 0, emptyGrade: 0, maxWagons: 0, consist: 0, roundTripDays: 0, capacity: 0 });
  if (!dest) return none('No service assigned');
  const home = stationById(s, train.home)!;
  const path = findPath(s, home.node, dest.node);
  if (!path) return none(`No track from the terminal to ${dest.name}`);
  const out = pathPoints(s, path.steps), back = out.slice().reverse();
  const loco = LOCOS[train.loco];
  const emptyGrade = rulingGrade(out, cumulative(out)), loadedGrade = rulingGrade(back, cumulative(back));
  const mw = maxWagons(loco, loadedGrade, emptyGrade);
  const consist = Math.min(train.wagons, mw);
  const speed = loco.speed * (s.upgrades.steel_rails ? TRACK.steelSpeedFactor : 1) * 0.72;
  const capacity = consist * WAGON.capacity;
  const roundTripDays = (2 * path.length) / speed + capacity / STATION.loadRate + capacity / STATION.unloadRate;
  if (mw < 1) return { ...none(`Too steep for the ${loco.name}: a ${loadedGrade.toFixed(1)}% climb loaded, ${emptyGrade.toFixed(1)}% empty`), length: path.length, loadedGrade, emptyGrade };
  if (consist < 1) return { ...none('No wagons assigned to this engine'), length: path.length, loadedGrade, emptyGrade, maxWagons: mw };
  return { ok: true, reason: '', length: path.length, loadedGrade, emptyGrade, maxWagons: mw, consist, roundTripDays, capacity };
}

function beginTrip(s: GameState, t: Train, fromNode: number, toNode: number, toStation: number): 'ok' | 'nopath' | 'busy' {
  const free = findPath(s, fromNode, toNode, reservedEdges(s, t.id));
  if (!free) return findPath(s, fromNode, toNode) ? 'busy' : 'nopath';
  const pts = pathPoints(s, free.steps);
  const cum = cumulative(pts);
  t.trip = { pts, cum, length: cum[cum.length - 1], edges: free.steps.map((p) => p.edge), dist: 0, prev: 0, to: toStation };
  return 'ok';
}

/** Position and heading of a point `dist` along a trip (clamped to its ends). */
export function tripPose(trip: Trip, dist: number): { x: number; z: number; h: number; dx: number; dz: number; dh: number; k: number } {
  const { pts, cum } = trip;
  const d = Math.max(0, Math.min(trip.length, dist));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi];
  const seg = cum[hi] - cum[lo] || 1;
  const f = (d - cum[lo]) / seg;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, h: a.h + (b.h - a.h) * f, dx: (b.x - a.x) / seg, dz: (b.z - a.z) / seg, dh: (b.h - a.h) / seg, k: f < 0.5 ? a.k : b.k };
}

function advance(s: GameState, t: Train, dtDays: number): boolean {
  const trip = t.trip!;
  const loco = LOCOS[t.loco];
  const pose = tripPose(trip, trip.dist);
  const g = gradePct(pose.dh);
  const gross = loco.weight + t.consist * WAGON.tare + cargoTons(t);
  const need = gross * (RESISTANCE.rolling + RESISTANCE.perGradePct * Math.max(0, g));
  const ratio = need / loco.tractiveEffort;
  let v = loco.speed * (s.upgrades.steel_rails ? TRACK.steelSpeedFactor : 1) * Math.max(0.3, Math.min(1, 1.18 - 0.8 * ratio));
  if (g < -1.5) v *= 0.82; // brakes pinned down on the descent
  // ease in and out of stations
  const ease = Math.min(1, 0.35 + Math.min(trip.dist, trip.length - trip.dist) / 3);
  v *= ease;
  t.speed = v;
  const move = Math.min(v * dtDays, trip.length - trip.dist);
  trip.prev = trip.dist; trip.dist += move;
  spend(s, move * loco.fuelPerCell * (0.7 + 0.5 * Math.min(1.5, ratio)), 'train_ops');
  return trip.dist >= trip.length - 1e-6;
}

/** Load what the platform's works have ready: concentrate first, then raw ore if the platform ships it. */
function loadAt(s: GameState, t: Train, st: Station, dtDays: number): number {
  const cap = t.consist * WAGON.capacity;
  let room = cap - cargoTons(t);
  let budget = STATION.loadRate * dtDays;
  const works = stationWorks(s, st);
  let loaded = 0;
  const take = (c: CommodityId, from: { stock: number }) => {
    const q = Math.max(0, Math.min(from.stock, room, budget));
    if (q <= 0) return;
    from.stock -= q; t.cargo[c] = (t.cargo[c] ?? 0) + q; room -= q; budget -= q; loaded += q;
  };
  for (const l of works.mills) {
    const mine = s.mines.find((m) => m.id === l.mine); if (!mine) continue;
    const dep = s.deposits.find((d) => d.id === mine.deposit)!;
    take(RESOURCES[dep.resource].concentrate!, l);
  }
  for (const m of works.mines) {
    const dep = s.deposits.find((d) => d.id === m.deposit)!;
    const hasMill = s.mills.some((l) => l.mine === m.id && l.active);
    if (hasMill && !st.shipRaw) continue;
    if (hasMill && st.shipRaw && works.mills.some((l) => l.mine === m.id && l.stock > 0.5)) continue; // concentrate takes the room first
    take(RESOURCES[dep.resource].ore, m);
  }
  return loaded;
}

function availableAt(s: GameState, st: Station): number {
  const works = stationWorks(s, st);
  let a = works.mills.reduce((x, l) => x + l.stock, 0);
  for (const m of works.mines) { const hasMill = s.mills.some((l) => l.mine === m.id && l.active); if (!hasMill || st.shipRaw) a += m.stock; }
  return a;
}

function sellCargo(s: GameState, t: Train) {
  let total = 0, tons = 0; const parts: string[] = []; let conc = false;
  for (const [c, q] of Object.entries(t.cargo) as Array<[CommodityId, number]>) {
    if (!q || q <= 0) continue;
    const p = price(s, c, s.day);
    total += q * p; tons += q;
    parts.push(`${q.toFixed(q < 10 ? 1 : 0)} t ${COMMODITIES[c].name.toLowerCase()} at $${p.toFixed(0)}`);
    if (c.endsWith('conc')) conc = true;
  }
  t.cargo = {};
  if (total <= 0) return;
  total = Math.round(total);
  earn(s, total, 'sales');
  t.hauled += tons;
  s.stats.shipmentsSold++; s.stats.tonsSold += tons;
  const home = stationById(s, t.home)!;
  s.events.push({ type: 'sale', amount: total, x: home.x, z: home.z });
  if (!s.stats.firstSale) note(s, 'good', `First shipment sold at the Prosperity market: ${parts.join(', ')} for $${total.toLocaleString('en-US')}.`);
  else if (conc && !s.stats.firstConcSale) note(s, 'good', `First concentrate sold: ${parts.join(', ')} for $${total.toLocaleString('en-US')}.`);
  s.stats.firstSale = true;
  if (conc) s.stats.firstConcSale = true;
}

/** One tick of every train: dispatch, run, load, unload and sell. Cargo exists only in stockpiles or wagons. */
export function tickTrains(s: GameState, dtDays: number) {
  for (const t of s.trains) {
    const home = stationById(s, t.home)!;
    const dest = t.dest != null ? stationById(s, t.dest) : undefined;
    if (t.phase === 'idle' || t.phase === 'blocked') {
      t.speed = 0;
      if (!dest) { t.phase = 'idle'; t.status = 'Standing at the terminal, no service assigned'; continue; }
      const plan = planService(s, t, dest);
      if (!plan.ok) { t.phase = 'blocked'; t.status = plan.reason; continue; }
      t.consist = plan.consist;
      const r = beginTrip(s, t, home.node, dest.node, dest.id);
      if (r === 'ok') { t.phase = 'outbound'; t.status = `Running empty to ${dest.name}`; s.events.push({ type: 'depart', train: t.id }); }
      else { t.phase = 'blocked'; t.status = r === 'busy' ? 'Held at the terminal: line occupied' : `No track to ${dest.name}`; }
    } else if (t.phase === 'outbound') {
      // the engine is wherever its trip ended, even if the service was changed while it was on the road
      if (advance(s, t, dtDays)) { t.at = t.trip!.to ?? dest?.id ?? t.at; t.trip = null; t.phase = 'loading'; t.dwell = 0; t.speed = 0; s.events.push({ type: 'arrive', train: t.id }); }
    } else if (t.phase === 'loading') {
      const st = stationById(s, t.at)!;
      const got = loadAt(s, t, st, dtDays);
      t.dwell += dtDays;
      const load = cargoTons(t), cap = t.consist * WAGON.capacity;
      const full = load >= cap - 0.01;
      // the works may trickle more in all month: once the platform is swept clean, a part load goes
      const nothingLeft = availableAt(s, st) < 0.5; void got;
      t.status = load <= 0.01 ? `Waiting for ore at ${st.name}` : `Loading at ${st.name}: ${load.toFixed(0)} of ${cap} t`;
      // taken off this service (or sent elsewhere) while out on the line: come home with whatever is aboard
      const recalled = t.dest !== st.id;
      const conc = Object.entries(t.cargo).reduce((a, [c, q]) => a + (c.endsWith('conc') ? q ?? 0 : 0), 0);
      // A few tons of concentrate pay for a trip; rock only pays by the trainload, unless no more is coming.
      const digging = stationWorks(s, st).mines.some((m) => m.active && !m.exhausted);
      const worthIt = conc >= 2 || (load > 0.5 && !digging);
      if (full || recalled || (worthIt && nothingLeft && t.dwell >= STATION.dwellDays)) {
        const r = beginTrip(s, t, st.node, home.node, home.id);
        if (r === 'ok') { t.phase = 'inbound'; t.status = `Hauling ${load.toFixed(0)} t to ${home.name}`; s.events.push({ type: 'depart', train: t.id }); }
        else t.status = r === 'busy' ? `Loaded, held at ${st.name}: line occupied` : 'Loaded, but the line home is cut';
      }
    } else if (t.phase === 'inbound') {
      if (advance(s, t, dtDays)) { t.trip = null; t.phase = 'unloading'; t.at = home.id; t.dwell = 0; t.speed = 0; s.events.push({ type: 'arrive', train: t.id }); }
    } else if (t.phase === 'unloading') {
      t.dwell += dtDays;
      const need = cargoTons(t) / STATION.unloadRate;
      t.status = `Unloading at ${home.name}`;
      if (t.dwell >= need) { sellCargo(s, t); t.tripsDone++; t.phase = 'idle'; }
    }
  }
}

export function assignService(s: GameState, trainId: number, stationId: number | null): Result {
  const t = trainById(s, trainId);
  if (!t) return fail('No such engine.');
  if (stationId != null) {
    const st = stationById(s, stationId);
    if (!st || st.city) return fail('Pick a loading platform for the service.');
  }
  t.dest = stationId;
  return ok();
}

export function setWagons(s: GameState, trainId: number, n: number): Result {
  const t = trainById(s, trainId);
  if (!t) return fail('No such engine.');
  n = Math.max(0, Math.round(n));
  if (n > t.wagons + spareWagons(s)) return fail('No spare wagons in the yard. Buy more hoppers.');
  t.wagons = n;
  return ok();
}

export function buyWagons(s: GameState): Result {
  const cost = WAGON.price * WAGON.batch;
  if (!canAfford(s, cost)) return fail(shortfall(s, cost));
  spend(s, cost, 'equipment');
  s.wagonsOwned += WAGON.batch;
  // new wagons go to the first engine that can use them
  const t = s.trains.find((x) => x.dest != null) ?? s.trains[0];
  if (t) t.wagons += WAGON.batch;
  note(s, 'info', `${WAGON.batch} ore hoppers delivered${t ? ` and coupled behind ${t.name}` : ''}.`);
  s.rev.structures++;
  return ok();
}

export function sellWagons(s: GameState): Result {
  if (s.wagonsOwned < WAGON.batch) return fail('No wagons left to sell.');
  let need = WAGON.batch - spareWagons(s);
  for (const t of s.trains.slice().reverse()) { if (need <= 0) break; const take = Math.min(need, t.wagons); t.wagons -= take; need -= take; }
  s.wagonsOwned -= WAGON.batch;
  earn(s, WAGON.resale * WAGON.batch, 'asset_sale');
  s.finance.assetValue = Math.max(0, s.finance.assetValue - WAGON.price * WAGON.batch * FINANCE.assetBookFactor);
  note(s, 'info', `${WAGON.batch} hoppers sold for $${(WAGON.resale * WAGON.batch).toLocaleString('en-US')}.`);
  return ok();
}

export function buyLoco(s: GameState, locoId: string): Result<Train> {
  const def = LOCOS[locoId];
  if (!def) return fail('The works does not build that engine.');
  if (!canAfford(s, def.price)) return fail(shortfall(s, def.price));
  spend(s, def.price, 'equipment');
  const n = s.trains.length + 1;
  const t: Train = {
    id: s.nextId++, loco: def.id, name: `No. ${n} “${def.name}”`, wagons: Math.max(0, spareWagons(s)), home: s.city.station, dest: null,
    phase: 'idle', trip: null, cargo: {}, at: s.city.station, dwell: 0, consist: 0, status: 'Standing at the terminal, no service assigned', tripsDone: 0, hauled: 0, speed: 0,
  };
  s.trains.push(t);
  note(s, 'good', `${t.name}, a new ${def.wheels}, is in steam at the roundhouse.`);
  s.rev.structures++;
  return ok(t);
}

export function sellTrain(s: GameState, trainId: number): Result {
  const t = trainById(s, trainId);
  if (!t) return fail('No such engine.');
  if (s.trains.length <= 1) return fail('The company cannot sell its last engine.');
  if (t.trip || cargoTons(t) > 0) return fail('Wait until the engine is back at the terminal and unloaded.');
  s.trains.splice(s.trains.indexOf(t), 1);
  const p = Math.round(LOCOS[t.loco].price * FINANCE.resaleFactor);
  earn(s, p, 'asset_sale');
  s.finance.assetValue = Math.max(0, s.finance.assetValue - LOCOS[t.loco].price * FINANCE.assetBookFactor);
  note(s, 'info', `${t.name} sold for $${p.toLocaleString('en-US')}.`);
  s.rev.structures++;
  return ok();
}
