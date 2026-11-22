import { STATION, TRACK, WORLD, gradePct } from './config';
import { canAfford, earn, note, shortfall, spend } from './economy';
import { DEFAULT_ROUTE_OPTIONS, cumulative, planRoute, type RouteOptions } from './route';
import { markDirty, recomputeLocks } from './terrain';
import type { ConstructionJob, GameState, RailEdge, RailNode, Result, RoutePlan, Station, TrackPoint } from './types';
import { K_BRIDGE, K_TUNNEL, fail, ok } from './types';
import { ci, quant, vi } from './worldgen';

const N = WORLD.size;
export const nodeById = (s: GameState, id: number) => s.nodes.find((n) => n.id === id);
export const edgeById = (s: GameState, id: number) => s.edges.find((e) => e.id === id);
export const stationById = (s: GameState, id: number) => s.stations.find((t) => t.id === id);

export type Snap =
  | { kind: 'node'; node: number; x: number; z: number; h: number }
  | { kind: 'edge'; edge: number; index: number; x: number; z: number; h: number };

/** Nearest piece of built track within reach of a point: an existing node first, otherwise a spot along a line. */
export function findSnap(s: GameState, x: number, z: number, radius: number = TRACK.snapRadius): Snap | null {
  let best: Snap | null = null, bd = radius;
  for (const n of s.nodes) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d <= bd) { bd = d; best = { kind: 'node', node: n.id, x: n.x, z: n.z, h: n.h }; }
  }
  if (best) return best;
  for (const e of s.edges) {
    for (let i = 2; i < e.pts.length - 2; i++) {
      const p = e.pts[i];
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd && p.k !== K_BRIDGE && p.k !== K_TUNNEL) { bd = d; best = { kind: 'edge', edge: e.id, index: i, x: p.x, z: p.z, h: p.h }; }
    }
  }
  return best;
}

function makeEdge(s: GameState, a: number, b: number, pts: TrackPoint[]): RailEdge {
  const cum = cumulative(pts);
  let maxGrade = 0, bridgeCells = 0, tunnelCells = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = cum[i] - cum[i - 1];
    if (d > 1e-6) maxGrade = Math.max(maxGrade, Math.abs(gradePct((pts[i].h - pts[i - 1].h) / d)));
    if (pts[i].k === K_BRIDGE) bridgeCells += d;
    if (pts[i].k === K_TUNNEL) tunnelCells += d;
  }
  return { id: s.nextId++, a, b, pts, length: cum[cum.length - 1], maxGrade, bridgeCells, tunnelCells, builtDay: s.day };
}

/** Turn a point along a line into a junction node. Trains already running keep their own copy of the path. */
export function splitEdge(s: GameState, edgeId: number, index: number): number {
  const e = edgeById(s, edgeId)!;
  if (index <= 0) return e.a;
  if (index >= e.pts.length - 1) return e.b;
  const p = e.pts[index];
  const node: RailNode = { id: s.nextId++, x: p.x, z: p.z, h: p.h };
  s.nodes.push(node);
  const e1 = makeEdge(s, e.a, node.id, e.pts.slice(0, index + 1));
  const e2 = makeEdge(s, node.id, e.b, e.pts.slice(index));
  e1.builtDay = e2.builtDay = e.builtDay;
  s.edges.splice(s.edges.indexOf(e), 1, e1, e2);
  for (const t of s.trains) if (t.trip) {
    const k = t.trip.edges.indexOf(edgeId);
    if (k >= 0) t.trip.edges.splice(k, 1, e1.id, e2.id);
  }
  s.rev.track++;
  return node.id;
}

export interface LinePreview { plan: RoutePlan; start: Snap | null; end: Snap | null; error: string | null }

/** Price a proposed line through the player's waypoints, joined to existing track where it touches it. */
export function previewLine(s: GameState, way: Array<{ x: number; z: number }>, opt: Partial<RouteOptions> = {}): LinePreview {
  const o: RouteOptions = { ...DEFAULT_ROUTE_OPTIONS, ...opt };
  const start = way.length ? findSnap(s, way[0].x, way[0].z) : null;
  const end = way.length > 1 ? findSnap(s, way[way.length - 1].x, way[way.length - 1].z) : null;
  const w = way.map((p) => ({ x: p.x, z: p.z }));
  if (start) { w[0] = { x: start.x, z: start.z }; o.startH = start.h; }
  const sameSpot = !!start && !!end && Math.hypot(start.x - end.x, start.z - end.z) < 1e-6;
  if (end && !sameSpot) { w[w.length - 1] = { x: end.x, z: end.z }; o.endH = end.h; }
  const plan = planRoute(s, w, o);
  let error: string | null = null;
  if (!start) error = 'Start the line on existing track or at the city terminal.';
  else if (sameSpot) error = 'The line ends where it starts.';
  else if (!plan.valid) error = plan.errors[0];
  else if (plan.pts.some((p) => [...s.mines, ...s.mills].some((m) => Math.hypot(m.x - p.x, m.z - p.z) < 2.4))) error = 'The line runs through a works. Route it around the buildings.';
  else if (s.jobs.length >= 2) error = 'Both track gangs are already at work. Wait for a line to finish.';
  return { plan, start, end: sameSpot ? null : end, error };
}

/** Sign the construction contract: the money leaves now, the crews build the line day by day. */
export function startConstruction(s: GameState, way: Array<{ x: number; z: number }>, opt: Partial<RouteOptions> = {}): Result<ConstructionJob> {
  const pv = previewLine(s, way, opt);
  if (pv.error) return fail(pv.error);
  const plan = pv.plan;
  if (!canAfford(s, plan.total)) return fail(shortfall(s, plan.total));
  spend(s, plan.total, 'construction');
  const m = s.materials;
  m.timber -= plan.timberUsed; m.stone -= plan.stoneUsed;
  m.stone += plan.cutRock;
  m.spoil = Math.max(0, m.spoil + plan.cutSoil - plan.fill);
  const start = pv.start!;
  const startNode = start.kind === 'node' ? start.node : splitEdge(s, start.edge, start.index);
  const job: ConstructionJob = {
    id: s.nextId++, pts: plan.pts, length: plan.length, progress: 0, total: plan.total, startNode,
    endSnap: pv.end ? { x: pv.end.x, z: pv.end.z } : null, cum: cumulative(plan.pts), applied: -1,
  };
  s.jobs.push(job);
  recomputeLocks(s);
  s.rev.track++;
  note(s, 'info', `Contract signed: ${(plan.length * 0.0186).toFixed(1)} miles of line for $${plan.total.toLocaleString('en-US')}. Crews expect ${Math.ceil(plan.buildDays)} days.`);
  return ok(job);
}

/** Shape the ground to the formation at one track point: this is what leaves cuts and embankments in the landscape. */
function earthworkAt(s: GameState, p: TrackPoint) {
  const cx = Math.floor(p.x), cz = Math.floor(p.z);
  if (p.k !== K_TUNNEL) {
    for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || z < 0 || x >= N || z >= N) continue;
      if (Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) < 1.25 && s.forest[ci(x, z)]) { s.forest[ci(x, z)] = 0; s.rev.trees++; }
    }
  }
  if (p.k === K_BRIDGE || p.k === K_TUNNEL) return;
  const R = 2.6, flat = 0.78, run = 1.5;
  for (let vz = Math.max(0, Math.floor(p.z - R)); vz <= Math.min(N, Math.ceil(p.z + R)); vz++) {
    for (let vx = Math.max(0, Math.floor(p.x - R)); vx <= Math.min(N, Math.ceil(p.x + R)); vx++) {
      const d = Math.hypot(vx - p.x, vz - p.z);
      if (d > R) continue;
      let wet = false;
      for (let dz = -1; dz <= 0 && !wet; dz++) for (let dx = -1; dx <= 0; dx++) {
        const x = vx + dx, z = vz + dz;
        if (x >= 0 && z >= 0 && x < N && z < N && s.water[ci(x, z)]) { wet = true; break; }
      }
      if (wet) continue;
      const i = vi(vx, vz);
      const h = s.height[i];
      const slack = d <= flat ? 0 : (d - flat) * run;
      const nh = quant(Math.min(Math.max(h, p.h - slack), p.h + slack));
      if (Math.abs(nh - h) < 1e-4) continue;
      s.soil[i] = quant(Math.max(0, s.soil[i] + (nh - h)));
      s.height[i] = nh;
    }
  }
  markDirty(s, p.x - R - 1, p.z - R - 1, p.x + R + 1, p.z + R + 1);
}

export function isClaimReached(s: GameState): boolean {
  const gold = s.deposits.find((d) => d.owned && d.resource === 'gold');
  if (!gold) return false;
  return networkNodes(s, s.city.node).some((id) => { const n = nodeById(s, id)!; return Math.hypot(n.x - gold.x, n.z - gold.z) <= 7; });
}

/** Advance every railhead. Called once per tick. */
export function tickConstruction(s: GameState, dtDays: number) {
  if (!s.jobs.length) return;
  const base = s.upgrades.track_gangs ? TRACK.buildCellsPerDayFast : TRACK.buildCellsPerDay;
  for (const job of s.jobs.slice()) {
    // the kind of ground at the railhead sets the pace
    let idx = job.applied + 1;
    if (idx >= job.pts.length) idx = job.pts.length - 1;
    const k = job.pts[idx].k;
    const rate = base * (k === K_BRIDGE ? 0.45 : k === K_TUNNEL ? 0.22 : 1);
    job.progress = Math.min(job.length, job.progress + rate * dtDays);
    while (job.applied + 1 < job.pts.length && job.cum[job.applied + 1] <= job.progress + 1e-6) {
      job.applied++;
      earthworkAt(s, job.pts[job.applied]);
    }
    s.rev.track++;
    if (job.progress >= job.length - 1e-6) finishJob(s, job);
  }
}

function finishJob(s: GameState, job: ConstructionJob) {
  s.jobs.splice(s.jobs.indexOf(job), 1);
  const last = job.pts[job.pts.length - 1];
  let endNode: number;
  const snap = job.endSnap ? findSnap(s, job.endSnap.x, job.endSnap.z, 0.6) : null;
  if (snap) endNode = snap.kind === 'node' ? snap.node : splitEdge(s, snap.edge, snap.index);
  else { const n: RailNode = { id: s.nextId++, x: last.x, z: last.z, h: last.h }; s.nodes.push(n); endNode = n.id; }
  const edge = makeEdge(s, job.startNode, endNode, job.pts);
  s.edges.push(edge);
  recomputeLocks(s);
  s.rev.track++;
  s.events.push({ type: 'built', what: 'track', x: last.x, z: last.z });
  note(s, 'good', `The railhead is through: ${(edge.length * 0.0186).toFixed(1)} miles of new line open to traffic.`);
  if (!s.stats.reachedClaim && isClaimReached(s)) {
    s.stats.reachedClaim = true;
    note(s, 'good', 'Steel has reached the Eureka claim.');
  }
}

/** All node ids reachable from a node over built track. */
export function networkNodes(s: GameState, from: number): number[] {
  const seen = new Set<number>([from]);
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of s.edges) {
      const o = e.a === n ? e.b : e.b === n ? e.a : -1;
      if (o >= 0 && !seen.has(o)) { seen.add(o); stack.push(o); }
    }
  }
  return [...seen];
}
export const connected = (s: GameState, a: number, b: number) => networkNodes(s, a).includes(b);

/** Distance from a point to the nearest track connected to the city. */
export function distToNetwork(s: GameState, x: number, z: number): number {
  const reach = new Set(networkNodes(s, s.city.node));
  let best = Infinity;
  for (const e of s.edges) {
    if (!reach.has(e.a)) continue;
    for (let i = 0; i < e.pts.length; i += 2) { const d = Math.hypot(e.pts[i].x - x, e.pts[i].z - z); if (d < best) best = d; }
  }
  return best;
}

export interface PathStep { edge: number; forward: boolean }
/** Shortest path over built track (Dijkstra). `avoid` holds edge ids already reserved by other trains. */
export function findPath(s: GameState, from: number, to: number, avoid?: Set<number>): { steps: PathStep[]; length: number } | null {
  if (from === to) return { steps: [], length: 0 };
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, { node: number; step: PathStep }>();
  const open = new Set<number>([from]);
  while (open.size) {
    let u = -1, best = Infinity;
    for (const n of open) { const d = dist.get(n)!; if (d < best) { best = d; u = n; } }
    open.delete(u);
    if (u === to) break;
    for (const e of s.edges) {
      if (avoid?.has(e.id)) continue;
      const fwd = e.a === u, back = e.b === u;
      if (!fwd && !back) continue;
      const v = fwd ? e.b : e.a;
      const nd = best + e.length;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { node: u, step: { edge: e.id, forward: fwd } }); open.add(v); }
    }
  }
  if (!prev.has(to)) return null;
  const steps: PathStep[] = [];
  for (let n = to; n !== from;) { const p = prev.get(n)!; steps.unshift(p.step); n = p.node; }
  return { steps, length: dist.get(to)! };
}

/** The physical polyline a train will follow for a path. */
export function pathPoints(s: GameState, steps: PathStep[]): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const st of steps) {
    const e = edgeById(s, st.edge)!;
    const pts = st.forward ? e.pts : e.pts.slice().reverse();
    for (let i = out.length ? 1 : 0; i < pts.length; i++) out.push(pts[i]);
  }
  return out;
}

export function reservedEdges(s: GameState, except?: number): Set<number> {
  const r = new Set<number>();
  for (const t of s.trains) if (t.trip && t.id !== except) for (const e of t.trip.edges) r.add(e);
  return r;
}

export function demolishEdge(s: GameState, edgeId: number): Result {
  const e = edgeById(s, edgeId);
  if (!e) return fail('No track there.');
  if (reservedEdges(s).has(edgeId)) return fail('A train is running on that line. Wait for it to clear.');
  s.edges.splice(s.edges.indexOf(e), 1);
  const used = new Set<number>(); for (const x of s.edges) { used.add(x.a); used.add(x.b); }
  for (const j of s.jobs) used.add(j.startNode);
  s.nodes = s.nodes.filter((n) => used.has(n.id) || n.id === s.city.node || s.stations.some((t) => t.node === n.id));
  const refund = Math.round(e.length * TRACK.railsAndTies * TRACK.demolishRefund);
  earn(s, refund, 'asset_sale');
  s.finance.assetValue = Math.max(0, s.finance.assetValue - e.length * (TRACK.railsAndTies + TRACK.labour) * 0.6);
  recomputeLocks(s);
  s.rev.track++;
  note(s, 'info', `Line lifted: $${refund.toLocaleString('en-US')} recovered for the rails. The cuts and embankments remain.`);
  return ok();
}

/** A freight platform on the line, serving every mine and mill within reach. */
export function buildPlatform(s: GameState, x: number, z: number): Result<Station> {
  const snap = findSnap(s, x, z, 2.2);
  if (!snap) return fail('A loading platform has to stand on finished track.');
  for (const t of s.stations) if (Math.hypot(t.x - snap.x, t.z - snap.z) < 5) return fail(`${t.name} already serves this spot.`);
  // every check comes before the line is cut for the junction: a refused platform must leave the track as it was
  const onNetwork = snap.kind === 'node' ? snap.node : edgeById(s, snap.edge)!.a;
  if (!connected(s, onNetwork, s.city.node)) return fail('That track is not connected to the city.');
  if (!canAfford(s, STATION.platformCost)) return fail(shortfall(s, STATION.platformCost));
  const node = snap.kind === 'node' ? snap.node : splitEdge(s, snap.edge, snap.index);
  spend(s, STATION.platformCost, 'construction');
  let name = `Milepost ${Math.round(Math.hypot(snap.x - s.city.x, snap.z - s.city.z) * 0.0186 * 10) / 10}`;
  let bd = 12;
  for (const d of s.deposits) { const dd = Math.hypot(d.x - snap.x, d.z - snap.z); if (d.discovered && dd < bd) { bd = dd; name = `${d.name.split(' ')[0]} Siding`; } }
  const st: Station = { id: s.nextId++, node, x: snap.x, z: snap.z, name, shipRaw: true, city: false };
  s.stations.push(st);
  s.stats.platformsBuilt++;
  s.rev.structures++; s.rev.track++;
  s.events.push({ type: 'built', what: 'platform', x: st.x, z: st.z });
  note(s, 'good', `${name} is open for freight.`);
  // an idle engine with nowhere to go takes the new service
  for (const t of s.trains) if (t.dest == null) { t.dest = st.id; break; }
  return ok(st);
}

export function trackMaintenancePerDay(s: GameState): number {
  let c = 0;
  for (const e of s.edges) {
    const plain = e.length - e.bridgeCells - e.tunnelCells;
    c += plain * TRACK.maintenance + e.bridgeCells * TRACK.maintenanceBridge + e.tunnelCells * TRACK.maintenanceTunnel;
  }
  return c * (s.upgrades.steel_rails ? TRACK.steelMaintenanceFactor : 1);
}
export const totalTrackLength = (s: GameState) => s.edges.reduce((a, e) => a + e.length, 0);
export const MILES_PER_CELL = 0.0186;
