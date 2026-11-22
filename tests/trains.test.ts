import { describe, expect, it } from 'vitest';
import { LOCOS, RESISTANCE, STATION, WAGON } from '../src/sim/config';
import { edgeById, findPath, nodeById, reservedEdges, stationById } from '../src/sim/rail';
import { exec, tick } from '../src/sim/sim';
import { cargoTons, haulTons, maxWagons, planService, spareWagons, tripPose } from '../src/sim/trains';
import type { GameState, Station, Train, TrainPhase } from '../src/sim/types';
import { Auditor, TPD, expectUnchanged, must, runTicks, runUntil, snapshot, world } from './helpers';

const platform = (s: GameState) => s.stations.find((t) => !t.city)!;
/** Where the engine physically is. */
function trainPos(s: GameState, t: Train) {
  if (t.trip) { const p = tripPose(t.trip, t.trip.dist); return { x: p.x, z: p.z }; }
  const st = stationById(s, t.at)!;
  return { x: st.x, z: st.z };
}
const trackKeys = (s: GameState) => { const k = new Set<string>(); for (const e of s.edges) for (const p of e.pts) k.add(`${p.x},${p.z},${p.h}`); return k; };

/** Per-tick routing invariants for every train; call after each tick. */
function makeWatcher(s: GameState) {
  const last = new Map<number, { x: number; z: number; phase: TrainPhase; dist: number; trip: unknown }>();
  for (const t of s.trains) last.set(t.id, { ...trainPos(s, t), phase: t.phase, dist: t.trip?.dist ?? 0, trip: t.trip });
  const LEGAL: Record<TrainPhase, TrainPhase[]> = {
    idle: ['idle', 'outbound', 'blocked'], blocked: ['blocked', 'outbound', 'idle'], outbound: ['outbound', 'loading'],
    loading: ['loading', 'inbound'], inbound: ['inbound', 'unloading'], unloading: ['unloading', 'idle'],
  };
  const seen = new Set<string>();
  return {
    seen,
    check() {
      // no two trains ever hold the same piece of track
      const held = new Map<number, number>();
      for (const t of s.trains) if (t.trip) for (const e of t.trip.edges) {
        expect(held.has(e), `edge ${e} reserved by trains ${held.get(e)} and ${t.id}`).toBe(false);
        held.set(e, t.id);
        expect(edgeById(s, e), 'reserved edge exists').toBeDefined();
      }
      for (const t of s.trains) expect([...reservedEdges(s, t.id)].some((e) => t.trip?.edges.includes(e) ?? false)).toBe(false);
      for (const t of s.trains) {
        const was = last.get(t.id);
        const pos = trainPos(s, t);
        if (was) {
          expect(LEGAL[was.phase], `${was.phase} → ${t.phase}`).toContain(t.phase);
          seen.add(`${was.phase}>${t.phase}`);
          // an engine moves along the rails: it never jumps
          const top = LOCOS[t.loco].speed * 1.12 / TPD + 1e-6;
          expect(Math.hypot(pos.x - was.x, pos.z - was.z), `train ${t.id} jumped in ${was.phase} → ${t.phase}`).toBeLessThanOrEqual(top);
        }
        const moving = t.phase === 'outbound' || t.phase === 'inbound';
        expect(!!t.trip, `trip present iff moving (${t.phase})`).toBe(moving);
        if (t.trip) {
          const trip = t.trip;
          expect(trip.dist).toBeGreaterThanOrEqual(trip.prev);
          expect(trip.dist).toBeLessThanOrEqual(trip.length + 1e-9);
          expect(trip.dist).toBeGreaterThanOrEqual(0);
          expect(trip.edges.length).toBeGreaterThan(0);
          expect(trip.length).toBeGreaterThan(0);
          if (was && was.trip === trip) { expect(trip.dist).toBeGreaterThanOrEqual(was.dist); expect(trip.prev).toBe(was.dist); }
        } else expect(t.speed).toBe(0);
        expect(cargoTons(t)).toBeLessThanOrEqual(t.consist * WAGON.capacity + 1e-9);
        last.set(t.id, { ...pos, phase: t.phase, dist: t.trip?.dist ?? 0, trip: t.trip });
      }
    },
  };
}

describe('train routing', () => {
  it('with no service assigned the engine stands at the terminal and costs nothing', () => {
    const s = world.line();
    const t = s.trains[0];
    expect(t.dest).toBeNull();
    const ops0 = s.finance.period.by.train_ops ?? 0;
    runTicks(s, 5 * TPD);
    expect(t.phase).toBe('idle');
    expect(t.trip).toBeNull();
    expect(t.at).toBe(s.city.station);
    expect(s.finance.period.by.train_ops ?? 0).toBe(ops0);
  });

  it('a service can only be assigned to a loading platform', () => {
    const s = world.mine();
    const t = s.trains[0];
    const before = snapshot(s);
    expect(exec(s, { type: 'assign', train: t.id, station: s.city.station }).ok).toBe(false);
    expect(exec(s, { type: 'assign', train: t.id, station: 424242 }).ok).toBe(false);
    expect(exec(s, { type: 'assign', train: 424242, station: platform(s).id }).ok).toBe(false);
    expectUnchanged(s, before);
  });

  it('the service plan follows the tractive-effort formula', () => {
    const tank = LOCOS.tank, big = LOCOS.consolidation;
    expect(haulTons(tank, 0)).toBeCloseTo(tank.tractiveEffort / RESISTANCE.rolling - tank.weight, 9);
    expect(haulTons(tank, 2)).toBeCloseTo(tank.tractiveEffort / (RESISTANCE.rolling + 2 * RESISTANCE.perGradePct) - tank.weight, 9);
    expect(haulTons(tank, -3)).toBe(haulTons(tank, 0)); // a descent does not add pull
    expect(haulTons(big, 2)).toBeGreaterThan(haulTons(tank, 2) * 2);
    expect(maxWagons(tank, 3.5, 3.5)).toBeLessThan(maxWagons(tank, 1, 1));
    expect(maxWagons(tank, 2, 0)).toBe(Math.floor(haulTons(tank, 2) / (WAGON.tare + WAGON.capacity)));
    expect(maxWagons(tank, 40, 40)).toBe(0);

    const s = world.mine();
    const t = s.trains[0], st = platform(s);
    const plan = planService(s, t, st);
    expect(plan.ok).toBe(true);
    expect(plan.length).toBeCloseTo(findPath(s, s.city.node, st.node)!.length, 9);
    expect(plan.maxWagons).toBe(maxWagons(tank, plan.loadedGrade, plan.emptyGrade));
    expect(plan.consist).toBe(Math.min(t.wagons, plan.maxWagons));
    expect(plan.capacity).toBe(plan.consist * WAGON.capacity);
    expect(planService(s, t, undefined).ok).toBe(false);
    must(s, { type: 'setWagons', train: t.id, wagons: 0 });
    expect(planService(s, t, st)).toMatchObject({ ok: false, reason: 'No wagons assigned to this engine' });
  });

  it('runs the whole cycle on built track: distance is monotonic, never past the end, never off the rails', () => {
    const s = world.mine();
    const t = s.trains[0];
    const st = platform(s);
    const w = makeWatcher(s);
    const keys = trackKeys(s);
    const cityNode = nodeById(s, s.city.node)!, stNode = nodeById(s, st.node)!;
    let trips = 0, lastTrip: unknown = null;
    runTicks(s, 45 * TPD, () => {
      w.check();
      if (t.trip && t.trip !== lastTrip) {
        lastTrip = t.trip; trips++;
        // the polyline is made of built track points, edge by edge, with no gaps
        for (const p of t.trip.pts) expect(keys.has(`${p.x},${p.z},${p.h}`)).toBe(true);
        for (let i = 1; i < t.trip.pts.length; i++) expect(Math.hypot(t.trip.pts[i].x - t.trip.pts[i - 1].x, t.trip.pts[i].z - t.trip.pts[i - 1].z)).toBeLessThan(1);
        const [from, to] = t.phase === 'outbound' ? [cityNode, stNode] : [stNode, cityNode];
        expect(t.trip.pts[0]).toMatchObject({ x: from.x, z: from.z });
        expect(t.trip.pts.at(-1)).toMatchObject({ x: to.x, z: to.z });
        expect(t.trip.length).toBeCloseTo(s.edges.reduce((a, e) => a + e.length, 0), 9);
        expect(t.trip.cum.length).toBe(t.trip.pts.length);
        expect(t.trip.edges.every((id) => s.edges.some((e) => e.id === id))).toBe(true);
      }
      if (t.phase === 'loading') expect(t.at).toBe(st.id);
      if (t.phase === 'unloading' || t.phase === 'idle') expect(t.at).toBe(s.city.station);
    });
    expect(trips).toBeGreaterThanOrEqual(6);
    expect(t.tripsDone).toBeGreaterThanOrEqual(3);
    for (const tr of ['idle>outbound', 'outbound>loading', 'loading>inbound', 'inbound>unloading', 'unloading>idle']) expect(w.seen.has(tr), tr).toBe(true);
    expect(t.hauled).toBeGreaterThan(0);
    expect(s.finance.period.by.train_ops ?? s.finance.history.at(-1)!.by.train_ops).toBeGreaterThan(0);
  });

  it('never moves without a path: with the line lifted the engine reports no track and stays put', () => {
    const s = world.mine();
    const t = s.trains[0], st = platform(s);
    expect(reservedEdges(s).size).toBe(0);
    for (const e of s.edges.slice()) must(s, { type: 'demolish', edge: e.id });
    expect(findPath(s, s.city.node, st.node)).toBeNull();
    const w = makeWatcher(s);
    const events0 = s.events.length;
    runTicks(s, 6 * TPD, () => {
      w.check();
      expect(t.trip).toBeNull();
      expect(t.phase).toBe('blocked');
      expect(t.status).toMatch(/No track/);
      expect(t.speed).toBe(0);
      expect(t.at).toBe(s.city.station);
    });
    expect(t.tripsDone).toBe(0);
    expect(s.events.slice(events0).some((e) => e.type === 'depart')).toBe(false);
    expect(s.finance.totals.revenue).toBe(0);
  });

  it('a line cannot be lifted from under a running train', () => {
    const s = world.mine();
    const t = s.trains[0];
    expect(runUntil(s, () => t.phase === 'outbound' && t.trip!.dist > 5, 5)).toBe(true);
    const before = snapshot(s);
    for (const e of s.edges) {
      const r = exec(s, { type: 'demolish', edge: e.id });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/train is running/);
    }
    expectUnchanged(s, before);
  });

  it('a loaded train whose way home is cut waits at the platform with its cargo and leaves when the line is relaid', () => {
    const s = world.mine();
    s.finance.cash = 200000;
    const t = s.trains[0], st = platform(s);
    expect(runUntil(s, () => t.phase === 'loading', 10)).toBe(true);
    const edge = s.edges[0];
    const way = [{ x: s.nodes[0].x, z: s.nodes[0].z }, ...edge.pts.filter((_, i) => i % 12 === 6 && i > 6 && i < edge.pts.length - 8).map((p) => ({ x: p.x, z: p.z })), { x: st.x, z: st.z }];
    must(s, { type: 'demolish', edge: edge.id });
    const w = makeWatcher(s);
    const a = new Auditor(s);
    a.days(12, () => { w.check(); expect(t.phase).toBe('loading'); expect(t.trip).toBeNull(); expect(t.at).toBe(st.id); });
    expect(t.status).toMatch(/line home is cut/);
    const held = cargoTons(t);
    expect(held).toBeCloseTo(t.consist * WAGON.capacity, 6);
    expect(s.finance.totals.revenue).toBe(0);
    // relay the same alignment
    const r = exec(s, { type: 'buildLine', way });
    expect(r.error).toBeUndefined();
    expect(a.until(() => t.tripsDone === 1, 60, () => w.check())).toBe(true);
    expect(a.sales.length).toBe(1);
    expect(Object.values(a.sales[0].cargo).reduce((x, y) => x + (y ?? 0), 0)).toBeCloseTo(held, 6);
  });

  it('two trains on a single line never hold the same edge at the same time', () => {
    const s = world.mine();
    must(s, { type: 'borrow', amount: 12000 });
    const t1 = s.trains[0];
    const t2 = must<Train>(s, { type: 'buyLoco', loco: 'tank' });
    must(s, { type: 'buyWagons' });
    expect(spareWagons(s)).toBe(0);
    must(s, { type: 'setWagons', train: t1.id, wagons: 3 });
    must(s, { type: 'setWagons', train: t2.id, wagons: 3 });
    must(s, { type: 'assign', train: t2.id, station: platform(s).id });
    const w = makeWatcher(s);
    const a = new Auditor(s);
    let bothOut = 0, held = 0;
    a.days(90, () => {
      w.check();
      if (t1.trip && t2.trip) bothOut++;
      if (s.trains.some((t) => /line occupied/.test(t.status))) held++;
    });
    expect(bothOut).toBe(0); // one line, one train on it
    expect(held).toBeGreaterThan(0); // and the other one really was held for it
    expect(t1.tripsDone).toBeGreaterThanOrEqual(3);
    expect(t2.tripsDone).toBeGreaterThanOrEqual(3);
    expect(a.sales.length).toBe(t1.tripsDone + t2.tripsDone);
  });

  it('with a siding half-way, two trains share the line section by section without ever overlapping', () => {
    const s = world.mine();
    s.finance.cash = 60000;
    const mid = s.edges[0].pts[70];
    const half = must<Station>(s, { type: 'platform', x: mid.x, z: mid.z });
    expect(s.edges.length).toBe(2);
    const t1 = s.trains[0];
    const t2 = must<Train>(s, { type: 'buyLoco', loco: 'consolidation' });
    must(s, { type: 'buyWagons' });
    must(s, { type: 'setWagons', train: t1.id, wagons: 3 });
    must(s, { type: 'setWagons', train: t2.id, wagons: 3 });
    must(s, { type: 'assign', train: t2.id, station: half.id });
    const w = makeWatcher(s);
    const a = new Auditor(s);
    let t2AtHalf = false;
    a.days(60, () => { w.check(); if (t2.phase === 'loading' && t2.at === half.id) t2AtHalf = true; });
    expect(t2AtHalf).toBe(true);
    expect(t1.tripsDone).toBeGreaterThanOrEqual(3); // the through train is not blocked for ever by the one standing at the siding
  });

  it('splitting the line under a running train keeps its reservation and its journey intact', () => {
    const s = world.mine();
    const t = s.trains[0];
    expect(runUntil(s, () => t.phase === 'outbound' && t.trip!.dist > 8, 5)).toBe(true);
    const length = t.trip!.length, dist = t.trip!.dist, old = t.trip!.edges.slice();
    const mid = s.edges[0].pts[70];
    must(s, { type: 'platform', x: mid.x, z: mid.z });
    expect(t.trip!.edges.length).toBe(2);
    expect(t.trip!.edges).toEqual(s.edges.map((e) => e.id));
    expect(t.trip!.edges).not.toContain(old[0]);
    expect(t.trip!.length).toBe(length);
    expect(t.trip!.dist).toBe(dist);
    for (const e of s.edges) expect(exec(s, { type: 'demolish', edge: e.id }).ok).toBe(false);
    const w = makeWatcher(s);
    expect(runUntil(s, () => t.tripsDone === 1, 20, () => w.check())).toBe(true);
  });

  it('wagons: an engine can only take what the yard holds, and the consist is fixed for the trip', () => {
    const s = world.mine();
    const t = s.trains[0];
    expect(s.wagonsOwned).toBe(4);
    const before = snapshot(s);
    const r = exec(s, { type: 'setWagons', train: t.id, wagons: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No spare wagons/);
    expectUnchanged(s, before);
    must(s, { type: 'setWagons', train: t.id, wagons: 2 });
    expect(spareWagons(s)).toBe(2);
    expect(runUntil(s, () => t.phase === 'loading' && cargoTons(t) > 20, 10)).toBe(true);
    expect(t.consist).toBe(2);
    must(s, { type: 'setWagons', train: t.id, wagons: 4 });
    expect(t.consist).toBe(2); // the two extra wagons are in the yard at the terminal, not up at the mine
    expect(runUntil(s, () => t.phase === 'inbound', 10, () => expect(cargoTons(t)).toBeLessThanOrEqual(2 * WAGON.capacity + 1e-9))).toBe(true);
    expect(cargoTons(t)).toBeCloseTo(24, 6);
    expect(runUntil(s, () => t.phase === 'outbound' && t.tripsDone === 1, 10)).toBe(true);
    expect(t.consist).toBe(4);
  });

  it('loading and unloading take time at the posted rates', () => {
    const s = world.mine();
    const t = s.trains[0];
    must(s, { type: 'assign', train: t.id, station: null });
    runTicks(s, 12 * TPD); // let ore pile up
    expect(s.mines[0].stock).toBeGreaterThan(100);
    must(s, { type: 'assign', train: t.id, station: platform(s).id });
    expect(runUntil(s, () => t.phase === 'loading', 10)).toBe(true);
    let prev = cargoTons(t), ticksLoading = 0;
    while (t.phase === 'loading') {
      tick(s); ticksLoading++;
      const now = cargoTons(t);
      expect(now - prev).toBeLessThanOrEqual(STATION.loadRate / TPD + 1e-9);
      prev = now;
    }
    expect(prev).toBeCloseTo(48, 6);
    expect(ticksLoading).toBeGreaterThanOrEqual(Math.floor((48 / STATION.loadRate) * TPD));
    expect(runUntil(s, () => t.phase === 'unloading', 10)).toBe(true);
    let ticksUnloading = 0;
    const rev = s.finance.totals.revenue;
    while (t.phase === 'unloading') { expect(s.finance.totals.revenue).toBe(rev); expect(cargoTons(t)).toBeCloseTo(48, 6); tick(s); ticksUnloading++; }
    expect(ticksUnloading).toBe(Math.ceil((48 / STATION.unloadRate) * TPD));
    expect(s.finance.totals.revenue).toBeGreaterThan(rev);
    expect(cargoTons(t)).toBe(0);
  });
});

describe('re-assigning a train mid-trip', () => {
  it('a train recalled on its way out still arrives where its trip ends, and then comes home instead of being stranded', () => {
    const s = world.mine();
    const t = s.trains[0], st = platform(s);
    expect(runUntil(s, () => t.phase === 'outbound' && t.trip!.dist > 10, 5)).toBe(true);
    must(s, { type: 'assign', train: t.id, station: null });
    const w = makeWatcher(s);
    const a = new Auditor(s);
    let arrivedAt = -1;
    expect(a.until(() => t.phase === 'idle', 30, () => { w.check(); if (t.phase === 'loading' && arrivedAt < 0) arrivedAt = t.at; })).toBe(true);
    expect(arrivedAt).toBe(st.id);
    expect(t.at).toBe(s.city.station);
    a.run(1); // the status line is refreshed on the next dispatch
    expect(t.phase).toBe('idle');
    expect(t.status).toMatch(/no service assigned/);
    // give it the service back: it works normally again
    must(s, { type: 'assign', train: t.id, station: st.id });
    const done = t.tripsDone;
    expect(a.until(() => t.tripsDone === done + 1, 30, () => w.check())).toBe(true);
    expect(a.sales.at(-1)!.revenue).toBeGreaterThan(0);
  });

  it('switching to another platform mid-trip never teleports the engine or its cargo', () => {
    const s = world.mine();
    s.finance.cash = 60000;
    const t = s.trains[0], st = platform(s);
    const mid = s.edges[0].pts[70];
    const half = must<Station>(s, { type: 'platform', x: mid.x, z: mid.z });
    expect(runUntil(s, () => t.phase === 'outbound' && t.trip!.dist > 10, 5)).toBe(true);
    must(s, { type: 'assign', train: t.id, station: half.id });
    const w = makeWatcher(s);
    const a = new Auditor(s);
    const visits: number[] = [];
    expect(a.until(() => t.phase === 'loading' && t.at === half.id, 40, () => { w.check(); if (t.phase === 'loading' && visits.at(-1) !== t.at) visits.push(t.at); })).toBe(true);
    expect(visits[0]).toBe(st.id); // it finished the run it was on
    // switch back while it waits, empty, at the siding: it must not sit there for ever
    must(s, { type: 'assign', train: t.id, station: st.id });
    const done = t.tripsDone;
    expect(a.until(() => t.tripsDone >= done + 2, 40, () => w.check())).toBe(true);
    expect(a.sales.filter((q) => q.revenue > 0).length).toBeGreaterThanOrEqual(1);
  });

  it('a train recalled while loading leaves with what it has', () => {
    const s = world.mine();
    const t = s.trains[0], st = platform(s);
    expect(runUntil(s, () => t.phase === 'loading', 10)).toBe(true);
    must(s, { type: 'assign', train: t.id, station: null });
    const w = makeWatcher(s);
    const a = new Auditor(s);
    expect(a.until(() => t.phase === 'idle', 20, () => w.check())).toBe(true);
    expect(t.tripsDone).toBe(1);
    void st;
  });
});
