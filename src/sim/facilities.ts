import { MILL, MINE, RESOURCES, STATION, WORLD } from './config';
import { canAfford, note, shortfall, spend } from './economy';
import { distToNetwork, trackMaintenancePerDay } from './rail';
import { inBounds, markDirty, padRelief, padWet, recomputeLocks } from './terrain';
import type { Deposit, GameState, Mill, Mine, Result, Station } from './types';
import { fail, ok } from './types';
import { ci, quant, vi } from './worldgen';
import { LOCOS } from './config';

const N = WORLD.size;
export const mineTier = (s: GameState) => MINE.tiers[s.upgrades.steam_drills ? 1 : 0];
export const millTier = (s: GameState) => MILL.tiers[s.upgrades.second_battery ? 1 : 0];
export const mineById = (s: GameState, id: number) => s.mines.find((m) => m.id === id);
export const millById = (s: GameState, id: number) => s.mills.find((m) => m.id === id);
export const millOf = (s: GameState, mineId: number) => s.mills.find((m) => m.mine === mineId);

function trackTooClose(s: GameState, x: number, z: number, r: number): boolean {
  for (const e of s.edges) for (const p of e.pts) if (Math.hypot(p.x - x, p.z - z) < r) return true;
  for (const j of s.jobs) for (const p of j.pts) if (Math.hypot(p.x - x, p.z - z) < r) return true;
  return false;
}
function siteProblem(s: GameState, x: number, z: number, half: number, maxRelief: number): string | null {
  if (!inBounds(x, z, half + 1)) return 'Too close to the edge of the survey.';
  if (padWet(s, x, z, half)) return 'The river runs through this site.';
  if (Math.hypot(x - s.city.x, z - s.city.z) < s.city.radius + 3) return 'That ground belongs to the city.';
  if (trackTooClose(s, x, z, 1.7)) return 'Too close to the track. Leave room for the line.';
  for (const m of [...s.mines, ...s.mills]) if (Math.hypot(m.x - x, m.z - z) < 4) return 'Too close to another works.';
  const relief = padRelief(s, x, z, half);
  if (relief > maxRelief + 1e-3) return `Ground too uneven for a building pad (${relief.toFixed(1)} levels of relief, ${maxRelief} allowed). Grade it level first.`;
  return null;
}

/** Level the building pad to its mean height. Only small corrections are left by the relief limit. */
function levelPad(s: GameState, x: number, z: number, half: number) {
  let sum = 0, c = 0;
  for (let vz = Math.floor(z - half); vz <= Math.ceil(z + half); vz++) for (let vx = Math.floor(x - half); vx <= Math.ceil(x + half); vx++) { sum += s.height[vi(vx, vz)]; c++; }
  const h = quant(sum / c);
  for (let vz = Math.floor(z - half); vz <= Math.ceil(z + half); vz++) for (let vx = Math.floor(x - half); vx <= Math.ceil(x + half); vx++) {
    const i = vi(vx, vz);
    s.soil[i] = quant(Math.max(0, s.soil[i] + (h - s.height[i])));
    s.height[i] = h;
  }
  for (let cz = Math.floor(z - half); cz < Math.ceil(z + half); cz++) for (let cx = Math.floor(x - half); cx < Math.ceil(x + half); cx++)
    if (cx >= 0 && cz >= 0 && cx < N && cz < N && s.forest[ci(cx, cz)]) { s.forest[ci(cx, cz)] = 0; s.rev.trees++; }
  markDirty(s, x - half - 1, z - half - 1, x + half + 1, z + half + 1);
}

export function mineSite(s: GameState, x: number, z: number): { error: string | null; deposit: Deposit | null } {
  const dep = s.deposits.find((d) => d.discovered && Math.hypot(d.x - x, d.z - z) <= d.radius) ?? null;
  if (!dep) return { error: 'No known ore body under this ground. A mine has to stand on a surveyed deposit.', deposit: null };
  if (!dep.owned) return { error: `The ${dep.name} is not yours yet. File the claim first.`, deposit: dep };
  if (dep.remaining <= 0) return { error: `The ${dep.name} is worked out.`, deposit: dep };
  if (s.mines.some((m) => m.deposit === dep.id && !m.exhausted)) return { error: `The ${dep.name} already has a mine.`, deposit: dep };
  const d = distToNetwork(s, x, z);
  if (d > MINE.railRadius) return { error: 'No railroad here yet. Machinery and timber come by rail: bring track within reach of the site first.', deposit: dep };
  return { error: siteProblem(s, x, z, MINE.footprint, MINE.maxPadRelief), deposit: dep };
}

export function buildMine(s: GameState, x: number, z: number): Result<Mine> {
  x = Math.round(x); z = Math.round(z);
  const site = mineSite(s, x, z);
  if (site.error) return fail(site.error);
  if (!canAfford(s, MINE.cost)) return fail(shortfall(s, MINE.cost));
  spend(s, MINE.cost, 'construction');
  levelPad(s, x, z, MINE.footprint);
  const m: Mine = { id: s.nextId++, deposit: site.deposit!.id, x, z, stock: 0, active: true, exhausted: false, producedTotal: 0, builtDay: s.day, status: 'Opening the first drift' };
  s.mines.push(m);
  s.stats.minesBuilt++;
  recomputeLocks(s);
  s.rev.structures++;
  s.events.push({ type: 'built', what: 'mine', x, z });
  note(s, 'good', `The ${site.deposit!.name} mine is open. First ore is coming out of the drift.`);
  return ok(m);
}

export function millSite(s: GameState, x: number, z: number): { error: string | null; mine: Mine | null } {
  let mine: Mine | null = null, bd: number = MILL.mineRadius;
  for (const m of s.mines) {
    const d = Math.hypot(m.x - x, m.z - z);
    const dep = s.deposits.find((q) => q.id === m.deposit)!;
    if (d <= bd && RESOURCES[dep.resource].concentrate && !millOf(s, m.id)) { bd = d; mine = m; }
  }
  if (!mine) {
    const near = s.mines.find((m) => Math.hypot(m.x - x, m.z - z) <= MILL.mineRadius);
    if (near && millOf(s, near.id)) return { error: 'That mine already feeds a mill.', mine: null };
    if (near) return { error: 'Coal is sold as it comes. It needs no mill.', mine: null };
    return { error: 'A mill has to stand beside the mine it serves.', mine: null };
  }
  return { error: siteProblem(s, x, z, MILL.footprint, MILL.maxPadRelief), mine };
}

export function buildMill(s: GameState, x: number, z: number): Result<Mill> {
  x = Math.round(x); z = Math.round(z);
  const site = millSite(s, x, z);
  if (site.error) return fail(site.error);
  if (!canAfford(s, MILL.cost)) return fail(shortfall(s, MILL.cost));
  spend(s, MILL.cost, 'construction');
  levelPad(s, x, z, MILL.footprint);
  const m: Mill = { id: s.nextId++, mine: site.mine!.id, x, z, stock: 0, active: true, builtDay: s.day, processedTotal: 0, status: 'Raising steam' };
  s.mills.push(m);
  s.stats.millsBuilt++;
  recomputeLocks(s);
  s.rev.structures++;
  s.events.push({ type: 'built', what: 'mill', x, z });
  note(s, 'good', 'The stamp mill is up. Ore from the mine now goes through the battery before it ships.');
  return ok(m);
}

/** Mines and mills within reach of a platform. */
export function stationWorks(s: GameState, st: Station): { mines: Mine[]; mills: Mill[] } {
  const near = (o: { x: number; z: number }) => Math.hypot(o.x - st.x, o.z - st.z) <= STATION.serviceRadius;
  const mines = s.mines.filter(near);
  // a mill ships through its mine's platform, wherever on the hillside it had to be built
  return { mines, mills: s.mills.filter((l) => near(l) || mines.some((m) => m.id === l.mine)) };
}
export function stationFor(s: GameState, o: { x: number; z: number }): Station | null {
  let best: Station | null = null, bd: number = STATION.serviceRadius;
  for (const st of s.stations) { if (st.city) continue; const d = Math.hypot(o.x - st.x, o.z - st.z); if (d <= bd) { bd = d; best = st; } }
  return best;
}

/** Extraction and milling for one tick. Ore only ever moves from the ground to a stockpile to a mill to a wagon. */
export function tickWorks(s: GameState, dtDays: number) {
  const mt = mineTier(s), lt = millTier(s);
  for (const m of s.mines) {
    const dep = s.deposits.find((d) => d.id === m.deposit)!;
    if (m.exhausted) { m.status = 'Worked out'; continue; }
    if (!m.active) { m.status = 'Suspended'; continue; }
    const room = mt.capacity - m.stock;
    const out = Math.max(0, Math.min((mt.rate / dep.difficulty) * dtDays, room, dep.remaining));
    m.stock += out; dep.remaining -= out; m.producedTotal += out;
    m.status = room <= 0.01 ? 'Stockpile full: waiting on the railroad' : `${mt.name}: ${(mt.rate / dep.difficulty).toFixed(0)} t/day`;
    if (dep.remaining <= 1e-6) {
      dep.remaining = 0; m.exhausted = true;
      note(s, 'warn', `The ${dep.name} is worked out. The last ore is on the stockpile.`);
      s.rev.structures++;
    }
  }
  for (const l of s.mills) {
    const mine = mineById(s, l.mine);
    if (!mine) continue;
    if (!l.active) { l.status = 'Suspended'; continue; }
    const dep = s.deposits.find((d) => d.id === mine.deposit)!;
    const yieldPerTon = RESOURCES[dep.resource].concentrateRatio * dep.grade * lt.recovery;
    const room = lt.capacity - l.stock;
    const take = Math.max(0, Math.min(lt.throughput * dtDays, mine.stock, room / yieldPerTon));
    mine.stock -= take; l.stock += take * yieldPerTon; l.processedTotal += take;
    l.status = room <= 0.01 ? 'Concentrate bins full: waiting on the railroad' : take <= 1e-9 ? 'Battery idle: no ore on the floor' : `${lt.name}: treating ${Math.min(lt.throughput, mineTier(s).rate).toFixed(0)} t/day`;
  }
}

export interface DailyOps { mines: number; mills: number; trains: number; maintenance: number; total: number }
export function dailyOpsCost(s: GameState): DailyOps {
  const mt = mineTier(s), lt = millTier(s);
  const mines = s.mines.reduce((a, m) => a + (m.active && !m.exhausted ? mt.labour : 0), 0);
  const mills = s.mills.reduce((a, m) => a + (m.active ? lt.cost : 0), 0);
  const trains = s.trains.reduce((a, t) => a + (t.dest != null || t.trip ? LOCOS[t.loco].crewPerDay : 0), 0);
  const maintenance = trackMaintenancePerDay(s);
  return { mines, mills, trains, maintenance, total: mines + mills + trains + maintenance };
}

/** Wages and upkeep, charged once a day. Fuel is charged by the trains as they burn it. */
export function chargeDailyOps(s: GameState) {
  const c = dailyOpsCost(s);
  spend(s, c.mines, 'mine_ops'); spend(s, c.mills, 'mill_ops'); spend(s, c.trains, 'train_ops'); spend(s, c.maintenance, 'maintenance');
}

export function setWorksActive(s: GameState, kind: 'mine' | 'mill', id: number, active: boolean): Result {
  const w = kind === 'mine' ? mineById(s, id) : millById(s, id);
  if (!w) return fail('No such works.');
  w.active = active;
  note(s, 'info', `${kind === 'mine' ? 'Mine' : 'Mill'} ${active ? 'back at work' : 'suspended: no wages are paid while it stands idle'}.`);
  return ok();
}
