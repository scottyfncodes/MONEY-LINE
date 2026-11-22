import { BLAST, TRACK, WORLD, gradePct } from './config';
import { clamp } from './rng';
import { heightAt, inBounds, isWater, remoteFactor, soilAt } from './terrain';
import type { GameState, RoutePlan, SampleKind, TrackPoint } from './types';
import { K_BRIDGE, K_EARTH, K_GRADE, K_TUNNEL } from './types';
import { ci } from './worldgen';

export interface RouteOptions {
  /** −1 favours cuts (line sits lower), +1 favours embankments (line sits higher) */
  bias: number; tunnels: boolean; bridges: boolean;
  /** formation height fixed at the start / end (joining existing track) */
  startH?: number; endH?: number;
}
export const DEFAULT_ROUTE_OPTIONS: RouteOptions = { bias: 0, tunnels: true, bridges: true };

interface XZ { x: number; z: number }

/** Centripetal Catmull–Rom through the waypoints, resampled at an even step. */
export function smoothPath(way: XZ[], step = TRACK.sampleStep): XZ[] {
  if (way.length < 2) return way.slice();
  const P = [way[0], ...way, way[way.length - 1]];
  const dense: XZ[] = [];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const n = Math.max(2, Math.ceil(segLen / 0.2));
    const t0 = 0, t1 = t0 + Math.sqrt(Math.hypot(p1.x - p0.x, p1.z - p0.z)) || 1e-3;
    const t2 = t1 + Math.sqrt(segLen) || t1 + 1e-3, t3 = t2 + (Math.sqrt(Math.hypot(p3.x - p2.x, p3.z - p2.z)) || 1e-3);
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const A1 = mix(p0, p1, t0, t1, t), A2 = mix(p1, p2, t1, t2, t), A3 = mix(p2, p3, t2, t3, t);
      const B1 = mix(A1, A2, t0, t2, t), B2 = mix(A2, A3, t1, t3, t);
      dense.push(mix(B1, B2, t1, t2, t));
    }
  }
  dense.push(way[way.length - 1]);
  // resample evenly
  const out: XZ[] = [dense[0]];
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    let a = dense[i - 1]; const b = dense[i];
    let d = Math.hypot(b.x - a.x, b.z - a.z);
    while (carry + d >= step) {
      const t = (step - carry) / d;
      a = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      out.push(a); d = Math.hypot(b.x - a.x, b.z - a.z); carry = 0;
    }
    carry += d;
  }
  const last = dense[dense.length - 1], tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.3) out.push(last); else out[out.length - 1] = last;
  return out;
}
function mix(a: XZ, b: XZ, ta: number, tb: number, t: number): XZ {
  const d = tb - ta;
  if (Math.abs(d) < 1e-6) return a;
  const w = (t - ta) / d;
  return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
}

/** Radius of the circle through three points (cells); Infinity for a straight line. */
function radius3(a: XZ, b: XZ, c: XZ): number {
  const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
  const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return area2 < 1e-6 ? Infinity : (ab * bc * ca) / (2 * area2);
}

export function cumulative(pts: XZ[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return cum;
}

/**
 * Engineer a line through the waypoints: lay out the curve, design a grade line the locomotives can climb,
 * decide where it needs cuts, embankments, trestles and tunnels, and price every part of it.
 */
export function planRoute(s: GameState, way: XZ[], opt: RouteOptions = DEFAULT_ROUTE_OPTIONS): RoutePlan {
  const errors: string[] = [];
  const empty = (): RoutePlan => ({
    pts: [], length: 0, maxGrade: 0, minRadius: Infinity, cutSoil: 0, cutRock: 0, fill: 0, bridgeCells: 0, tunnelCells: 0, forestCells: 0,
    items: { rails: 0, labour: 0, grading: 0, explosives: 0, bridges: 0, tunnels: 0, land: 0, materialsCredit: 0 },
    total: 0, valid: false, errors, buildDays: 0, timberUsed: 0, stoneUsed: 0,
  });
  if (way.length < 2) { errors.push('Pick a start and an end.'); return empty(); }
  for (const w of way) if (!inBounds(w.x, w.z, 1.5)) { errors.push('The line leaves the surveyed region.'); return empty(); }

  const path = smoothPath(way);
  const n = path.length;
  if (n < 4) { errors.push('Too short to be worth a contract.'); return empty(); }
  const cum = cumulative(path);
  const length = cum[n - 1];
  const step = length / (n - 1);

  // curvature, measured over a two-cell chord so sampling noise does not read as a kink
  let minRadius = Infinity;
  const span = Math.max(1, Math.round(2 / step));
  for (let i = span; i < n - span; i++) minRadius = Math.min(minRadius, radius3(path[i - span], path[i], path[i + span]));
  if (minRadius < TRACK.minRadius) errors.push(`Curve too sharp (radius ${minRadius.toFixed(1)} cells, minimum ${TRACK.minRadius}). Spread the waypoints out.`);

  // ground and water under the line
  const ground = new Float64Array(n), wet = new Uint8Array(n), wl = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ground[i] = heightAt(s, path[i].x, path[i].z);
    if (isWater(s, path[i].x, path[i].z)) {
      wet[i] = 1;
      wl[i] = s.waterLevel[ci(Math.floor(path[i].x), Math.floor(path[i].z))];
    }
  }

  // design the grade line
  const f = new Float64Array(n);
  const win = Math.max(1, Math.round(2.5 / step));
  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let k = -win; k <= win; k++) { const j = clamp(i + k, 0, n - 1); sum += ground[j]; c++; }
    f[i] = sum / c + opt.bias * 0.9;
  }
  // a deck over water needs clearance, with approaches
  const minDeck = new Float64Array(n).fill(-Infinity);
  for (let i = 0; i < n; i++) if (wet[i]) minDeck[i] = wl[i] + TRACK.bridgeClearance;
  const startH = opt.startH ?? ground[0];
  const endH = opt.endH ?? ground[n - 1];
  const gmax = (TRACK.maxGradePct / gradePct(1)) * 0.985; // levels per cell
  // smooth the line while keeping decks clear of the water
  for (let pass = 0; pass < 24; pass++) {
    for (let i = 0; i < n; i++) if (f[i] < minDeck[i]) f[i] = minDeck[i];
    f[0] = startH; f[n - 1] = endH;
    for (let i = 1; i < n - 1; i++) f[i] = f[i] * 0.5 + (f[i - 1] + f[i + 1]) * 0.25;
  }
  for (let i = 0; i < n; i++) if (f[i] < minDeck[i]) f[i] = minDeck[i];
  // Enforce the ruling grade. Each sample must stay inside the cone reachable from both fixed ends; a sweep from each
  // end gives two climbable profiles, and their average is climbable too (the constraints are convex).
  const sweep = (fromStart: boolean) => {
    const o = new Float64Array(n);
    const first = fromStart ? 0 : n - 1, dir = fromStart ? 1 : -1;
    o[first] = fromStart ? startH : endH;
    for (let i = first + dir; i >= 0 && i < n; i += dir) {
      const dPrev = Math.abs(cum[i] - cum[i - dir]) * gmax;
      const dFar = Math.abs(cum[fromStart ? n - 1 : 0] - cum[i]) * gmax;
      const far = fromStart ? endH : startH;
      const lo = Math.max(o[i - dir] - dPrev, far - dFar), hi = Math.min(o[i - dir] + dPrev, far + dFar);
      o[i] = lo > hi ? (lo + hi) / 2 : clamp(f[i], lo, hi);
    }
    return o;
  };
  const fa = sweep(true), fb = sweep(false);
  for (let i = 0; i < n; i++) f[i] = (fa[i] + fb[i]) / 2;
  f[0] = startH; f[n - 1] = endH;
  let maxGrade = 0;
  for (let i = 1; i < n; i++) maxGrade = Math.max(maxGrade, Math.abs(gradePct((f[i] - f[i - 1]) / (cum[i] - cum[i - 1]))));
  if (maxGrade > TRACK.maxGradePct + 0.06) {
    errors.push(`Too steep: ${maxGrade.toFixed(1)}% against a ${TRACK.maxGradePct}% limit. Lengthen the line with waypoints to gain height gradually.`);
  }
  for (let i = 0; i < n; i++) if (wet[i] && f[i] < wl[i] + TRACK.bridgeClearance - 0.2) {
    errors.push('The grade line dips into the river. Move the crossing or raise the approach.'); break;
  }

  // classify each sample and take off quantities
  const pts: TrackPoint[] = [];
  let cutSoil = 0, cutRock = 0, fill = 0, bridgeCells = 0, tunnelCells = 0, bridgeHeight = 0;
  const forestHit = new Set<number>();
  const kinds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const delta = f[i] - ground[i];
    let k: SampleKind = K_GRADE;
    if (wet[i]) k = K_BRIDGE;
    else if (delta > TRACK.bridgeThreshold && opt.bridges) k = K_BRIDGE;
    else if (delta < -TRACK.tunnelThreshold && opt.tunnels) k = K_TUNNEL;
    else if (Math.abs(delta) > 0.12) k = K_EARTH;
    kinds[i] = k;
  }
  // structures shorter than two samples are not worth building: fold them into earthworks
  for (const K of [K_BRIDGE, K_TUNNEL]) {
    let i = 0;
    while (i < n) {
      if (kinds[i] !== K) { i++; continue; }
      let j = i; let anyWet = false;
      while (j < n && kinds[j] === K) { if (wet[j]) anyWet = true; j++; }
      if (j - i < 3 && !anyWet) for (let q = i; q < j; q++) kinds[q] = K_EARTH;
      i = j;
    }
  }
  if (!opt.bridges) for (let i = 0; i < n; i++) if (wet[i]) { errors.push('The line crosses the river: a bridge is required there.'); break; }

  for (let i = 0; i < n; i++) {
    const seg = i === 0 ? (cum[1] - cum[0]) / 2 : i === n - 1 ? (cum[i] - cum[i - 1]) / 2 : (cum[i + 1] - cum[i - 1]) / 2;
    const delta = f[i] - ground[i];
    const k = kinds[i] as SampleKind;
    if (k === K_BRIDGE) { bridgeCells += seg; bridgeHeight += seg * Math.max(1, f[i] - (wet[i] ? wl[i] - 0.5 : ground[i])); }
    else if (k === K_TUNNEL) tunnelCells += seg;
    else if (Math.abs(delta) > 0.02) {
      const d = Math.abs(delta);
      const vol = d * (TRACK.formationWidth + d * TRACK.sideSlope) * seg;
      if (delta < 0) {
        const so = soilAt(s, path[i].x, path[i].z);
        const soilShare = d <= 1e-6 ? 1 : Math.min(1, so / d);
        cutSoil += vol * soilShare; cutRock += vol * (1 - soilShare);
      } else fill += vol;
    }
    if (k !== K_TUNNEL) {
      const cx = Math.floor(path[i].x), cz = Math.floor(path[i].z);
      if (s.forest[ci(cx, cz)]) forestHit.add(ci(cx, cz));
    }
    pts.push({ x: path[i].x, z: path[i].z, h: Math.round(f[i] * 1000) / 1000, k });
  }

  const remote = remoteFactor(s, path[Math.floor(n / 2)].x, path[Math.floor(n / 2)].z);
  const rockRate = TRACK.cutRock * (s.upgrades.giant_powder ? BLAST.rockDiscount : 1);
  const plain = length - bridgeCells - tunnelCells;
  const timberUsed = Math.min(s.materials.timber, length * TRACK.timberPerCell);
  const stoneUsed = Math.min(s.materials.stone, plain * TRACK.stonePerCell);
  const spoilUsed = Math.min(s.materials.spoil + cutSoil, fill); // cut from this job balances its own fill first
  const items = {
    rails: Math.round(length * TRACK.railsAndTies),
    labour: Math.round(length * TRACK.labour * remote),
    grading: Math.round((cutSoil * TRACK.cutSoil + spoilUsed * TRACK.fill * 0.6 + (fill - spoilUsed) * TRACK.fill * 1.9) * remote),
    explosives: Math.round(cutRock * rockRate * remote),
    bridges: Math.round(bridgeCells * TRACK.bridgeBase + bridgeHeight * TRACK.bridgePerLevel),
    tunnels: Math.round(tunnelCells * TRACK.tunnel * (s.upgrades.giant_powder ? 0.8 : 1)),
    land: Math.round(length * TRACK.landAccess + forestHit.size * 14),
    materialsCredit: -Math.round(timberUsed * TRACK.timberCredit + stoneUsed * TRACK.stoneCredit),
  };
  const total = Math.max(0, items.rails + items.labour + items.grading + items.explosives + items.bridges + items.tunnels + items.land + items.materialsCredit);
  const rate = s.upgrades.track_gangs ? TRACK.buildCellsPerDayFast : TRACK.buildCellsPerDay;
  const buildDays = plain / rate + bridgeCells / (rate * 0.45) + tunnelCells / (rate * 0.22);
  return {
    pts, length, maxGrade, minRadius, cutSoil, cutRock, fill, bridgeCells, tunnelCells, forestCells: forestHit.size,
    items, total, valid: errors.length === 0, errors, buildDays, timberUsed, stoneUsed,
  };
}

export const WORLD_SIZE = WORLD.size;
