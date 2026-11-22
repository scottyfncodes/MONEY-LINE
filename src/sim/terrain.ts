import { BLAST, TERRAIN, WORLD } from './config';
import { clamp } from './rng';
import { canAfford, shortfall, spend } from './economy';
import type { GameState, Result } from './types';
import { fail, ok } from './types';
import { ci, lockCity, quant, vi } from './worldgen';

const N = WORLD.size;

/** Ground height at any point (bilinear over the vertex grid), in levels. */
export function heightAt(s: { height: Float32Array }, x: number, z: number): number {
  x = clamp(x, 0, N - 1e-4); z = clamp(z, 0, N - 1e-4);
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const h = s.height;
  const a = h[vi(ix, iz)], b = h[vi(ix + 1, iz)], c = h[vi(ix, iz + 1)], d = h[vi(ix + 1, iz + 1)];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
export function soilAt(s: { soil: Float32Array }, x: number, z: number): number {
  return s.soil[vi(clamp(Math.round(x), 0, N), clamp(Math.round(z), 0, N))];
}
export const inBounds = (x: number, z: number, margin = 0) => x >= margin && z >= margin && x <= N - margin && z <= N - margin;
export function isWater(s: { water: Uint8Array }, x: number, z: number): boolean {
  const cx = Math.floor(x), cz = Math.floor(z);
  return cx >= 0 && cz >= 0 && cx < N && cz < N && s.water[ci(cx, cz)] === 1;
}
/** True when any cell touching this vertex is river. */
function vertexWet(s: GameState, x: number, z: number): boolean {
  for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
    const cx = x + dx, cz = z + dz;
    if (cx >= 0 && cz >= 0 && cx < N && cz < N && s.water[ci(cx, cz)]) return true;
  }
  return false;
}

export function markDirty(s: GameState, x0: number, z0: number, x1: number, z1: number) {
  s.dirtyCells.push(Math.floor(x0), Math.floor(z0), Math.ceil(x1), Math.ceil(z1));
  s.rev.terrain++;
}

/** Relief (max − min height) of a square pad, used to decide whether a building site is level enough. */
export function padRelief(s: GameState, x: number, z: number, half: number): number {
  let lo = Infinity, hi = -Infinity;
  for (let vz = Math.floor(z - half); vz <= Math.ceil(z + half); vz++) for (let vx = Math.floor(x - half); vx <= Math.ceil(x + half); vx++) {
    if (vx < 0 || vz < 0 || vx > N || vz > N) return Infinity;
    const h = s.height[vi(vx, vz)];
    if (h < lo) lo = h; if (h > hi) hi = h;
  }
  return hi - lo;
}
export function padWet(s: GameState, x: number, z: number, half: number): boolean {
  for (let cz = Math.floor(z - half); cz < Math.ceil(z + half); cz++) for (let cx = Math.floor(x - half); cx < Math.ceil(x + half); cx++)
    if (isWater(s, cx + 0.5, cz + 0.5)) return true;
  return false;
}

/** Work far from the railhead costs more: everything has to be packed in. */
export function remoteFactor(s: GameState, x: number, z: number): number {
  let best = Math.hypot(x - s.city.x, z - s.city.z);
  for (const n of s.nodes) { const d = Math.hypot(x - n.x, z - n.z); if (d < best) best = d; }
  return 1 + TERRAIN.remoteSurchargeMax * clamp((best - 8) / TERRAIN.remoteDistance, 0, 1);
}

export type TerrainTool = 'excavate' | 'fill' | 'grade' | 'blast' | 'clear';
export interface TerrainOp { tool: TerrainTool; x: number; z: number; radius: number; target?: number }
export interface TerrainPlan {
  cost: number; soilCut: number; rockCut: number; fill: number; cleared: number;
  blockedByRock: boolean; blockedByLock: boolean; changed: number; remote: number;
  dv: Array<[index: number, height: number, soil: number]>; cells: number[];
}

/** Work out exactly what a brush stroke would do and cost, without doing it. */
export function planTerrainOp(s: GameState, op: TerrainOp): TerrainPlan {
  const plan: TerrainPlan = { cost: 0, soilCut: 0, rockCut: 0, fill: 0, cleared: 0, blockedByRock: false, blockedByLock: false, changed: 0, remote: 1, dv: [], cells: [] };
  const r = clamp(op.radius, 0.5, 4);
  const remote = remoteFactor(s, op.x, op.z);
  plan.remote = remote;

  if (op.tool !== 'clear') {
    for (let vz = Math.max(0, Math.floor(op.z - r)); vz <= Math.min(N, Math.ceil(op.z + r)); vz++) {
      for (let vx = Math.max(0, Math.floor(op.x - r)); vx <= Math.min(N, Math.ceil(op.x + r)); vx++) {
        const d = Math.hypot(vx - op.x, vz - op.z);
        if (d > r) continue;
        const i = vi(vx, vz);
        if (s.locked[i]) { plan.blockedByLock = true; continue; }
        if (vertexWet(s, vx, vz)) continue;
        const w = 1 - 0.65 * (d / r) * (d / r);
        const h = s.height[i], so = s.soil[i];
        let nh = h, ns = so;
        if (op.tool === 'excavate') {
          const want = TERRAIN.brushStep * w;
          const cut = Math.min(want, so, Math.max(0, h - 0.6));
          if (cut < want - 1e-3 && so <= 1e-3) plan.blockedByRock = true;
          nh = h - cut; ns = so - cut; plan.soilCut += cut;
        } else if (op.tool === 'blast') {
          const cut = Math.min(TERRAIN.brushStep * 1.6 * w, Math.max(0, h - 0.6));
          const soilPart = Math.min(cut, so);
          nh = h - cut; ns = so - soilPart; plan.soilCut += soilPart; plan.rockCut += cut - soilPart;
        } else if (op.tool === 'fill') {
          const add = TERRAIN.brushStep * w;
          nh = h + add; ns = so + add; plan.fill += add;
        } else if (op.tool === 'grade') {
          const target = op.target ?? h;
          const diff = clamp(target - h, -1, 1) * Math.min(1, w + 0.25);
          if (diff < 0) {
            const cut = Math.min(-diff, so);
            if (cut < -diff - 1e-3) plan.blockedByRock = true;
            nh = h - cut; ns = so - cut; plan.soilCut += cut;
          } else if (diff > 0) { nh = h + diff; ns = so + diff; plan.fill += diff; }
        }
        nh = quant(nh); ns = quant(Math.max(0, ns));
        if (Math.abs(nh - h) > 1e-4) { plan.dv.push([i, nh, ns]); plan.changed++; }
      }
    }
  }
  // vegetation under the work is cleared (and paid for)
  for (let cz = Math.max(0, Math.floor(op.z - r)); cz < Math.min(N, Math.ceil(op.z + r)); cz++) {
    for (let cx = Math.max(0, Math.floor(op.x - r)); cx < Math.min(N, Math.ceil(op.x + r)); cx++) {
      if (Math.hypot(cx + 0.5 - op.x, cz + 0.5 - op.z) > r) continue;
      if (s.forest[ci(cx, cz)] && (op.tool === 'clear' || plan.changed > 0)) { plan.cleared++; plan.cells.push(ci(cx, cz)); }
    }
  }
  const rockRate = TERRAIN.blastRock * (s.upgrades.giant_powder ? BLAST.rockDiscount : 1);
  const fromSpoil = Math.min(plan.fill, s.materials.spoil);
  plan.cost = Math.round((plan.soilCut * TERRAIN.excavateSoil + plan.rockCut * rockRate
    + fromSpoil * TERRAIN.fillFromSpoil + (plan.fill - fromSpoil) * TERRAIN.fillBorrowed
    + plan.cleared * TERRAIN.clearForest) * remote);
  return plan;
}

/** Do the work: charge for it, move the earth, book the materials. */
export function applyTerrainOp(s: GameState, op: TerrainOp): Result<TerrainPlan> {
  if (!inBounds(op.x, op.z)) return fail('Outside the surveyed region.');
  const plan = planTerrainOp(s, op);
  if (plan.changed === 0 && plan.cleared === 0) {
    if (plan.blockedByRock) return fail('Bedrock. Picks and shovels stop here — blast it.');
    if (plan.blockedByLock) return fail('Track, buildings and the city cannot be dug up.');
    return fail(op.tool === 'clear' ? 'Nothing to clear here.' : 'Nothing to move here.');
  }
  if (!canAfford(s, plan.cost)) return fail(shortfall(s, plan.cost));
  spend(s, plan.cost, 'terrain');
  for (const [i, h, so] of plan.dv) { s.height[i] = h; s.soil[i] = so; }
  for (const c of plan.cells) s.forest[c] = 0;
  if (plan.cells.length) s.rev.trees++;
  const m = s.materials;
  m.spoil = Math.max(0, m.spoil + plan.soilCut - Math.min(plan.fill, m.spoil));
  m.stone += plan.rockCut;
  m.timber += plan.cleared * TERRAIN.timberPerCell;
  s.stats.terrainEdits++;
  markDirty(s, op.x - op.radius - 1, op.z - op.radius - 1, op.x + op.radius + 1, op.z + op.radius + 1);
  s.events.push({ type: op.tool === 'blast' ? 'blast' : 'dig', x: op.x, z: op.z });
  return ok(plan);
}

/** Rebuild the "do not dig" mask from track and structures. */
export function recomputeLocks(s: GameState) {
  s.locked.fill(0);
  lockCity(s);
  const lockDisc = (x: number, z: number, r: number) => {
    for (let vz = Math.max(0, Math.floor(z - r)); vz <= Math.min(N, Math.ceil(z + r)); vz++)
      for (let vx = Math.max(0, Math.floor(x - r)); vx <= Math.min(N, Math.ceil(x + r)); vx++)
        if (Math.hypot(vx - x, vz - z) <= r) s.locked[vi(vx, vz)] = 1;
  };
  for (const e of s.edges) for (const p of e.pts) lockDisc(p.x, p.z, 1.05);
  for (const j of s.jobs) for (const p of j.pts) lockDisc(p.x, p.z, 1.05);
  for (const m of s.mines) lockDisc(m.x, m.z, 2.3);
  for (const m of s.mills) lockDisc(m.x, m.z, 2.3);
}
