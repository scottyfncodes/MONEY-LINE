import { TRACK } from './config';
import { smoothPath, tightestRadius } from './route';

interface XZ { x: number; z: number }

const dist = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z);

/** Walk a polyline and return points an even distance apart, keeping both ends. */
function resample(pts: XZ[], step: number): XZ[] {
  const out: XZ[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]; const b = pts[i];
    let d = dist(a, b);
    while (d > 1e-9 && carry + d >= step) {
      const t = (step - carry) / d;
      a = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      out.push(a); d = dist(a, b); carry = 0;
    }
    carry += d;
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.4 || out.length === 1) out.push(last); else out[out.length - 1] = last;
  return out;
}

/** Ramer–Douglas–Peucker: the fewest points that stay within `tol` of the line. */
function simplify(pts: XZ[], tol: number): XZ[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a], B = pts[b], dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz) || 1e-9;
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - A.x) * dz - (pts[i].z - A.z) * dx) / len;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** How sharply the line turns at an interior waypoint: 0 straight on, π a full reversal. */
function turn(a: XZ, b: XZ, c: XZ): number {
  const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - b.x, vz = c.z - b.z;
  const l = Math.hypot(ux, uz) * Math.hypot(vx, vz);
  return l < 1e-9 ? 0 : Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / l)));
}

/**
 * Ease the corners of a waypoint line until a train could take every curve. Waypoints before `fixed` belong to a line
 * the player has already drawn and stay where they are; if a corner cannot be eased it is cut.
 */
export function easeCurves(way: XZ[], fixed = 1): XZ[] {
  const w = way.map((p) => ({ x: p.x, z: p.z }));
  const want = TRACK.minRadius * 1.12;
  for (let pass = 0; pass < 40 && w.length > 2; pass++) {
    if (tightestRadius(smoothPath(w)) >= want) break;
    // the sharpest corner the stroke owns
    let worst = -1, wt = 0;
    for (let i = Math.max(1, fixed - 1); i < w.length - 1; i++) { const t = turn(w[i - 1], w[i], w[i + 1]) / Math.max(1, Math.min(dist(w[i - 1], w[i]), dist(w[i], w[i + 1]))); if (t > wt) { wt = t; worst = i; } }
    if (worst < 0) break;
    if (pass % 4 === 3 && w.length > 3 && worst >= fixed) { w.splice(worst, 1); continue; }
    for (let i = Math.max(fixed, worst - 1); i <= Math.min(w.length - 2, worst + 1); i++) {
      w[i] = { x: w[i - 1].x * 0.25 + w[i].x * 0.5 + w[i + 1].x * 0.25, z: w[i - 1].z * 0.25 + w[i].z * 0.5 + w[i + 1].z * 0.25 };
    }
  }
  return w;
}

/**
 * Turn a line drawn by hand into the waypoints of a railroad: follow the stroke, drop the tremor of the hand, and keep
 * only the points that give the line its shape, far enough apart that the curve between them can be laid.
 */
export function strokeToWay(stroke: XZ[]): XZ[] {
  const raw: XZ[] = [];
  for (const p of stroke) if (!raw.length || dist(raw[raw.length - 1], p) > 0.05) raw.push({ x: p.x, z: p.z });
  if (raw.length < 2) return raw;
  let pts = resample(raw, 0.8);
  for (let pass = 0; pass < 3; pass++) {
    const prev = pts;
    pts = prev.map((p, i) => (i === 0 || i === prev.length - 1 ? p : { x: prev[i - 1].x * 0.25 + p.x * 0.5 + prev[i + 1].x * 0.25, z: prev[i - 1].z * 0.25 + p.z * 0.5 + prev[i + 1].z * 0.25 }));
  }
  const total = pts.reduce((a, p, i) => (i ? a + dist(pts[i - 1], p) : 0), 0);
  // a long line is drawn from far away, where the hand is coarser: allow it more slack
  const key = simplify(pts, Math.max(0.6, Math.min(1.4, total / 70)));
  // waypoints closer than a curve's length fight each other: keep them apart, and never crowd the far end
  const gap = 3.2, way: XZ[] = [key[0]];
  const end = key[key.length - 1];
  for (let i = 1; i < key.length - 1; i++) if (dist(way[way.length - 1], key[i]) >= gap && dist(key[i], end) >= gap) way.push(key[i]);
  way.push(end);
  return easeCurves(way).map((p) => ({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 }));
}

/** Add a freshly drawn stroke to the end of a line already laid out. */
export function extendWay(way: XZ[], stroke: XZ[]): XZ[] {
  if (way.length < 2) return strokeToWay(way.length ? [way[0], ...stroke] : stroke);
  const add = strokeToWay([way[way.length - 1], ...stroke]);
  if (add.length < 2) return way.slice();
  // the old end was only where the hand lifted: it may give way so the join runs smooth
  return easeCurves([...way, ...add.slice(1)], way.length - 1).map((p) => ({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 }));
}
