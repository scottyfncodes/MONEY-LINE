import { FINANCE, RESOURCES, SURVEY } from './config';
import { canAfford, earn, note, shortfall, spend } from './economy';
import { distToNetwork } from './rail';
import type { Deposit, GameState, Result } from './types';
import { fail, ok } from './types';

export const SURVEY_NAMES = ['Surface showing', 'Preliminary survey', 'Test pits', 'Core drilling'];
export const depositById = (s: GameState, id: number) => s.deposits.find((d) => d.id === id);

export interface Estimate { low: number; high: number; mid: number; confidence: number }
/** What the company believes is in the ground. It narrows toward the truth as surveys improve. */
export function estimate(d: Deposit): Estimate {
  const u = SURVEY.uncertainty[d.surveyLevel];
  const known = d.actualTons - (d.extensionFound ? 0 : 0);
  const mid0 = known * (1 + d.bias * (u / SURVEY.uncertainty[0]) * 1.6);
  const mined = d.actualTons - d.remaining;
  const mid = Math.max(0, mid0 - mined);
  const half = mid0 * u;
  const r = (v: number) => Math.max(0, Math.round(v / 100) * 100);
  return { low: r(mid - half), high: r(mid + half), mid: r(mid), confidence: 1 - u };
}

export function surveyCost(s: GameState, d: Deposit): number | null {
  const base = d.surveyLevel === 0 ? SURVEY.prospectCost : d.surveyLevel === 1 ? SURVEY.testPitCost : d.surveyLevel === 2 ? SURVEY.drillCost : null;
  if (base == null) return null;
  return Math.round(base * (s.upgrades.assay_office && d.surveyLevel >= 1 ? SURVEY.assayDiscount : 1));
}

/** Send prospectors over an area. What they find is fixed by the world seed. */
export function prospect(s: GameState, x: number, z: number): Result<Deposit[]> {
  if (!canAfford(s, SURVEY.prospectCost)) return fail(shortfall(s, SURVEY.prospectCost));
  spend(s, SURVEY.prospectCost, 'survey');
  const found: Deposit[] = [];
  for (const d of s.deposits) {
    if (d.discovered) continue;
    if (Math.hypot(d.x - x, d.z - z) <= SURVEY.prospectRadius + d.radius * 0.4) {
      d.discovered = true; d.surveyLevel = 0; d.rumor = null; found.push(d);
      s.stats.discoveries++;
      s.events.push({ type: 'discovery', deposit: d.id });
      note(s, 'good', `Prospectors report ${RESOURCES[d.resource].name.toLowerCase()} showing at surface: the ${d.name}. The claim is open for filing.`);
    }
  }
  if (!found.length) note(s, 'info', 'The prospectors come back with barren rock. Nothing of value in that ground.');
  return ok(found);
}

export function survey(s: GameState, depositId: number): Result<Deposit> {
  const d = depositById(s, depositId);
  if (!d || !d.discovered) return fail('No known deposit there.');
  const cost = surveyCost(s, d);
  if (cost == null) return fail('This deposit has already been core-drilled. There is nothing more to learn.');
  if (!canAfford(s, cost)) return fail(shortfall(s, cost));
  spend(s, cost, 'survey');
  d.surveyLevel++;
  if (d.surveyLevel === 3 && d.hiddenExtension > 0 && !d.extensionFound) {
    d.extensionFound = true; d.actualTons += d.hiddenExtension; d.remaining += d.hiddenExtension;
    s.stats.discoveries++;
    s.events.push({ type: 'discovery', deposit: d.id });
    note(s, 'good', `The drill core runs on past the known limit: a ${d.hiddenExtension.toLocaleString('en-US')}-ton extension of the ${d.name}.`);
  } else {
    const e = estimate(d);
    note(s, 'info', `${SURVEY_NAMES[d.surveyLevel]} on the ${d.name}: ${e.low.toLocaleString('en-US')}–${e.high.toLocaleString('en-US')} tons of ore.`);
  }
  return ok(d);
}

/** A claim costs more when the ground is proven and when the railroad is already near. */
export function claimPrice(s: GameState, d: Deposit): number {
  const access = distToNetwork(s, d.x, d.z) < 16 ? 1.3 : 1;
  return Math.round((RESOURCES[d.resource].claimBase * d.grade * (0.5 + 0.3 * d.surveyLevel) * access) / 50) * 50;
}

export function buyClaim(s: GameState, depositId: number): Result {
  const d = depositById(s, depositId);
  if (!d || !d.discovered) return fail('No known deposit there.');
  if (d.owned) return fail('The company already holds this claim.');
  const p = claimPrice(s, d);
  if (!canAfford(s, p)) return fail(shortfall(s, p));
  spend(s, p, 'claims');
  d.owned = true;
  note(s, 'good', `Claim filed on the ${d.name} for $${p.toLocaleString('en-US')}.`);
  return ok();
}

export function sellClaim(s: GameState, depositId: number): Result {
  const d = depositById(s, depositId);
  if (!d || !d.owned) return fail('The company does not hold that claim.');
  if (s.mines.some((m) => m.deposit === d.id)) return fail('There is a working mine on this claim.');
  const p = Math.round(claimPrice(s, d) * FINANCE.resaleFactor);
  d.owned = false;
  earn(s, p, 'asset_sale');
  s.finance.assetValue = Math.max(0, s.finance.assetValue - p);
  note(s, 'info', `Claim on the ${d.name} sold for $${p.toLocaleString('en-US')}.`);
  return ok();
}
