import { describe, expect, it } from 'vitest';
import { STATION, TRACK } from '../src/sim/config';
import { suggestRoute } from '../src/sim/autoroute';
import { dailyOpsCost } from '../src/sim/facilities';
import { connected, distToNetwork, findPath, findSnap, isClaimReached, networkNodes, pathPoints, previewLine, totalTrackLength, trackMaintenancePerDay } from '../src/sim/rail';
import { exec, newGame, runDays } from '../src/sim/sim';
import type { GameState, Station } from '../src/sim/types';
import { K_BRIDGE } from '../src/sim/types';
import { SEED, TPD, claimRailhead, expectUnchanged, findBranch, finishLine, lineEnd, must, runTicks, snapshot, startLine, world } from './helpers';

const cityNode = (s: GameState) => s.city.node;

describe('rail graph connectivity', () => {
  it('a fresh company has a terminal and no railroad', () => {
    const s = newGame(SEED);
    expect(s.edges.length).toBe(0);
    expect(networkNodes(s, cityNode(s))).toEqual([cityNode(s)]);
    expect(distToNetwork(s, 50, 50)).toBe(Infinity);
    expect(isClaimReached(s)).toBe(false);
    expect(findPath(s, cityNode(s), 999)).toBeNull();
    expect(findPath(s, cityNode(s), cityNode(s))).toEqual({ steps: [], length: 0 });
  });

  it('the contract charges the quoted price at signing and the line opens only when the crews finish', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 45000 });
    const way = suggestRoute(s, s.nodes[0], claimRailhead(s))!;
    const pv = previewLine(s, way);
    expect(pv.error).toBeNull();
    expect(pv.plan.valid).toBe(true);
    expect(pv.plan.maxGrade).toBeLessThanOrEqual(TRACK.maxGradePct + 0.06);
    expect(pv.plan.minRadius).toBeGreaterThanOrEqual(TRACK.minRadius);
    const it0 = pv.plan.items;
    expect(pv.plan.total).toBe(it0.rails + it0.labour + it0.grading + it0.explosives + it0.bridges + it0.tunnels + it0.land + it0.materialsCredit);
    expect(pv.plan.bridgeCells).toBeGreaterThan(0); // the river is in the way
    const cash = s.finance.cash;
    must(s, { type: 'buildLine', way });
    expect(cash - s.finance.cash).toBe(pv.plan.total);
    expect(s.finance.period.by.construction).toBe(pv.plan.total);
    expect(s.jobs.length).toBe(1);
    expect(s.edges.length).toBe(0);
    // half-way through there is a railhead but no usable track
    runDays(s, Math.floor(pv.plan.buildDays / 2));
    expect(s.jobs.length).toBe(1);
    expect(s.jobs[0].progress).toBeGreaterThan(0);
    expect(s.jobs[0].progress).toBeLessThan(s.jobs[0].length);
    expect(s.edges.length).toBe(0);
    expect(s.stats.reachedClaim).toBe(false);
    expect(networkNodes(s, cityNode(s)).length).toBe(1);
    const cashMid = s.finance.cash;
    finishLine(s);
    expect(Math.abs(s.day - pv.plan.buildDays)).toBeLessThanOrEqual(1.01);
    // nothing more was charged for the construction itself (only interest and upkeep)
    expect(s.finance.totals.capital).toBe(pv.plan.total);
    expect(s.finance.cash).toBeLessThanOrEqual(cashMid);
  });

  it('after construction the city and the railhead are joined, and the path follows the built track', () => {
    const s = world.line();
    expect(s.edges.length).toBe(1);
    const end = lineEnd(s);
    expect(end.id).not.toBe(cityNode(s));
    expect(connected(s, cityNode(s), end.id)).toBe(true);
    expect(connected(s, end.id, cityNode(s))).toBe(true);
    expect(s.stats.reachedClaim).toBe(true);
    expect(isClaimReached(s)).toBe(true);
    const path = findPath(s, cityNode(s), end.id)!;
    expect(path).not.toBeNull();
    expect(path.length).toBeCloseTo(totalTrackLength(s), 9);
    const pts = pathPoints(s, path.steps);
    expect(pts[0].x).toBe(s.nodes[0].x); expect(pts[0].z).toBe(s.nodes[0].z);
    expect(pts.at(-1)!.x).toBe(end.x); expect(pts.at(-1)!.z).toBe(end.z);
    // and back again, the same rails in reverse
    const back = findPath(s, end.id, cityNode(s))!;
    expect(back.length).toBeCloseTo(path.length, 9);
    expect(pathPoints(s, back.steps)).toEqual(pts.slice().reverse());
    const e = s.edges[0];
    expect(e.maxGrade).toBeLessThanOrEqual(TRACK.maxGradePct + 0.06);
    expect(e.bridgeCells).toBeGreaterThan(0);
    expect(e.pts.some((p) => p.k === K_BRIDGE)).toBe(true);
    expect(distToNetwork(s, end.x, end.z)).toBeLessThan(1);
  });

  it('a platform in the middle of a line splits the edge and keeps everything connected', () => {
    const s = world.line();
    const e = s.edges[0];
    const end = lineEnd(s);
    const len = e.length, n = e.pts.length;
    const p = e.pts[40];
    const st = must<Station>(s, { type: 'platform', x: p.x, z: p.z });
    expect(s.edges.length).toBe(2);
    expect(s.edges.some((q) => q.id === e.id)).toBe(false);
    expect(s.edges[0].length + s.edges[1].length).toBeCloseTo(len, 9);
    expect(s.edges[0].pts.length + s.edges[1].pts.length).toBe(n + 1); // the junction point is shared
    expect(s.nodes.some((q) => q.id === st.node)).toBe(true);
    expect(st.x).toBe(p.x); expect(st.z).toBe(p.z);
    expect(connected(s, cityNode(s), st.node)).toBe(true);
    expect(connected(s, cityNode(s), end.id)).toBe(true);
    const path = findPath(s, cityNode(s), end.id)!;
    expect(path.steps.length).toBe(2);
    expect(path.length).toBeCloseTo(len, 9);
    expect(pathPoints(s, path.steps)).toEqual(e.pts);
    expect(findPath(s, cityNode(s), st.node)!.length + findPath(s, st.node, end.id)!.length).toBeCloseTo(len, 9);
    expect(s.trains[0].dest).toBe(st.id); // the idle engine takes the new service
  });

  it('demolishing a section breaks connectivity, and findPath returns null across the gap', () => {
    const s = world.line();
    const end = lineEnd(s);
    const p = s.edges[0].pts[40];
    const st = must<Station>(s, { type: 'platform', x: p.x, z: p.z });
    const [first, second] = s.edges;
    const cash = s.finance.cash, assets = s.finance.assetValue;
    must(s, { type: 'demolish', edge: first.id });
    // the far section still stands, but it is an island
    expect(s.edges.map((q) => q.id)).toEqual([second.id]);
    expect(connected(s, cityNode(s), end.id)).toBe(false);
    expect(connected(s, cityNode(s), st.node)).toBe(false);
    expect(findPath(s, cityNode(s), end.id)).toBeNull();
    expect(findPath(s, cityNode(s), st.node)).toBeNull();
    expect(findPath(s, st.node, end.id)).not.toBeNull();
    expect(connected(s, st.node, end.id)).toBe(true);
    expect(distToNetwork(s, end.x, end.z)).toBe(Infinity);
    expect(isClaimReached(s)).toBe(false);
    // the rails are worth scrap, booked as an asset sale, never as revenue
    const refund = Math.round(first.length * TRACK.railsAndTies * TRACK.demolishRefund);
    expect(s.finance.cash - cash).toBe(refund);
    expect(s.finance.period.by.asset_sale).toBe(refund);
    expect(s.finance.totals.revenue).toBe(0);
    expect(s.finance.assetValue).toBeLessThan(assets);
    const gone = exec(s, { type: 'demolish', edge: first.id });
    expect(gone.ok).toBe(false);
    must(s, { type: 'demolish', edge: second.id });
    expect(s.edges.length).toBe(0);
    expect(networkNodes(s, cityNode(s))).toEqual([cityNode(s)]);
  });

  it('a platform cannot be opened on track that is cut off from the city, and the attempt changes nothing', () => {
    const s = world.line();
    const p = s.edges[0].pts[40];
    must(s, { type: 'platform', x: p.x, z: p.z });
    must(s, { type: 'demolish', edge: s.edges[0].id });
    const island = s.edges[0];
    const q = island.pts[Math.floor(island.pts.length / 2)];
    const before = snapshot(s);
    const r = exec(s, { type: 'platform', x: q.x, z: q.z });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not connected/);
    expectUnchanged(s, before);
    expect(s.edges.length).toBe(1);
  });

  it('platform rules: on finished track only, and not on top of another station', () => {
    const s = world.line();
    const before = snapshot(s);
    const off = exec(s, { type: 'platform', x: 110, z: 110 });
    expect(off.ok).toBe(false);
    expect(off.error).toMatch(/finished track/);
    const atCity = exec(s, { type: 'platform', x: s.nodes[0].x + 1, z: s.nodes[0].z });
    expect(atCity.ok).toBe(false);
    expect(atCity.error).toMatch(/already serves/);
    expectUnchanged(s, before);
    const building = world.building();
    runTicks(building, 10 * TPD);
    const jp = building.jobs[0].pts[20];
    expect(exec(building, { type: 'platform', x: jp.x, z: jp.z }).ok).toBe(false);
    expect(building.stations.length).toBe(1);
  });

  it('a new line must start on existing track', () => {
    const s = newGame(SEED);
    must(s, { type: 'borrow', amount: 40000 });
    const before = snapshot(s);
    const r = exec(s, { type: 'buildLine', way: [{ x: 60, z: 110 }, { x: 70, z: 112 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Start the line on existing track/);
    expectUnchanged(s, before);
    // a line under construction is not track yet
    const b = world.building();
    b.finance.cash = 50000;
    runTicks(b, 10 * TPD);
    const jp = b.jobs[0].pts[20];
    const b0 = snapshot(b);
    expect(exec(b, { type: 'buildLine', way: [{ x: jp.x, z: jp.z }, { x: jp.x + 8, z: jp.z + 6 }] }).ok).toBe(false);
    expectUnchanged(b, b0);
  });

  it('a spur can leave from the middle of a line and joins the network when finished', () => {
    const s = world.line();
    const branch = findBranch(s);
    const cash = s.finance.cash;
    must(s, { type: 'buildLine', way: branch.way });
    expect(cash - s.finance.cash).toBe(branch.plan.total);
    expect(s.edges.length).toBe(2); // the junction is cut in at signing
    const end = lineEnd(s);
    expect(connected(s, cityNode(s), end.id)).toBe(true);
    finishLine(s);
    expect(s.edges.length).toBe(3);
    const tip = s.nodes.at(-1)!;
    expect(Math.hypot(tip.x - branch.way[1].x, tip.z - branch.way[1].z)).toBeLessThan(0.6);
    expect(connected(s, cityNode(s), tip.id)).toBe(true);
    expect(connected(s, tip.id, end.id)).toBe(true);
    expect(findPath(s, cityNode(s), tip.id)!.steps.length).toBe(2);
    expect(findPath(s, tip.id, end.id)!.steps.length).toBe(2);
    // every node is reachable: one network
    expect(networkNodes(s, cityNode(s)).sort()).toEqual(s.nodes.map((n) => n.id).sort());
  });

  it('a line that ends on existing track closes a loop instead of leaving a dangling end', () => {
    const s = world.line();
    s.finance.cash = 200000;
    const e = s.edges[0];
    const a = e.pts[20], b = e.pts[60];
    // bow out to one side and come back onto the line
    const nx = -(b.z - a.z), nz = b.x - a.x, nl = Math.hypot(nx, nz);
    let built = false;
    for (const side of [1, -1]) for (const off of [5, 7, 9]) {
      if (built) break;
      const mid = { x: (a.x + b.x) / 2 + (nx / nl) * off * side, z: (a.z + b.z) / 2 + (nz / nl) * off * side };
      built = exec(s, { type: 'buildLine', way: [{ x: a.x, z: a.z }, mid, { x: b.x, z: b.z }] }).ok;
    }
    expect(built).toBe(true);
    finishLine(s);
    expect(s.edges.length).toBe(4);
    expect(s.nodes.length).toBe(4);
    const end = lineEnd(s);
    // two independent ways between the junctions now: lifting either keeps the railhead connected
    for (const victim of s.edges.filter((q) => q.a !== cityNode(s) && q.b !== end.id && q.a !== end.id && q.b !== cityNode(s))) {
      const t = structuredClone(s);
      must(t, { type: 'demolish', edge: victim.id });
      expect(connected(t, cityNode(t), end.id)).toBe(true);
    }
  });

  it('only two track gangs work at once', () => {
    const s = world.line();
    s.finance.cash = 100000;
    const b1 = findBranch(s);
    must(s, { type: 'buildLine', way: b1.way });
    const e = s.edges.at(-1)!;
    const p = e.pts[Math.floor(e.pts.length / 2)];
    let second = false;
    for (let a = 0; a < 8 && !second; a++) second = exec(s, { type: 'buildLine', way: [{ x: p.x, z: p.z }, { x: p.x + Math.cos(a * 0.785) * 10, z: p.z + Math.sin(a * 0.785) * 10 }] }).ok;
    expect(second).toBe(true);
    expect(s.jobs.length).toBe(2);
    const before = snapshot(s);
    const r = exec(s, { type: 'buildLine', way: [{ x: s.nodes[0].x, z: s.nodes[0].z }, { x: s.nodes[0].x + 9, z: s.nodes[0].z + 7 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/track gangs/);
    expectUnchanged(s, before);
  });
});

describe('invalid routes are rejected with nothing charged', () => {
  const rejects = (s: GameState, way: Array<{ x: number; z: number }>, why: RegExp, options?: { bridges?: boolean; tunnels?: boolean }) => {
    s.finance.cash = 500000; // money is not the reason
    const before = snapshot(s);
    const pv = previewLine(s, way, options);
    expect(pv.plan.valid).toBe(false);
    expect(pv.plan.errors.some((e) => why.test(e))).toBe(true);
    const r = exec(s, { type: 'buildLine', way, options });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(why);
    expectUnchanged(s, before);
    expect(s.jobs.length).toBe(0);
  };

  it('too steep', () => {
    const s = world.line();
    const end = lineEnd(s);
    rejects(s, [{ x: end.x, z: end.z }, { x: 100, z: 40 }], /Too steep/);
    rejects(s, [{ x: end.x, z: end.z }, { x: 96, z: 50 }], /Too steep/);
  });
  it('too sharp', () => {
    const s = newGame(SEED);
    const c = s.nodes[0];
    rejects(s, [{ x: c.x, z: c.z }, { x: c.x + 8, z: c.z }, { x: c.x + 8.5, z: c.z + 1.5 }, { x: c.x, z: c.z + 3 }], /Curve too sharp/);
  });
  it('off the map', () => {
    const s = newGame(SEED);
    const c = s.nodes[0];
    rejects(s, [{ x: c.x, z: c.z }, { x: 0.5, z: c.z }], /leaves the surveyed region/);
    rejects(s, [{ x: c.x, z: c.z }, { x: c.x, z: 140 }], /leaves the surveyed region/);
    rejects(s, [{ x: c.x, z: c.z }, { x: -20, z: -20 }], /leaves the surveyed region/);
  });
  it('across the river with bridges ruled out', () => {
    const s = newGame(SEED);
    const way = suggestRoute(s, s.nodes[0], claimRailhead(s))!;
    expect(previewLine(s, way).error).toBeNull(); // the same line is fine with a bridge
    rejects(s, way, /crosses the river/, { bridges: false });
  });
  it('degenerate lines: a single point, or a line that ends where it starts', () => {
    const s = newGame(SEED);
    s.finance.cash = 500000;
    const c = s.nodes[0];
    const before = snapshot(s);
    expect(exec(s, { type: 'buildLine', way: [] }).ok).toBe(false);
    expect(exec(s, { type: 'buildLine', way: [{ x: c.x, z: c.z }] }).ok).toBe(false);
    expect(exec(s, { type: 'buildLine', way: [{ x: c.x, z: c.z }, { x: c.x + 0.4, z: c.z }] }).ok).toBe(false);
    expect(exec(s, { type: 'buildLine', way: [{ x: c.x, z: c.z }, { x: c.x + 6, z: c.z + 5 }, { x: c.x + 0.2, z: c.z + 0.2 }] }).ok).toBe(false);
    expectUnchanged(s, before);
  });
});

describe('track upkeep and materials', () => {
  it('maintenance is charged per cell per day, bridges dearer, and only for finished track', () => {
    const b = world.building();
    runTicks(b, 5 * TPD);
    expect(b.finance.totals.operating).toBe(0);
    const s = world.line();
    const e = s.edges[0];
    const expected = (e.length - e.bridgeCells) * TRACK.maintenance + e.bridgeCells * TRACK.maintenanceBridge;
    expect(trackMaintenancePerDay(s)).toBeCloseTo(expected, 9);
    expect(dailyOpsCost(s).total).toBeCloseTo(expected, 9); // nothing else costs anything yet
    const op0 = s.finance.totals.operating, m0 = s.finance.period.by.maintenance ?? 0;
    runDays(s, 3);
    expect(s.finance.totals.operating - op0).toBeCloseTo(3 * expected, 9);
    expect((s.finance.period.by.maintenance ?? 0) - m0).toBeCloseTo(3 * expected, 9);
    s.upgrades.steel_rails = true;
    expect(trackMaintenancePerDay(s)).toBeCloseTo(expected * TRACK.steelMaintenanceFactor, 9);
  });

  it('timber and stone on hand are credited against the contract and consumed by it', () => {
    const plain = world.line(), stocked = world.line();
    stocked.materials.timber = 3; stocked.materials.stone = 2;
    const a = findBranch(plain), b = findBranch(stocked);
    expect(b.plan.timberUsed).toBeCloseTo(3, 9);
    expect(b.plan.stoneUsed).toBeCloseTo(2, 9);
    expect(b.plan.items.materialsCredit).toBe(-Math.round(3 * TRACK.timberCredit + 2 * TRACK.stoneCredit));
    expect(b.plan.total).toBe(a.plan.total + b.plan.items.materialsCredit);
    must(stocked, { type: 'buildLine', way: b.way });
    expect(stocked.materials.timber).toBeCloseTo(0, 9);
    expect(stocked.materials.stone).toBeCloseTo(b.plan.cutRock, 9);
    expect(stocked.materials.spoil).toBeCloseTo(Math.max(0, b.plan.cutSoil - b.plan.fill), 9);
  });

  it('snapping prefers a node, then a point along a line, and ignores track out of reach', () => {
    const s = world.line();
    const c = s.nodes[0];
    expect(findSnap(s, c.x + 0.5, c.z + 0.5)).toMatchObject({ kind: 'node', node: c.id });
    const p = s.edges[0].pts[50];
    expect(findSnap(s, p.x + 0.1, p.z)).toMatchObject({ kind: 'edge', edge: s.edges[0].id });
    expect(findSnap(s, 120, 120)).toBeNull();
    expect(STATION.platformCost).toBeGreaterThan(0);
  });
});

export { startLine };
