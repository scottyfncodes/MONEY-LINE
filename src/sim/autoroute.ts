import { TRACK, WORLD, gradePct } from './config';
import { heightAt, isWater } from './terrain';
import type { GameState } from './types';
import { vi } from './worldgen';

const N = WORLD.size;

/**
 * The surveyor's proposal: a least-effort corridor between two points that keeps to gentle ground,
 * crosses water as squarely as it can, and comes back as a handful of waypoints the player can then move.
 */
export function suggestRoute(s: GameState, from: { x: number; z: number }, to: { x: number; z: number }): Array<{ x: number; z: number }> | null {
  const sx = Math.round(from.x), sz = Math.round(from.z), tx = Math.round(to.x), tz = Math.round(to.z);
  const ok = (x: number, z: number) => x >= 2 && z >= 2 && x <= N - 2 && z <= N - 2;
  if (!ok(sx, sz) || !ok(tx, tz)) return null;
  const V = N + 1;
  const g = new Float32Array(V * V).fill(Infinity);
  const came = new Int32Array(V * V).fill(-1);
  const closed = new Uint8Array(V * V);
  const start = vi(sx, sz), goal = vi(tx, tz);
  g[start] = 0;
  // binary heap of [f, index]
  const heap: number[] = [];
  const push = (f: number, i: number) => {
    heap.push(f, i);
    let c = heap.length / 2 - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (heap[p * 2] <= heap[c * 2]) break; swap(p, c); c = p; }
  };
  const swap = (a: number, b: number) => { const f = heap[a * 2], i = heap[a * 2 + 1]; heap[a * 2] = heap[b * 2]; heap[a * 2 + 1] = heap[b * 2 + 1]; heap[b * 2] = f; heap[b * 2 + 1] = i; };
  const pop = () => {
    const i = heap[1]; const n = heap.length / 2 - 1;
    heap[0] = heap[n * 2]; heap[1] = heap[n * 2 + 1]; heap.length -= 2;
    let c = 0;
    for (;;) { const l = c * 2 + 1, r = l + 1; let m = c;
      if (l < n && heap[l * 2] < heap[m * 2]) m = l; if (r < n && heap[r * 2] < heap[m * 2]) m = r;
      if (m === c) break; swap(m, c); c = m; }
    return i;
  };
  // Moves span about five cells in some fifty directions, so a line can side-hill across a slope at almost any angle and
  // the grade is judged over a length the earthworks can actually smooth.
  const moves: Array<[number, number, number]> = [];
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) { const l = Math.hypot(dx, dz); if (l >= 4.4 && l <= 6.1) moves.push([dx, dz, l]); }
  const limit = TRACK.maxGradePct * 0.72;
  push(0, start);
  while (heap.length) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % V, cz = (cur - cx) / V;
    if (Math.hypot(cx - tx, cz - tz) < 3.2) { if (cur !== goal) came[goal] = cur; break; }
    for (const [dx, dz, len] of moves) {
      const nx = cx + dx, nz = cz + dz;
      if (!ok(nx, nz)) continue;
      const ni = vi(nx, nz);
      if (closed[ni]) continue;
      const hm = heightAt(s, cx + dx / 2, cz + dz / 2);
      const whole = Math.abs(s.height[ni] - s.height[cur]) / len;
      const half = Math.max(Math.abs(hm - s.height[cur]), Math.abs(s.height[ni] - hm)) / (len / 2);
      const over = gradePct(whole * 0.6 + half * 0.4) / limit;
      let cost = len * (1 + over * over * 0.9 + (over > 1 ? Math.pow(over, 4) * 40 : 0));
      let wet = 0;
      for (let k = 1; k <= 5; k++) if (isWater(s, cx + (dx * k) / 5 - 0.01, cz + (dz * k) / 5 - 0.01)) wet++;
      cost += wet * 5;
      if (s.locked[ni] && !(Math.hypot(nx - sx, nz - sz) < 9 || Math.hypot(nx - tx, nz - tz) < 5)) cost += len * 3;
      const ng = g[cur] + cost;
      if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; push(ng + Math.hypot(tx - nx, tz - nz), ni); }
    }
  }
  if (came[goal] < 0) return null;
  const cells: Array<{ x: number; z: number }> = [];
  for (let i = goal; i >= 0; i = came[i]) { cells.push({ x: i % V, z: Math.floor(i / V) }); if (i === start) break; }
  cells.reverse();
  // thin to waypoints: keep the ends and a point every few cells, more where the corridor turns
  const way = [from];
  let last = 0;
  for (let i = 1; i < cells.length - 1; i++) {
    if (Math.hypot(cells[i].x - to.x, cells[i].z - to.z) < 5.5 || Math.hypot(cells[i].x - from.x, cells[i].z - from.z) < 5.5) continue;
    way.push(cells[i]); last = i;
  }
  way.push(to);
  // round the corners the grid search leaves behind
  for (let pass = 0; pass < 2; pass++) {
    const prev = way.map((p) => ({ x: p.x, z: p.z }));
    for (let i = 1; i < way.length - 1; i++) way[i] = { x: prev[i - 1].x * 0.25 + prev[i].x * 0.5 + prev[i + 1].x * 0.25, z: prev[i - 1].z * 0.25 + prev[i].z * 0.5 + prev[i + 1].z * 0.25 };
  }
  return way.map((p) => ({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 }));
}
