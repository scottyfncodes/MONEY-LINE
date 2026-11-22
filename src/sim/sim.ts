import { TIME, UPGRADES, type UpgradeId } from './config';
import { borrow, canAfford, closeDay, note, repay, restructure, shortfall, spend } from './economy';
import { buildMill, buildMine, chargeDailyOps, setWorksActive, tickWorks } from './facilities';
import { buyClaim, prospect, sellClaim, survey } from './geology';
import { tickObjectives } from './objectives';
import { buildPlatform, demolishEdge, startConstruction, stationById, tickConstruction } from './rail';
import type { RouteOptions } from './route';
import { applyTerrainOp, type TerrainOp } from './terrain';
import { assignService, buyLoco, buyWagons, sellTrain, sellWagons, setWagons, tickTrains } from './trains';
import type { GameState, Result } from './types';
import { fail, ok } from './types';
import { generateWorld } from './worldgen';

export function newGame(seed: number): GameState {
  const s = generateWorld(seed);
  note(s, 'info', 'Prosperity, spring of 1890. One engine, four hoppers, a gold claim in the Sawtooth, and a banker willing to listen.');
  return s;
}

/** Advance the simulation by one fixed tick. All money, ore and movement changes happen here or in a command. */
export function tick(s: GameState) {
  if (s.finance.receivership) return;
  const dt = 1 / TIME.ticksPerDay;
  s.tick++;
  tickConstruction(s, dt);
  tickWorks(s, dt);
  tickTrains(s, dt);
  if (s.tick % TIME.ticksPerDay === 0) {
    s.day++;
    chargeDailyOps(s);
    closeDay(s);
  }
  tickObjectives(s);
}
export function runDays(s: GameState, days: number) {
  for (let i = 0; i < days * TIME.ticksPerDay; i++) tick(s);
}

export function buyUpgrade(s: GameState, id: UpgradeId): Result {
  const u = UPGRADES.find((x) => x.id === id);
  if (!u) return fail('Unknown improvement.');
  if (s.upgrades[id]) return fail('Already installed.');
  if (id === 'steam_drills' && !s.mines.length) return fail('There is no mine to equip yet.');
  if (id === 'second_battery' && !s.mills.length) return fail('There is no mill to extend yet.');
  if (!canAfford(s, u.cost)) return fail(shortfall(s, u.cost));
  spend(s, u.cost, 'equipment');
  s.upgrades[id] = true;
  s.stats.upgrades++;
  s.rev.structures++; s.rev.track++;
  note(s, 'good', `${u.name} installed. ${u.shows}`);
  return ok();
}

export type Command =
  | { type: 'borrow'; amount: number } | { type: 'repay'; amount: number } | { type: 'restructure' }
  | { type: 'terrain'; op: TerrainOp }
  | { type: 'buildLine'; way: Array<{ x: number; z: number }>; options?: Partial<RouteOptions> }
  | { type: 'demolish'; edge: number }
  | { type: 'platform'; x: number; z: number } | { type: 'mine'; x: number; z: number } | { type: 'mill'; x: number; z: number }
  | { type: 'setActive'; kind: 'mine' | 'mill'; id: number; active: boolean }
  | { type: 'prospect'; x: number; z: number } | { type: 'survey'; deposit: number }
  | { type: 'buyClaim'; deposit: number } | { type: 'sellClaim'; deposit: number }
  | { type: 'upgrade'; id: UpgradeId }
  | { type: 'buyLoco'; loco: string } | { type: 'sellTrain'; train: number }
  | { type: 'buyWagons' } | { type: 'sellWagons' }
  | { type: 'assign'; train: number; station: number | null } | { type: 'setWagons'; train: number; wagons: number }
  | { type: 'shipRaw'; station: number; value: boolean };

/** The single entry point for player actions. Every command validates, charges and reports; none can spend what is not there. */
export function exec(s: GameState, c: Command): Result<unknown> {
  if (s.finance.receivership && c.type !== 'restructure') return fail('The company is in receivership.');
  switch (c.type) {
    case 'borrow': return borrow(s, c.amount);
    case 'repay': return repay(s, c.amount);
    case 'restructure': { const r = restructure(s); if (r.ok) s.finance.receivership = false; return r; }
    case 'terrain': return applyTerrainOp(s, c.op);
    case 'buildLine': return startConstruction(s, c.way, c.options);
    case 'demolish': return demolishEdge(s, c.edge);
    case 'platform': return buildPlatform(s, c.x, c.z);
    case 'mine': return buildMine(s, c.x, c.z);
    case 'mill': return buildMill(s, c.x, c.z);
    case 'setActive': return setWorksActive(s, c.kind, c.id, c.active);
    case 'prospect': return prospect(s, c.x, c.z);
    case 'survey': return survey(s, c.deposit);
    case 'buyClaim': return buyClaim(s, c.deposit);
    case 'sellClaim': return sellClaim(s, c.deposit);
    case 'upgrade': return buyUpgrade(s, c.id);
    case 'buyLoco': { const r = buyLoco(s, c.loco); if (r.ok) s.stats.upgrades++; return r; }
    case 'sellTrain': return sellTrain(s, c.train);
    case 'buyWagons': { const r = buyWagons(s); if (r.ok) s.stats.upgrades++; return r; }
    case 'sellWagons': return sellWagons(s);
    case 'assign': return assignService(s, c.train, c.station);
    case 'setWagons': return setWagons(s, c.train, c.wagons);
    case 'shipRaw': { const st = stationById(s, c.station); if (!st) return fail('No such platform.'); st.shipRaw = c.value; return ok(); }
  }
}

export const dateLabel = (day: number) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = day + 90; // the venture opens on 1 April
  const year = TIME.startYear + Math.floor(d / 360);
  return `${(d % 30) + 1} ${months[Math.floor((d % 360) / 30)]} ${year}`;
};
