import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { CLAIM_RING, ownClaim, theWorld } from './GameView';
import { suggestRoute } from '../sim/autoroute';
import {
  COMMODITIES, FINANCE, LOCOS, MILL, MINE, RESOURCES, STATION, SURVEY, TRACK, UPGRADES, WAGON, WORLD, fmtMoney, gradePct,
  type CommodityId,
} from '../sim/config';
import { availableCredit, avgDaily, creditLimit, monthlyRate, periodNet, price } from '../sim/economy';
import { dailyOpsCost, millTier, mineTier, stationWorks } from '../sim/facilities';
import { SURVEY_NAMES, claimPrice, estimate, surveyCost } from '../sim/geology';
import { MILES_PER_CELL, edgeById, totalTrackLength } from '../sim/rail';
import { heightAt, soilAt } from '../sim/terrain';
import { cargoTons, maxWagons, planService, spareWagons } from '../sim/trains';
import type { Deposit, GameState, Train } from '../sim/types';
import { ci } from '../sim/worldgen';
import { isPhone, loanFor, useUI } from '../store';

/** True on a phone-sized screen, and kept true or false as the window changes. */
export function usePhone(): boolean {
  return useSyncExternalStore((cb) => { const m = matchMedia('(max-width: 820px)'); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); }, isPhone, () => false);
}

const tons = (v: number) => `${v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)} t`;
const miles = (cells: number) => `${(cells * MILES_PER_CELL).toFixed(2)} mi`;
const feet = (levels: number) => `${Math.round(levels * WORLD.levelMeters * 3.281).toLocaleString('en-US')} ft`;

export function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: 'good' | 'bad' | 'dim' }) {
  return <div className="row"><span className="k">{k}</span><span className={`v ${tone ?? ''}`}>{v}</span></div>;
}
function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return <section className="sec"><header><h3>{title}</h3>{aside}</header>{children}</section>;
}
function Btn({ children, onClick, disabled, kind, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; kind?: 'primary' | 'ghost' | 'danger'; title?: string }) {
  return <button type="button" className={`btn ${kind ?? ''}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}
function Spark({ values, w = 120, h = 28 }: { values: number[]; w?: number; h?: number }) {
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)} ${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><path d={d} /><circle cx={w} cy={h - 2 - ((values[values.length - 1] - lo) / span) * (h - 4)} r="2.2" /></svg>;
}

// ───────────────────────────── Finance ─────────────────────────────
function FinancePanel({ g }: { g: GameState }) {
  const run = useUI((s) => s.run);
  const [amt, setAmt] = useState(10000);
  const f = g.finance, p = f.period, avail = availableCredit(g), ops = dailyOpsCost(g);
  const interestDay = (f.debt * monthlyRate(g)) / 30;
  const cats: Array<[string, number]> = [
    ['Mine wages', p.by.mine_ops ?? 0], ['Mill running', p.by.mill_ops ?? 0], ['Trains: crew and coal', p.by.train_ops ?? 0],
    ['Track upkeep', p.by.maintenance ?? 0], ['Surveys', p.by.survey ?? 0],
  ];
  const commodities = (Object.keys(COMMODITIES) as CommodityId[]).filter((c) => c === 'gold_conc' || c === 'gold_ore' || g.deposits.some((d) => d.discovered && (RESOURCES[d.resource].ore === c || RESOURCES[d.resource].concentrate === c)));
  return (
    <>
      <Section title="The bank">
        <Row k="Cash on hand" v={fmtMoney(f.cash)} tone={f.cash < 0 ? 'bad' : undefined} />
        <Row k="Debt outstanding" v={fmtMoney(f.debt)} />
        <Row k="Credit line" v={`${fmtMoney(creditLimit(g))} · ${fmtMoney(avail)} free`} />
        <Row k="Interest" v={`${(monthlyRate(g) * 100).toFixed(1)}% a month · ${fmtMoney(interestDay)}/day`} tone={f.rateAdd > 0 ? 'bad' : undefined} />
        <div className="stepper" role="group" aria-label="Loan amount">
          <button type="button" onClick={() => setAmt(Math.max(1000, amt - 5000))} aria-label="Less">−</button>
          <output>{fmtMoney(amt)}</output>
          <button type="button" onClick={() => setAmt(Math.min(200000, amt + 5000))} aria-label="More">+</button>
        </div>
        <div className="btnrow">
          <Btn kind="primary" onClick={() => run({ type: 'borrow', amount: Math.min(amt, avail) })} disabled={avail < 1}>Borrow {fmtMoney(Math.min(amt, avail))}</Btn>
          <Btn onClick={() => run({ type: 'repay', amount: Math.min(amt, f.debt, Math.max(0, f.cash)) })} disabled={f.debt < 1 || f.cash < 1}>Repay {fmtMoney(Math.min(amt, f.debt, Math.max(0, f.cash)))}</Btn>
        </div>
        <p className="hint">The line grows with what the company owns: {Math.round(FINANCE.creditPerAssetDollar * 100)}¢ of credit for each dollar of book value ({fmtMoney(f.assetValue)}).</p>
        {(f.insolventDays > 0 || f.receivership) && (
          <div className="alert">
            <strong>{f.receivership ? 'Receivership.' : `Insolvent for ${f.insolventDays} of ${FINANCE.insolvencyDays} days.`}</strong> Suspend works, sell hoppers, sell an idle claim — or ask the bank once.
            <Btn kind="danger" onClick={() => run({ type: 'restructure' })} disabled={f.restructured}>{f.restructured ? 'Already restructured' : 'Restructure the debt'}</Btn>
          </div>
        )}
      </Section>
      <Section title={`Month ${p.index + 1}`} aside={<span className="tag">day {g.day - p.startDay + 1} of 30</span>}>
        <Row k="Sales" v={fmtMoney(p.revenue)} tone="good" />
        {cats.filter(([, v]) => v > 0).map(([k, v]) => <Row key={k} k={k} v={fmtMoney(-v)} />)}
        <Row k="Interest" v={fmtMoney(-p.interest)} />
        <div className="rule" />
        <Row k="Profit so far" v={fmtMoney(periodNet(p))} tone={periodNet(p) >= 0 ? 'good' : 'bad'} />
        <Row k="Capital spent (not in profit)" v={fmtMoney(p.capital)} tone="dim" />
        <p className="hint">Profit is what the line earns. Cash also moves when you build or borrow.</p>
      </Section>
      <Section title="Running cost per day">
        <Row k="Mines" v={fmtMoney(ops.mines)} /><Row k="Mills" v={fmtMoney(ops.mills)} /><Row k="Train crews" v={fmtMoney(ops.trains)} />
        <Row k={`Track upkeep (${miles(totalTrackLength(g))})`} v={fmtMoney(ops.maintenance)} /><Row k="Interest" v={fmtMoney(interestDay)} />
        <div className="rule" /><Row k="Earning, 7-day average" v={`${fmtMoney(avgDaily(g))}/day`} tone={avgDaily(g) >= 0 ? 'good' : 'bad'} />
      </Section>
      {f.history.length > 0 && (
        <Section title="Past months">
          <table className="ledger"><thead><tr><th>Month</th><th>Sales</th><th>Costs</th><th>Profit</th></tr></thead>
            <tbody>{f.history.slice(-6).reverse().map((h) => <tr key={h.index}><td>{h.index + 1}</td><td>{fmtMoney(h.revenue)}</td><td>{fmtMoney(h.operating + h.interest)}</td><td className={periodNet(h) >= 0 ? 'good' : 'bad'}>{fmtMoney(periodNet(h))}</td></tr>)}</tbody></table>
        </Section>
      )}
      <Section title="Prosperity market">
        {commodities.map((c) => {
          const hist = Array.from({ length: 40 }, (_, i) => price(g, c, g.day - 39 + i));
          const now = hist[39], base = COMMODITIES[c].basePrice;
          return <div className="market" key={c}><span className="k">{COMMODITIES[c].name}</span><Spark values={hist} /><span className={`v ${now >= base ? 'good' : 'bad'}`}>${now.toFixed(0)}/t</span></div>;
        })}
        <p className="hint">Prices swing with the season. A full train at the top of the market is worth waiting a day for.</p>
      </Section>
    </>
  );
}

// ───────────────────────────── Trains ─────────────────────────────
function TrainCard({ g, t }: { g: GameState; t: Train }) {
  const run = useUI((s) => s.run);
  const set = useUI((s) => s.set);
  const loco = LOCOS[t.loco];
  const dest = g.stations.find((s) => s.id === t.dest);
  const plan = planService(g, t, dest);
  const platforms = g.stations.filter((s) => !s.city);
  const load = cargoTons(t);
  return (
    <div className="card">
      <header><h4>{t.name}</h4><span className="tag">{loco.wheels}</span></header>
      <p className="status">{t.status}</p>
      <label className="field"><span>Service</span>
        <select value={t.dest ?? ''} onChange={(e) => run({ type: 'assign', train: t.id, station: e.target.value ? Number(e.target.value) : null })}>
          <option value="">No service</option>
          {platforms.map((s) => <option key={s.id} value={s.id}>Terminal ⇄ {s.name}</option>)}
        </select>
      </label>
      <div className="field"><span>Hoppers</span>
        <div className="stepper small"><button type="button" onClick={() => run({ type: 'setWagons', train: t.id, wagons: t.wagons - 1 })} disabled={t.wagons <= 0} aria-label="Fewer hoppers">−</button><output>{t.wagons}</output><button type="button" onClick={() => run({ type: 'setWagons', train: t.id, wagons: t.wagons + 1 })} disabled={spareWagons(g) <= 0} aria-label="More hoppers">+</button></div>
      </div>
      {dest && plan.length > 0 && (
        <>
          <Row k="Climb, loaded / empty" v={`${plan.loadedGrade.toFixed(1)}% / ${plan.emptyGrade.toFixed(1)}%`} />
          <Row k="Engine can take" v={`${plan.maxWagons} hoppers`} tone={plan.maxWagons < t.wagons ? 'bad' : undefined} />
          {plan.ok && <Row k="Each trip" v={`${plan.capacity} t in about ${plan.roundTripDays.toFixed(1)} days`} />}
          {plan.ok && plan.maxWagons < t.wagons && <p className="hint">The grade holds this engine to {plan.maxWagons} hoppers. An easier line or a stronger engine would take them all.</p>}
        </>
      )}
      <Row k="Aboard now" v={load > 0 ? Object.entries(t.cargo).filter(([, q]) => (q ?? 0) > 0.05).map(([c, q]) => `${tons(q!)} ${COMMODITIES[c as CommodityId].short}`).join(', ') : 'Empty'} />
      <Row k="Running cost" v={`${fmtMoney(loco.crewPerDay)}/day crew · $${loco.fuelPerCell.toFixed(2)} coal per cell`} tone="dim" />
      <Row k="Hauled to date" v={`${tons(t.hauled)} in ${t.tripsDone} trips`} tone="dim" />
      <div className="btnrow">
        <Btn onClick={() => { theWorld?.followTrain(t.id); set({ selection: { kind: 'train', id: t.id } }); }}>Follow</Btn>
        {g.trains.length > 1 && <Btn kind="ghost" onClick={() => run({ type: 'sellTrain', train: t.id })}>Sell for {fmtMoney(loco.price * FINANCE.resaleFactor)}</Btn>}
      </div>
    </div>
  );
}
function TrainsPanel({ g }: { g: GameState }) {
  const run = useUI((s) => s.run);
  const big = LOCOS.consolidation, tank = LOCOS.tank;
  return (
    <>
      <Section title="Engines">{g.trains.map((t) => <TrainCard key={t.id} g={g} t={t} />)}</Section>
      <Section title="The yard">
        <Row k="Ore hoppers owned" v={`${g.wagonsOwned} · ${spareWagons(g)} spare`} />
        <Row k="Each hopper" v={`${WAGON.capacity} t of ore, ${WAGON.tare} t empty`} tone="dim" />
        <div className="btnrow">
          <Btn kind="primary" onClick={() => run({ type: 'buyWagons' })}>Buy {WAGON.batch} hoppers · {fmtMoney(WAGON.price * WAGON.batch)}</Btn>
          <Btn kind="ghost" onClick={() => run({ type: 'sellWagons' })} disabled={g.wagonsOwned < WAGON.batch}>Sell {WAGON.batch}</Btn>
        </div>
      </Section>
      <Section title="Locomotive works">
        {[big, tank].map((l) => (
          <div className="card" key={l.id}>
            <header><h4>{l.name}</h4><span className="tag">{l.wheels}</span></header>
            <p className="status">{l.blurb}</p>
            <Row k="Pull" v={`${l.tractiveEffort.toLocaleString('en-US')} lb`} />
            <Row k="Hoppers up a 3% grade" v={maxWagons(l, 3, 3)} />
            <Row k="Hoppers up a 1.5% grade" v={maxWagons(l, 1.5, 1.5)} />
            <Row k="Crew" v={`${fmtMoney(l.crewPerDay)}/day`} tone="dim" />
            <Btn kind="primary" onClick={() => run({ type: 'buyLoco', loco: l.id })}>Order · {fmtMoney(l.price)}</Btn>
          </div>
        ))}
        <p className="hint">One train at a time on a single line. A second engine waits at the terminal until the first is clear — unless there is a second track for it to take.</p>
      </Section>
    </>
  );
}

// ───────────────────────────── Works (upgrades) ─────────────────────────────
function WorksPanel({ g }: { g: GameState }) {
  const run = useUI((s) => s.run);
  const groups = ['Mining', 'Processing', 'Railroad', 'Business'] as const;
  return (
    <>
      {groups.map((grp) => (
        <Section title={grp} key={grp}>
          {UPGRADES.filter((u) => u.group === grp).map((u) => (
            <div className={`card ${g.upgrades[u.id] ? 'owned' : ''}`} key={u.id}>
              <header><h4>{u.name}</h4>{g.upgrades[u.id] ? <span className="tag good">Installed</span> : <span className="tag">{fmtMoney(u.cost)}</span>}</header>
              <p className="status">{u.effect}</p>
              <p className="hint">{u.shows}</p>
              {!g.upgrades[u.id] && <Btn kind="primary" onClick={() => run({ type: 'upgrade', id: u.id })}>Install · {fmtMoney(u.cost)}</Btn>}
            </div>
          ))}
        </Section>
      ))}
    </>
  );
}

// ───────────────────────────── Survey ─────────────────────────────
function DepositCard({ g, d }: { g: GameState; d: Deposit }) {
  const run = useUI((s) => s.run);
  const e = estimate(d), cost = surveyCost(g, d), res = RESOURCES[d.resource];
  const mine = g.mines.find((m) => m.deposit === d.id);
  const mined = d.actualTons - d.remaining;
  return (
    <div className="card">
      <header><h4>{d.name}</h4><span className={`tag ${d.owned ? 'good' : ''}`}>{d.owned ? 'Your claim' : 'Open ground'}</span></header>
      <Row k="Mineral" v={res.name} />
      <Row k="Survey" v={SURVEY_NAMES[d.surveyLevel]} />
      <Row k="Ore in the ground" v={d.remaining <= 0 ? 'Worked out' : `${e.low.toLocaleString('en-US')} – ${e.high.toLocaleString('en-US')} t`} />
      <div className="meter" title="How sure the survey is"><span style={{ width: `${Math.round(e.confidence * 100)}%` }} /></div>
      <p className="hint">{d.surveyLevel < 3 ? `About ${Math.round(e.confidence * 100)}% sure. A better survey narrows the range — in either direction.` : 'Core-drilled: this figure can be banked on.'}</p>
      {res.concentrate && <Row k="Grade" v={`${Math.round(1 / (res.concentrateRatio * d.grade))} t of ore to 1 t of concentrate`} />}
      <Row k="Depth of cover" v={feet(d.depth)} tone="dim" />
      {mined > 0 && <Row k="Mined to date" v={tons(mined)} tone="dim" />}
      <div className="btnrow">
        {cost != null && <Btn onClick={() => run({ type: 'survey', deposit: d.id })}>{SURVEY_NAMES[d.surveyLevel + 1]} · {fmtMoney(cost)}</Btn>}
        {!d.owned && <Btn kind="primary" onClick={() => run({ type: 'buyClaim', deposit: d.id })}>File claim · {fmtMoney(claimPrice(g, d))}</Btn>}
        {d.owned && !mine && <Btn kind="ghost" onClick={() => run({ type: 'sellClaim', deposit: d.id })}>Sell claim · {fmtMoney(claimPrice(g, d) * FINANCE.resaleFactor)}</Btn>}
        <Btn kind="ghost" onClick={() => theWorld?.focus(d.x, d.z, 34)}>Show</Btn>
      </div>
    </div>
  );
}
function SurveyPanel({ g }: { g: GameState }) {
  const known = g.deposits.filter((d) => d.discovered), rumours = g.deposits.filter((d) => !d.discovered && d.rumor);
  return (
    <>
      <Section title="Prospecting">
        <p className="status">Click any ground to send prospectors over it: {fmtMoney(SURVEY.prospectCost)} a party, covering the ringed area. What is there to find was settled long before you arrived.</p>
        {rumours.map((d) => <div className="card" key={d.id}><header><h4>Talk of {RESOURCES[d.resource].name.toLowerCase()}</h4><span className="tag">Rumour</span></header><p className="status">Trappers speak of float ore beyond the western ridge. Nobody has staked it.</p><Btn kind="ghost" onClick={() => theWorld?.focus(d.rumor!.x, d.rumor!.z, 46)}>Show the ground</Btn></div>)}
      </Section>
      <Section title="Known deposits">{known.map((d) => <DepositCard key={d.id} g={g} d={d} />)}</Section>
    </>
  );
}

// ───────────────────────────── Terrain / Rail / Build tool panels ─────────────────────────────
const TERRAIN_TOOLS = [
  ['grade', 'Grade', 'Level the ground to the height where you press. Drag to spread it.'],
  ['excavate', 'Excavate', 'Dig soil with pick and shovel. Stops at bedrock.'],
  ['fill', 'Fill', 'Raise the ground. Uses spoil you have dug before buying more.'],
  ['blast', 'Blast', 'Powder and fuse: the only way through rock, and the dearest.'],
  ['clear', 'Clear', 'Fell the timber. The logs go to the yard for ties.'],
] as const;
function TerrainPanel({ g }: { g: GameState }) {
  const ui = useUI();
  const cur = TERRAIN_TOOLS.find((t) => t[0] === ui.terrainTool)!;
  return (
    <>
      <Section title="Earthworks">
        <div className="seg" role="radiogroup" aria-label="Terrain tool">{TERRAIN_TOOLS.map(([id, name]) => <button type="button" key={id} role="radio" aria-checked={ui.terrainTool === id} className={ui.terrainTool === id ? 'on' : ''} onClick={() => ui.set({ terrainTool: id })}>{name}</button>)}</div>
        <p className="status">{cur[2]}</p>
        <div className="field"><span>Brush</span><div className="seg small">{[1, 2, 3].map((r) => <button type="button" key={r} className={ui.brush === r ? 'on' : ''} onClick={() => ui.set({ brush: r })}>{['Small', 'Medium', 'Wide'][r - 1]}</button>)}</div></div>
        <p className="hint">Click or drag on the ground. The price follows the pointer. Hold Space and drag, or use W A S D, to move the view while a tool is in hand.</p>
      </Section>
      <Section title="Materials on hand">
        <Row k="Spoil" v={`${g.materials.spoil.toFixed(0)} yd`} /><Row k="Stone" v={`${g.materials.stone.toFixed(0)} yd`} /><Row k="Timber" v={`${g.materials.timber.toFixed(0)} loads`} />
        <p className="hint">Spoil makes cheap fill. Stone and timber come off the price of the next line as ballast and ties.</p>
      </Section>
      <Section title="Rates"><Row k="Soil" v="$22 a yard" tone="dim" /><Row k="Rock" v={g.upgrades.giant_powder ? '$71 a yard' : '$118 a yard'} tone="dim" /><Row k="Fill" v="$12 from spoil, $30 hauled in" tone="dim" /><Row k="Far from the railhead" v="up to +40%" tone="dim" /></Section>
    </>
  );
}

/** Sign the contract for the line laid out, and take the player to where the work starts. */
function signLine() {
  const ui = useUI.getState(), first = ui.way[0];
  const r = ui.run({ type: 'buildLine', way: ui.way, options: ui.routeOpt });
  if (r.ok) { ui.setWay([]); ui.setTool('inspect'); if (first) theWorld?.focus(first.x + 3, first.z, 30); }
}
/** Whether the line laid out stops short of a claim the railroad has not reached yet. */
function stopsShort(g: GameState): boolean {
  const ui = useUI.getState(), gold = ownClaim(g), end = ui.way[ui.way.length - 1];
  return !g.stats.reachedClaim && !!gold && !!end && !ui.line?.end && Math.hypot(end.x - gold.x, end.z - gold.z) > CLAIM_RING;
}
/** The first line is no use without a mine and a platform at the end of it, so the first loan covers those too. */
const opening = (g: GameState) => g.mines.length === 0 && g.edges.length === 0;
function contractLoan(g: GameState, short: number): number | null {
  return (opening(g) ? loanFor(g, short, MINE.cost + STATION.platformCost + 1500) : null) ?? loanFor(g, short);
}
/** The one thing to do next with a line that has been laid out: fix it, borrow for it, or sign for it. */
function ContractAction({ g }: { g: GameState }) {
  const run = useUI((s) => s.run);
  const line = useUI((s) => s.line);
  if (!line) return null;
  const total = line.plan.total, short = total - g.finance.cash, loan = contractLoan(g, short);
  if (line.error) return <Btn kind="primary" onClick={() => undefined} disabled>Not buildable</Btn>;
  if (short > 0 && loan) return <Btn kind="primary" onClick={() => run({ type: 'borrow', amount: loan })}>Borrow {fmtMoney(loan)}</Btn>;
  if (short > 0) return <Btn kind="primary" onClick={() => undefined} disabled>Short by {fmtMoney(short)}</Btn>;
  return <Btn kind="primary" onClick={signLine}>Sign the contract · {fmtMoney(total)}</Btn>;
}
/** What stands between the line and a signature, in a sentence. */
function contractNote(g: GameState): { text: string; bad?: boolean } | null {
  const ui = useUI.getState(), line = ui.line;
  if (!line) return null;
  if (line.error) return { text: line.error, bad: true };
  const short = line.plan.total - g.finance.cash;
  if (short > 0) return contractLoan(g, short)
    ? { text: opening(g) && contractLoan(g, short)! > short + 5000 ? `You hold ${fmtMoney(g.finance.cash)}. The bank lends the rest, and enough to open the mine, at ${(monthlyRate(g) * 100).toFixed(1)}% a month.` : `You hold ${fmtMoney(g.finance.cash)}. The bank lends the rest at ${(monthlyRate(g) * 100).toFixed(1)}% a month.` }
    : { text: `Short by ${fmtMoney(short)}, and the bank will not lend that much. Draw a shorter or easier line.`, bad: true };
  if (stopsShort(g)) return { text: 'This stops short of the claim. Drag on from the gold end, into the ring.' };
  return null;
}

function RailPanel({ g }: { g: GameState }) {
  const ui = useUI();
  const line = ui.line, plan = line?.plan;
  const train = g.trains[0];
  const items: Array<[string, number]> = plan ? [
    ['Rails and ties', plan.items.rails], ['Labour', plan.items.labour], ['Grading', plan.items.grading], ['Explosives', plan.items.explosives],
    ['Bridges', plan.items.bridges], ['Tunnels', plan.items.tunnels], ['Land and clearing', plan.items.land], ['Own timber and stone', plan.items.materialsCredit],
  ] : [];
  let est: ReactNode = null;
  if (plan && plan.pts.length > 3) {
    // what the present engine could haul over this line alone, in each direction
    const cum: number[] = [0]; for (let i = 1; i < plan.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(plan.pts[i].x - plan.pts[i - 1].x, plan.pts[i].z - plan.pts[i - 1].z));
    let up = 0, dn = 0;
    for (let i = 4; i < plan.pts.length; i++) { const gr = gradePct((plan.pts[i].h - plan.pts[i - 4].h) / (cum[i] - cum[i - 4])); up = Math.max(up, gr); dn = Math.max(dn, -gr); }
    est = <Row k={`${LOCOS[train.loco].name} could take`} v={`${maxWagons(LOCOS[train.loco], dn, up)} hoppers`} />;
  }
  const note = contractNote(g);
  const surveyed = () => { const way = suggestRoute(g, ui.way[0], ui.way[ui.way.length - 1]); if (way) { ui.keepWay(); ui.setWay(way); } else ui.toast('info', 'The surveyor finds no better way between these two points.'); };
  return (
    <>
      <Section title="Lay a line">
        {ui.lifting ? <p className="status">Click a finished line to lift its rails. A fifth of their cost comes back; the earthworks stay.</p>
          : ui.way.length === 0 ? <p className="status">Press on the {g.edges.length ? 'terminal, or on any track you own,' : 'gold marker at the Prosperity terminal'} and drag. The line follows your hand, and the engineer prices it as you go.</p>
          : ui.way.length === 1 ? <p className="status">Drag from the marker to draw the line. Or click where it should end, and the surveyor will find a way there.</p>
          : <p className="status">Drag from the gold end to carry the line on. Drag a white marker to bend it, click the ground to add one, double-click one to remove it.</p>}
        <div className="btnrow">
          {ui.wayUndo.length > 0 && <Btn kind="ghost" onClick={ui.undoWay}>Undo</Btn>}
          {ui.way.length > 0 && <Btn kind="ghost" onClick={() => ui.setWay([])}>Start over</Btn>}
          {ui.way.length > 1 && <Btn kind="ghost" onClick={surveyed} title="Let the surveyor find the easiest ground between the two ends">Surveyor's route</Btn>}
          {ui.way.length > 2 && <Btn kind="ghost" onClick={() => { ui.keepWay(); ui.setWay([ui.way[0], ui.way[ui.way.length - 1]]); }}>Straight line</Btn>}
          <Btn kind={ui.lifting ? 'danger' : 'ghost'} onClick={() => { ui.set({ lifting: !ui.lifting }); ui.setWay([]); }}>{ui.lifting ? 'Stop lifting track' : 'Lift track…'}</Btn>
        </div>
      </Section>
      {plan && plan.pts.length > 0 && (
        <>
          <Section title="The engineer's estimate" aside={<span className={`tag ${line!.error ? 'bad' : 'good'}`}>{line!.error ? 'Not buildable' : 'Buildable'}</span>}>
            {line!.error && <div className="alert">{line!.error}</div>}
            <Row k="Length" v={miles(plan.length)} />
            <Row k="Steepest grade" v={`${plan.maxGrade.toFixed(1)}%`} tone={plan.maxGrade > TRACK.maxGradePct + 0.06 ? 'bad' : undefined} />
            <Row k="Tightest curve" v={plan.minRadius > 60 ? 'Straight' : `${Math.round(plan.minRadius * WORLD.cellMeters * 3.281)} ft radius`} tone={plan.minRadius < TRACK.minRadius ? 'bad' : undefined} />
            <Row k="Cut" v={`${plan.cutSoil.toFixed(0)} yd soil · ${plan.cutRock.toFixed(0)} yd rock`} />
            <Row k="Embankment" v={`${plan.fill.toFixed(0)} yd`} />
            <Row k="Trestle / tunnel" v={`${miles(plan.bridgeCells)} / ${miles(plan.tunnelCells)}`} />
            <Row k="Time to build" v={`${Math.ceil(plan.buildDays)} days`} />
            {est}
            <Row k="Upkeep once open" v={`${fmtMoney((plan.length - plan.bridgeCells - plan.tunnelCells) * TRACK.maintenance + plan.bridgeCells * TRACK.maintenanceBridge + plan.tunnelCells * TRACK.maintenanceTunnel)}/day`} tone="dim" />
          </Section>
          <Section title="Contract price">
            {items.filter(([, v]) => v !== 0).map(([k, v]) => <Row key={k} k={k} v={fmtMoney(v)} />)}
            <div className="rule" />
            <Row k="Total" v={<strong>{fmtMoney(plan.total)}</strong>} tone={plan.total > g.finance.cash ? 'bad' : undefined} />
            <div className="legend"><i className="k0" />at grade<i className="k1" />earthwork<i className="k2" />trestle<i className="k3" />tunnel</div>
          </Section>
          <Section title="Engineering choices">
            <div className="field"><span>Profile</span><div className="seg small">{[[-1, 'Cut'], [0, 'Balanced'], [1, 'Fill']].map(([b, n]) => <button type="button" key={b} className={ui.routeOpt.bias === b ? 'on' : ''} onClick={() => ui.setWay(ui.way, { bias: b as number })}>{n}</button>)}</div></div>
            <label className="check"><input type="checkbox" checked={ui.routeOpt.bridges} onChange={(e) => ui.setWay(ui.way, { bridges: e.target.checked })} /> Trestle over deep hollows instead of filling them</label>
            <label className="check"><input type="checkbox" checked={ui.routeOpt.tunnels} onChange={(e) => ui.setWay(ui.way, { tunnels: e.target.checked })} /> Tunnel where a cut would be deeper than 55 ft</label>
          </Section>
          <div className="sticky">
            {note && !line!.error && <p className={`hint ${note.bad ? 'bad' : ''}`}>{note.text}</p>}
            <ContractAction g={g} />
          </div>
        </>
      )}
      {g.jobs.length > 0 && <Section title="Under construction">{g.jobs.map((j) => <div key={j.id}><Row k={miles(j.length)} v={`${Math.round((j.progress / j.length) * 100)}%`} /><div className="meter"><span style={{ width: `${(j.progress / j.length) * 100}%` }} /></div></div>)}</Section>}
    </>
  );
}

/**
 * On a phone the map is the whole screen and track is drawn on it with a finger, so the Railroad tool keeps to a strip
 * above the tools: what to do, what the line costs, and the one button that moves it forward. The full estimate is a tap away.
 */
function RailDock({ g }: { g: GameState }) {
  const ui = useUI();
  const line = ui.line, plan = line?.plan, note = contractNote(g);
  const laid = !!plan && ui.way.length >= 2;
  return (
    <aside className={`dock ${ui.drawing ? 'drawing' : ''}`} aria-label="Railroad">
      {ui.lifting ? <p className="docktitle">Tap a finished line to lift its rails.</p>
        : laid ? <p className="docktitle"><b>{fmtMoney(plan!.total)}</b><span>{miles(plan!.length)} · {Math.ceil(plan!.buildDays)} days to build · {plan!.maxGrade.toFixed(1)}% grade</span></p>
        : ui.way.length === 1 ? <p className="docktitle">Drag from the gold marker to draw the line.</p>
        : <p className="docktitle">{g.edges.length ? 'Put a finger on a gold marker and drag to draw a line.' : g.stats.reachedClaim ? 'Put a finger on the gold marker and drag to draw a line.' : 'Put a finger on the gold marker at Prosperity and drag to the ring on the claim.'}</p>}
      {laid && !ui.lifting && note && <p className={`docksub ${note.bad ? 'bad' : ''}`}>{note.text}</p>}
      {(laid || ui.lifting || ui.way.length === 1) && (
        <div className="dockrow">
          {ui.lifting ? <Btn kind="danger" onClick={() => ui.set({ lifting: false })}>Stop lifting track</Btn> : (
            <>
              {ui.wayUndo.length > 0 && <Btn kind="ghost" onClick={ui.undoWay}>Undo</Btn>}
              <Btn kind="ghost" onClick={() => ui.setWay([])}>Clear</Btn>
              {laid && <Btn kind="ghost" onClick={() => ui.set({ panelOpen: true })}>Details</Btn>}
              {laid && <ContractAction g={g} />}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/** The same strip for the other tools that work on the map: what a tap will do, and a way back to the choices. */
function ToolDock({ g }: { g: GameState }) {
  const ui = useUI();
  const text = ui.tool === 'build'
    ? ui.buildKind === 'mine' ? `Mine · ${fmtMoney(MINE.cost)}. Tap level ground on your claim, near the track.`
      : ui.buildKind === 'platform' ? `Loading platform · ${fmtMoney(STATION.platformCost)}. Tap the track beside the mine.`
      : `Stamp mill · ${fmtMoney(MILL.cost)}. Tap level ground beside the mine.`
    : ui.tool === 'terrain' ? `${TERRAIN_TOOLS.find((t) => t[0] === ui.terrainTool)![1]}, ${['small', 'medium', 'wide'][ui.brush - 1]} brush. Tap the ground to work it.`
    : `Tap any ground to prospect it · ${fmtMoney(SURVEY.prospectCost)}.`;
  void g;
  return (
    <aside className="dock slim" aria-label={TITLES[ui.tool]}>
      <p className="docktitle">{text}</p>
      <Btn kind="ghost" onClick={() => ui.set({ panelOpen: true })}>Options</Btn>
    </aside>
  );
}

function BuildPanel({ g }: { g: GameState }) {
  const ui = useUI();
  const kinds = [
    ['mine', 'Mine', MINE.cost, 'On a claim you hold, on level ground, within reach of connected track. Hand mining brings out 14 tons a day.'],
    ['platform', 'Loading platform', STATION.platformCost, 'On finished track. Serves every mine and mill inside the ring; trains load here.'],
    ['mill', 'Stamp mill', MILL.cost, 'Beside a mine. Crushes ore to concentrate: an eighth of the weight, most of the value.'],
  ] as const;
  return (
    <>
      <Section title="Build">
        {kinds.map(([id, name, cost, text]) => (
          <button type="button" key={id} className={`pick ${ui.buildKind === id ? 'on' : ''}`} onClick={() => ui.set({ buildKind: id, ...(isPhone() ? { panelOpen: false } : {}) })} aria-pressed={ui.buildKind === id}>
            <span className="t">{name}</span><span className="c">{fmtMoney(cost)}</span><span className="d">{text}</span>
          </button>
        ))}
        <p className="hint">Pick what to build, then tap the ground. If a site is too rough, level it with Terrain → Grade first.</p>
      </Section>
      <Section title="Shipping raw ore or concentrate?">
        <p className="status">Raw gold ore fetches about ${price(g, 'gold_ore', g.day).toFixed(0)} a ton; concentrate about ${price(g, 'gold_conc', g.day).toFixed(0)}. A mill costs {fmtMoney(MILL.tiers[0].cost)} a day to run, and one hopper of concentrate is worth sixteen of ore. The farther the mine, the stronger the case.</p>
      </Section>
    </>
  );
}

// ───────────────────────────── Selection panels ─────────────────────────────
function SelectionPanel({ g }: { g: GameState }) {
  const sel = useUI((s) => s.selection)!;
  const run = useUI((s) => s.run);
  if (sel.kind === 'train') { const t = g.trains.find((x) => x.id === sel.id); return t ? <Section title="Locomotive"><TrainCard g={g} t={t} /></Section> : null; }
  if (sel.kind === 'deposit') { const d = g.deposits.find((x) => x.id === sel.id); return d ? <Section title="Mineral deposit"><DepositCard g={g} d={d} /></Section> : null; }
  if (sel.kind === 'mine') {
    const m = g.mines.find((x) => x.id === sel.id); if (!m) return null;
    const d = g.deposits.find((x) => x.id === m.deposit)!, t = mineTier(g), e = estimate(d);
    const mill = g.mills.find((l) => l.mine === m.id);
    const res = RESOURCES[d.resource];
    const perTon = mill && res.concentrate ? price(g, res.concentrate, g.day) * res.concentrateRatio * d.grade * millTier(g).recovery : price(g, res.ore, g.day) * d.grade;
    const rate = t.rate / d.difficulty;
    return (
      <Section title={`${d.name} mine`} aside={<span className="tag">{t.name}</span>}>
        <p className="status">{m.status}</p>
        <Row k="Mineral" v={res.name} />
        <Row k="Reserves, estimated" v={m.exhausted ? 'Worked out' : `${e.low.toLocaleString('en-US')} – ${e.high.toLocaleString('en-US')} t`} />
        <Row k="Output" v={`${rate.toFixed(0)} t/day`} />
        <Row k="Stockpile" v={`${tons(m.stock)} of ${t.capacity} t`} tone={m.stock >= t.capacity - 0.5 ? 'bad' : undefined} />
        <div className="meter"><span style={{ width: `${(m.stock / t.capacity) * 100}%` }} /></div>
        <Row k="Wages" v={`${fmtMoney(m.active && !m.exhausted ? t.labour : 0)}/day`} />
        <Row k="Worth at today's market" v={`${fmtMoney(rate * perTon)}/day ${mill ? 'as concentrate' : 'as raw ore'}`} tone="good" />
        <Row k="Brought out to date" v={tons(m.producedTotal)} tone="dim" />
        {!m.exhausted && <Btn onClick={() => run({ type: 'setActive', kind: 'mine', id: m.id, active: !m.active })}>{m.active ? 'Suspend the mine' : 'Resume mining'}</Btn>}
      </Section>
    );
  }
  if (sel.kind === 'mill') {
    const l = g.mills.find((x) => x.id === sel.id); if (!l) return null;
    const mine = g.mines.find((m) => m.id === l.mine), t = millTier(g);
    return (
      <Section title="Stamp mill" aside={<span className="tag">{t.name}</span>}>
        <p className="status">{l.status}</p>
        <Row k="Ore waiting" v={tons(mine?.stock ?? 0)} />
        <Row k="Concentrate ready" v={`${tons(l.stock)} of ${t.capacity} t`} />
        <div className="meter"><span style={{ width: `${(l.stock / t.capacity) * 100}%` }} /></div>
        <Row k="Throughput" v={`${t.throughput} t of ore a day`} />
        <Row k="Recovery" v={`${Math.round(t.recovery * 100)}% of the metal`} />
        <Row k="Running cost" v={`${fmtMoney(l.active ? t.cost : 0)}/day`} />
        <Row k="Treated to date" v={tons(l.processedTotal)} tone="dim" />
        <Btn onClick={() => run({ type: 'setActive', kind: 'mill', id: l.id, active: !l.active })}>{l.active ? 'Bank the fires' : 'Raise steam'}</Btn>
      </Section>
    );
  }
  if (sel.kind === 'station') {
    const st = g.stations.find((x) => x.id === sel.id); if (!st) return null;
    const w = stationWorks(g, st);
    return (
      <Section title={st.name} aside={<span className="tag">Freight platform</span>}>
        <Row k="Serves" v={`${w.mines.length} mine${w.mines.length === 1 ? '' : 's'}, ${w.mills.length} mill${w.mills.length === 1 ? '' : 's'}`} />
        <Row k="Ore waiting" v={tons(w.mines.reduce((a, m) => a + m.stock, 0))} />
        <Row k="Concentrate waiting" v={tons(w.mills.reduce((a, m) => a + m.stock, 0))} />
        <Row k="Loading rate" v={`${STATION.loadRate} t/day`} tone="dim" />
        <Row k="Trains calling" v={g.trains.filter((t) => t.dest === st.id).map((t) => t.name).join(', ') || 'None'} />
        <label className="check"><input type="checkbox" checked={st.shipRaw} onChange={(e) => run({ type: 'shipRaw', station: st.id, value: e.target.checked })} /> Top up with raw ore when the concentrate bins are empty</label>
      </Section>
    );
  }
  if (sel.kind === 'city') {
    return (
      <Section title="Prosperity" aside={<span className="tag">City terminal</span>}>
        <p className="status">Market, bank, supply depot and locomotive works. Everything the company sells is sold here, off the back of a train.</p>
        <Row k="Shipments sold" v={g.stats.shipmentsSold} /><Row k="Tonnage sold" v={tons(g.stats.tonsSold)} />
        <Row k="Gold concentrate" v={`$${price(g, 'gold_conc', g.day).toFixed(0)}/t`} /><Row k="Gold ore" v={`$${price(g, 'gold_ore', g.day).toFixed(0)}/t`} />
      </Section>
    );
  }
  if (sel.kind === 'edge') {
    const e = edgeById(g, sel.id); if (!e) return null;
    const plain = e.length - e.bridgeCells - e.tunnelCells;
    const up = (plain * TRACK.maintenance + e.bridgeCells * TRACK.maintenanceBridge + e.tunnelCells * TRACK.maintenanceTunnel) * (g.upgrades.steel_rails ? TRACK.steelMaintenanceFactor : 1);
    const busy = g.trains.some((t) => t.trip?.edges.includes(e.id));
    return (
      <Section title="Line section" aside={<span className="tag">{g.upgrades.steel_rails ? 'Steel rail' : 'Iron rail'}</span>}>
        <Row k="Length" v={miles(e.length)} /><Row k="Steepest grade" v={`${e.maxGrade.toFixed(1)}%`} />
        <Row k="Trestle / tunnel" v={`${miles(e.bridgeCells)} / ${miles(e.tunnelCells)}`} />
        <Row k="Opened" v={`day ${e.builtDay}`} /><Row k="Upkeep" v={`${fmtMoney(up)}/day`} />
        <Row k="Capacity" v="Single track: one train at a time" /><Row k="Now" v={busy ? 'Occupied' : 'Clear'} tone={busy ? 'bad' : 'good'} />
        <Btn kind="danger" onClick={() => run({ type: 'demolish', edge: e.id })} disabled={busy}>Lift this section</Btn>
      </Section>
    );
  }
  if (sel.kind !== 'terrain') return null;
  const h = heightAt(g, sel.x, sel.z), so = soilAt(g, sel.x, sel.z);
  const cx = Math.min(WORLD.size - 1, Math.floor(sel.x)), cz = Math.min(WORLD.size - 1, Math.floor(sel.z));
  return (
    <Section title="Ground">
      <Row k="Elevation above the city" v={feet(h - g.city.h)} />
      <Row k="Surface" v={g.water[ci(cx, cz)] ? 'River' : so < 0.22 ? 'Bare rock' : g.forest[ci(cx, cz)] ? 'Forest' : 'Open ground'} />
      <Row k="Soil over bedrock" v={so < 0.05 ? 'None' : feet(so)} />
      <Row k="From the terminal" v={miles(Math.hypot(sel.x - g.city.x, sel.z - g.city.z))} tone="dim" />
      <p className="hint">Soil digs cheaply. Rock has to be blasted. Pick a tool on the left to work this ground.</p>
    </Section>
  );
}

const TITLES: Record<string, string> = { survey: 'Survey', terrain: 'Terrain', rail: 'Railroad', build: 'Build', trains: 'Trains', finance: 'Finance', works: 'Works', inspect: 'Inspect' };

export function SidePanel() {
  const g = useUI((s) => s.game)!;
  const tool = useUI((s) => s.tool);
  const sel = useUI((s) => s.selection);
  const open = useUI((s) => s.panelOpen);
  const set = useUI((s) => s.set);
  useUI((s) => s.rev);
  const phone = usePhone();
  const showSel = !!sel && (tool === 'inspect' || tool === 'trains' || tool === 'finance' || tool === 'works');
  if (!open || (tool === 'inspect' && !sel)) {
    if (!phone || sel) return null;
    return tool === 'rail' ? <RailDock g={g} /> : tool === 'build' || tool === 'terrain' || tool === 'survey' ? <ToolDock g={g} /> : null;
  }
  return (
    <aside className="panel" aria-label={showSel ? 'Selection' : TITLES[tool]}>
      <header className="panelhead">
        <h2>{showSel ? 'Inspect' : TITLES[tool]}</h2>
        <button type="button" className="x" onClick={() => set({ panelOpen: false, selection: null })} aria-label="Close panel">×</button>
      </header>
      <div className="panelbody">
        {showSel ? <SelectionPanel g={g} />
          : tool === 'finance' ? <FinancePanel g={g} />
          : tool === 'trains' ? <TrainsPanel g={g} />
          : tool === 'works' ? <WorksPanel g={g} />
          : tool === 'survey' ? <SurveyPanel g={g} />
          : tool === 'terrain' ? <TerrainPanel g={g} />
          : tool === 'rail' ? <RailPanel g={g} />
          : tool === 'build' ? <BuildPanel g={g} /> : null}
      </div>
    </aside>
  );
}
