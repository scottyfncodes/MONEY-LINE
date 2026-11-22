import { describe, expect, it } from 'vitest';
import { TRACK } from '../src/sim/config';
import { previewLine } from '../src/sim/rail';
import { smoothPath, tightestRadius } from '../src/sim/route';
import { newGame } from '../src/sim/sim';
import { extendWay, strokeToWay } from '../src/sim/stroke';
import { SEED, goldOf } from './helpers';

/** A hand-drawn stroke: points every third of a cell along a polyline, with a tremor. */
function draw(corners: Array<{ x: number; z: number }>, tremor = 0.35, seed = 7) {
  let r = seed; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1], b = corners[i], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.33);
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n + rnd() * tremor, z: a.z + ((b.z - a.z) * k) / n + rnd() * tremor });
  }
  out.push(corners[corners.length - 1]);
  return out;
}
const offLine = (way: Array<{ x: number; z: number }>, stroke: Array<{ x: number; z: number }>) =>
  Math.max(...smoothPath(way).map((p) => Math.min(...stroke.map((q) => Math.hypot(p.x - q.x, p.z - q.z)))));

describe('a line drawn by hand becomes a railroad', () => {
  it('keeps the ends exactly, follows the stroke and needs only a handful of waypoints', () => {
    const stroke = draw([{ x: 26, z: 99.5 }, { x: 48, z: 90 }, { x: 62, z: 84 }, { x: 86, z: 66 }]);
    stroke[0] = { x: 26, z: 99.5 };
    const way = strokeToWay(stroke);
    expect(way[0]).toEqual({ x: 26, z: 99.5 });
    expect(way[way.length - 1]).toEqual({ x: 86, z: 66 });
    expect(way.length).toBeGreaterThanOrEqual(2);
    expect(way.length).toBeLessThanOrEqual(12);
    expect(offLine(way, stroke)).toBeLessThan(2.2);
    for (let i = 1; i < way.length - 1; i++) expect(Math.hypot(way[i].x - way[i - 1].x, way[i].z - way[i - 1].z)).toBeGreaterThan(2.5);
  });

  it('a shaky hand never produces a curve too sharp for a train', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const stroke = draw([{ x: 26, z: 99.5 }, { x: 40, z: 92 + (seed % 5) }, { x: 55, z: 88 - (seed % 7) }, { x: 70, z: 80 }, { x: 86, z: 66 }], 0.2 + (seed % 6) * 0.15, seed);
      const way = strokeToWay(stroke);
      expect(tightestRadius(smoothPath(way)), `seed ${seed}`).toBeGreaterThanOrEqual(TRACK.minRadius);
    }
  });

  it('a right-angle corner and a hairpin are eased into curves that can be laid', () => {
    const corner = strokeToWay(draw([{ x: 30, z: 100 }, { x: 50, z: 100 }, { x: 50, z: 80 }], 0.1));
    expect(tightestRadius(smoothPath(corner))).toBeGreaterThanOrEqual(TRACK.minRadius);
    const hairpin = strokeToWay(draw([{ x: 30, z: 100 }, { x: 50, z: 100 }, { x: 31, z: 97 }], 0.1));
    expect(tightestRadius(smoothPath(hairpin))).toBeGreaterThanOrEqual(TRACK.minRadius);
    expect(hairpin[hairpin.length - 1]).toEqual({ x: 31, z: 97 });
  });

  it('a tap or a scribble on the spot is not a line', () => {
    expect(strokeToWay([{ x: 30, z: 30 }]).length).toBe(1);
    expect(strokeToWay([]).length).toBe(0);
    const dot = strokeToWay(draw([{ x: 30, z: 30 }, { x: 30.4, z: 30.2 }], 0.05));
    expect(dot.length).toBe(2);
  });

  it('drawing on from the end of a line keeps what was already laid out', () => {
    const first = strokeToWay(draw([{ x: 26, z: 99.5 }, { x: 45, z: 91 }, { x: 60, z: 85 }]));
    const more = extendWay(first, draw([{ x: 61, z: 84 }, { x: 74, z: 77 }, { x: 86, z: 66 }]));
    expect(more.length).toBeGreaterThan(first.length);
    expect(more.slice(0, first.length - 1)).toEqual(first.slice(0, first.length - 1));
    expect(more[more.length - 1]).toEqual({ x: 86, z: 66 });
    expect(tightestRadius(smoothPath(more))).toBeGreaterThanOrEqual(TRACK.minRadius);
    // doubling straight back from the end is eased or cut, never left as a kink
    const back = extendWay(first, draw([{ x: 59, z: 86 }, { x: 44, z: 96 }], 0.1));
    expect(tightestRadius(smoothPath(back))).toBeGreaterThanOrEqual(TRACK.minRadius);
  });

  it('a line drawn from the Prosperity terminal to the Eureka claim is a contract the engineer will price', () => {
    const s = newGame(SEED), g = goldOf(s), n = s.nodes[0];
    const stroke = draw([{ x: n.x, z: n.z }, { x: 47, z: 89 }, { x: 66, z: 83 }, { x: g.x - 3, z: g.z + 4 }], 0.3);
    stroke[0] = { x: n.x, z: n.z };
    const pv = previewLine(s, strokeToWay(stroke));
    expect(pv.error).toBeNull();
    expect(pv.plan.total).toBeGreaterThan(s.finance.cash);          // the bank is needed
    expect(pv.plan.total).toBeLessThan(s.finance.cash + 60000);     // and the bank is enough
    expect(pv.plan.maxGrade).toBeLessThanOrEqual(TRACK.maxGradePct + 0.06);
  });
});
