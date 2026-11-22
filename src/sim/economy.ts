import { COMMODITIES, FINANCE, TIME, type CommodityId } from './config';
import { noise2 } from './rng';
import type { GameState, LedgerCat, Note, Period, Result } from './types';
import { fail, ok } from './types';

const CAPITAL: LedgerCat[] = ['construction', 'equipment', 'claims', 'terrain'];
const BOOKED: LedgerCat[] = ['construction', 'equipment', 'claims'];

export function note(s: GameState, kind: Note['kind'], text: string) {
  s.notes.push({ day: s.day, kind, text, id: s.nextId++ });
  if (s.notes.length > 60) s.notes.splice(0, s.notes.length - 60);
}

export const canAfford = (s: GameState, amount: number) => s.finance.cash >= amount - 1e-6;
export const shortfall = (s: GameState, amount: number) =>
  `Short by $${Math.ceil(amount - s.finance.cash).toLocaleString('en-US')} — raise it at the bank (Finance) or free up cash.`;

/** Every dollar leaving the company goes through here, under a ledger category. */
export function spend(s: GameState, amount: number, cat: LedgerCat) {
  if (!(amount > 0)) return;
  const f = s.finance;
  f.cash -= amount;
  f.period.by[cat] = (f.period.by[cat] ?? 0) + amount;
  if (cat === 'interest') { f.period.interest += amount; f.totals.interest += amount; f.today -= amount; }
  else if (CAPITAL.includes(cat)) {
    f.period.capital += amount; f.totals.capital += amount;
    if (BOOKED.includes(cat)) f.assetValue += amount * FINANCE.assetBookFactor;
  } else { f.period.operating += amount; f.totals.operating += amount; f.today -= amount; }
}

/** Every dollar entering the company (other than loans) goes through here. */
export function earn(s: GameState, amount: number, cat: 'sales' | 'asset_sale') {
  if (!(amount > 0)) return;
  const f = s.finance;
  f.cash += amount;
  f.period.by[cat] = (f.period.by[cat] ?? 0) + amount;
  if (cat === 'sales') { f.period.revenue += amount; f.totals.revenue += amount; f.today += amount; }
}

export const creditLimit = (s: GameState) =>
  Math.round((FINANCE.baseCreditLimit + s.finance.assetValue * FINANCE.creditPerAssetDollar + (s.finance.restructured ? FINANCE.restructureCredit : 0)) / 100) * 100;
export const availableCredit = (s: GameState) => Math.max(0, creditLimit(s) - s.finance.debt);
export const monthlyRate = (s: GameState) => FINANCE.monthlyRate + s.finance.rateAdd;

export function borrow(s: GameState, amount: number): Result {
  amount = Math.floor(amount);
  if (!(amount > 0)) return fail('Enter an amount to borrow.');
  if (amount > availableCredit(s) + 1e-6) return fail(`The bank will lend at most $${Math.floor(availableCredit(s)).toLocaleString('en-US')} more.`);
  s.finance.debt += amount; s.finance.cash += amount; s.finance.totals.borrowed += amount;
  s.stats.borrowedOnce = true;
  return ok();
}

export function repay(s: GameState, amount: number): Result {
  amount = Math.floor(Math.min(amount, s.finance.debt));
  if (!(amount > 0)) return fail('There is nothing to repay.');
  if (amount > s.finance.cash) return fail('Not enough cash on hand to repay that much.');
  s.finance.debt -= amount; s.finance.cash -= amount; s.finance.totals.repaid += amount;
  return ok();
}

export function restructure(s: GameState): Result {
  const f = s.finance;
  if (f.restructured) return fail('The bank has already restructured this debt once.');
  if (f.cash >= 0) return fail('The bank only restructures a company that is out of cash and credit.');
  f.restructured = true; f.rateAdd += FINANCE.restructureRateAdd;
  const draw = Math.min(availableCredit(s), Math.max(0, -f.cash) + 5000);
  f.debt += draw; f.cash += draw; f.totals.borrowed += draw; f.insolventDays = 0;
  note(s, 'warn', `Debt restructured: the bank extends $${FINANCE.restructureCredit.toLocaleString('en-US')} more credit at a higher rate. There will be no second rescue.`);
  return ok();
}

/** Market price in $/ton. A slow cycle plus a little weather, fixed by the seed: reloading never rerolls it. */
export function price(s: { seed: number }, c: CommodityId, day: number): number {
  const def = COMMODITIES[c];
  const k = c.startsWith('gold') ? 1 : c.startsWith('silver') ? 2 : 3;
  const cycle = Math.sin((day / (83 + k * 17)) * Math.PI * 2 + s.seed * 0.37 + k * 1.9);
  const weather = noise2(day / 9, k * 31.7, s.seed + 400 + k) * 2 - 1;
  return Math.round(def.basePrice * (1 + def.swing * (0.72 * cycle + 0.28 * weather)) * 100) / 100;
}

export const newPeriod = (index: number, startDay: number): Period => ({ index, startDay, revenue: 0, operating: 0, interest: 0, capital: 0, by: {} });
export const periodNet = (p: Period) => p.revenue - p.operating - p.interest;
export const avgDaily = (s: GameState) => (s.finance.daily.length ? s.finance.daily.reduce((a, b) => a + b, 0) / s.finance.daily.length : 0);

/** End-of-day bookkeeping: interest, overdraft, month close, insolvency. */
export function closeDay(s: GameState) {
  const f = s.finance;
  if (f.debt > 0) spend(s, (f.debt * monthlyRate(s)) / TIME.daysPerMonth, 'interest');

  if (f.cash < 0) {
    const draw = Math.min(Math.ceil(-f.cash), availableCredit(s));
    if (draw > 0) {
      f.debt += draw; f.cash += draw; f.totals.borrowed += draw;
      if (f.insolventDays === 0 && s.day % 5 === 0) note(s, 'warn', `Cash ran out: $${draw.toLocaleString('en-US')} drawn on the credit line to cover the day.`);
    }
  }
  if (f.cash < -0.5) {
    f.insolventDays++;
    if (f.insolventDays === 1) note(s, 'bad', `Out of cash and out of credit. Cut costs, sell equipment or restructure within ${FINANCE.insolvencyDays} days or the bank takes the line.`);
    if (f.insolventDays >= FINANCE.insolvencyDays && !f.receivership) {
      f.receivership = true;
      note(s, 'bad', 'The bank has put the company into receivership.');
    }
  } else f.insolventDays = 0;

  f.daily.push(f.today); if (f.daily.length > 7) f.daily.shift();
  f.today = 0;

  if (s.day - f.period.startDay >= TIME.daysPerMonth) {
    const p = f.period;
    f.history.push(p); if (f.history.length > 24) f.history.shift();
    const net = periodNet(p);
    if (net > 0 && p.revenue > 0) {
      if (!s.stats.profitableMonth) note(s, 'good', `Month ${p.index + 1} closed $${Math.round(net).toLocaleString('en-US')} in the black.`);
      s.stats.profitableMonth = true;
      if (!f.restructured) f.rateAdd = 0;
    } else if (s.stats.firstSale && net < 0 && !f.restructured) {
      if (f.rateAdd === 0) note(s, 'warn', 'A loss-making month: the bank raises its rate until the books improve.');
      f.rateAdd = FINANCE.stressedRateAdd;
    }
    f.period = newPeriod(p.index + 1, s.day);
  }
}
