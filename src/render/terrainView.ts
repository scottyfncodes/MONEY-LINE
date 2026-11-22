import * as THREE from 'three';
import { WORLD } from '../sim/config';
import { hash2, noise2 } from '../sim/rng';
import type { GameState } from '../sim/types';
import { ci, riverSurface, riverX, vi } from '../sim/worldgen';
import { PAL, VS } from './kit';

const N = WORLD.size;
const CH = 16;                  // cells per chunk side
const CN = N / CH;

const c = (hex: number) => new THREE.Color(hex);
const C = {
  grassLow: c(PAL.grassLow), grassHigh: c(PAL.grassHigh), forest: c(PAL.forestFloor), meadow: c(PAL.meadow),
  rock: c(PAL.rock), rockDark: c(PAL.rockDark), rockPale: c(PAL.rockPale), snow: c(PAL.snow),
  earth: c(PAL.earth), earthDark: c(PAL.earthDark), bed: c(PAL.riverbed),
};
const tmp = new THREE.Color();

/** Colour of one terrain triangle: what the ground is made of, how high it is, and whether people have dug it. */
function faceColor(s: GameState, cx: number, cz: number, i0: number, i1: number, i2: number, out: THREE.Color) {
  const h = (s.height[i0] + s.height[i1] + s.height[i2]) / 3;
  const soil = (s.soil[i0] + s.soil[i1] + s.soil[i2]) / 3;
  const worked = Math.max(Math.abs(s.height[i0] - s.baseHeight[i0]), Math.abs(s.height[i1] - s.baseHeight[i1]), Math.abs(s.height[i2] - s.baseHeight[i2]));
  const n = hash2(cx, cz, s.seed + 9) - 0.5;
  const cell = ci(cx, cz);
  if (s.water[cell]) { out.copy(C.bed); return; }
  const lo = Math.min(s.height[i0], s.height[i1], s.height[i2]), hi = Math.max(s.height[i0], s.height[i1], s.height[i2]);
  const steep = hi - lo;
  if (soil < 0.22) {
    // bare rock: paler with height, fresh-cut rock darker
    out.copy(C.rock).lerp(C.rockPale, THREE.MathUtils.clamp((h - 18) / 16, 0, 1));
    if (h > 36) out.lerp(C.snow, THREE.MathUtils.clamp((h - 36) / 6, 0, 0.85));
    if (steep > 1.3) out.lerp(C.rockDark, 0.35);
    if (worked > 0.15) out.lerp(C.rockDark, 0.3);
  } else if (worked > 0.15) {
    out.copy(C.earth).lerp(C.earthDark, steep > 0.6 ? 0.45 : 0.1);
  } else {
    out.copy(C.grassLow).lerp(C.grassHigh, THREE.MathUtils.clamp((h - 4) / 14, 0, 1));
    out.lerp(C.meadow, THREE.MathUtils.clamp((noise2(cx * 0.11, cz * 0.11, s.seed + 3) - 0.45) * 2.2, 0, 0.55) * THREE.MathUtils.clamp((9 - h) / 5, 0, 1));
    if (s.forest[cell]) out.lerp(C.forest, 0.7);
    if (steep > 1.5) out.lerp(C.rock, THREE.MathUtils.clamp((steep - 1.5) / 1.5, 0, 0.7));
    if (soil < 0.7) out.lerp(C.rock, 0.35);
  }
  out.offsetHSL(0, 0, n * 0.014);
}

export class TerrainView {
  group = new THREE.Group();
  private chunks: THREE.Mesh[] = [];
  private material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private trees: THREE.InstancedMesh | null = null;
  private treeRev = -1;
  water: THREE.Mesh | null = null;

  constructor(private s: GameState) {
    for (let cz = 0; cz < CN; cz++) for (let cx = 0; cx < CN; cx++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CH * CH * 18), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(CH * CH * 18), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(CH * CH * 18), 3));
      const m = new THREE.Mesh(geo, this.material);
      m.receiveShadow = true; m.castShadow = true;
      this.chunks.push(m); this.group.add(m);
      this.buildChunk(cx, cz);
    }
    this.group.add(this.makeSkirt());
    this.buildWater();
    this.syncTrees();
  }

  setState(s: GameState) { this.s = s; for (let cz = 0; cz < CN; cz++) for (let cx = 0; cx < CN; cx++) this.buildChunk(cx, cz); this.treeRev = -1; this.syncTrees(); }

  private buildChunk(chx: number, chz: number) {
    const s = this.s;
    const mesh = this.chunks[chz * CN + chx];
    const pos = mesh.geometry.attributes.position.array as Float32Array;
    const col = mesh.geometry.attributes.color.array as Float32Array;
    const nor = mesh.geometry.attributes.normal.array as Float32Array;
    let o = 0;
    const put = (x: number, z: number, i: number, color: THREE.Color, nx: number, ny: number, nz: number) => {
      pos[o] = x; pos[o + 1] = s.height[i] * VS; pos[o + 2] = z;
      col[o] = color.r; col[o + 1] = color.g; col[o + 2] = color.b;
      nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz; o += 3;
    };
    for (let z = chz * CH; z < (chz + 1) * CH; z++) for (let x = chx * CH; x < (chx + 1) * CH; x++) {
      const a = vi(x, z), b = vi(x + 1, z), d = vi(x, z + 1), e = vi(x + 1, z + 1);
      // split along the diagonal that keeps the surface smoother
      const flip = Math.abs(s.height[a] - s.height[e]) > Math.abs(s.height[b] - s.height[d]);
      const tris: Array<[number, number, number, number, number, number, number, number, number]> = flip
        ? [[x, z, a, x, z + 1, d, x + 1, z, b], [x + 1, z, b, x, z + 1, d, x + 1, z + 1, e]]
        : [[x, z, a, x, z + 1, d, x + 1, z + 1, e], [x, z, a, x + 1, z + 1, e, x + 1, z, b]];
      for (const t of tris) {
        faceColor(s, x, z, t[2], t[5], t[8], tmp);
        const ux = t[3] - t[0], uy = (s.height[t[5]] - s.height[t[2]]) * VS, uz = t[4] - t[1];
        const vx = t[6] - t[0], vy = (s.height[t[8]] - s.height[t[2]]) * VS, vz = t[7] - t[1];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        put(t[0], t[1], t[2], tmp, nx, ny, nz); put(t[3], t[4], t[5], tmp, nx, ny, nz); put(t[6], t[7], t[8], tmp, nx, ny, nz);
      }
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.color.needsUpdate = true;
    mesh.geometry.attributes.normal.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  }

  /** Rebuild only the chunks the simulation says were touched. */
  applyDirty() {
    const d = this.s.dirtyCells;
    if (!d.length) return;
    const touched = new Set<number>();
    for (let i = 0; i < d.length; i += 4) {
      const x0 = Math.max(0, Math.floor((d[i] - 1) / CH)), z0 = Math.max(0, Math.floor((d[i + 1] - 1) / CH));
      const x1 = Math.min(CN - 1, Math.floor((d[i + 2] + 1) / CH)), z1 = Math.min(CN - 1, Math.floor((d[i + 3] + 1) / CH));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) touched.add(z * CN + x);
    }
    d.length = 0;
    for (const k of touched) this.buildChunk(k % CN, Math.floor(k / CN));
  }

  /** The cut sides of the diorama: strata down to the table. */
  private makeSkirt(): THREE.Mesh {
    const s = this.s;
    const pos: number[] = [], col: number[] = [];
    const base = -3.2;
    const bands = [c(PAL.strata1), c(PAL.strata2), c(PAL.strata3)];
    const quad = (x0: number, z0: number, h0: number, x1: number, z1: number, h1: number) => {
      const top0 = h0 * VS, top1 = h1 * VS;
      const levels = [1, 0.55, 0.2, 0];
      for (let b = 0; b < 3; b++) {
        const ya0 = base + (top0 - base) * levels[b], yb0 = base + (top0 - base) * levels[b + 1];
        const ya1 = base + (top1 - base) * levels[b], yb1 = base + (top1 - base) * levels[b + 1];
        pos.push(x0, ya0, z0, x0, yb0, z0, x1, ya1, z1, x1, ya1, z1, x0, yb0, z0, x1, yb1, z1);
        for (let k = 0; k < 6; k++) col.push(bands[b].r, bands[b].g, bands[b].b);
      }
    };
    for (let i = 0; i < N; i++) {
      quad(i, N, s.height[vi(i, N)], i + 1, N, s.height[vi(i + 1, N)]);
      quad(i + 1, 0, s.height[vi(i + 1, 0)], i, 0, s.height[vi(i, 0)]);
      quad(N, i + 1, s.height[vi(N, i + 1)], N, i, s.height[vi(N, i)]);
      quad(0, i, s.height[vi(0, i)], 0, i + 1, s.height[vi(0, i + 1)]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  }

  /** The river: one smooth ribbon along its course, wide enough to run under both banks. */
  private buildWater() {
    const s = this.s;
    const pos: number[] = [];
    const half = 3.4, step = 0.5;
    for (let z = -0.5; z < N + 0.5; z += step) {
      const x0 = riverX(z, s.seed), x1 = riverX(z + step, s.seed);
      const y0 = riverSurface(z) * VS, y1 = riverSurface(z + step) * VS;
      pos.push(x0 - half, y0, z, x0 + half, y0, z, x1 + half, y1, z + step, x0 - half, y0, z, x1 + half, y1, z + step, x1 - half, y1, z + step);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhongMaterial({ color: PAL.water, specular: 0x9fc4c0, shininess: 60, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    this.water = new THREE.Mesh(geo, mat);
    this.water.receiveShadow = true;
    this.group.add(this.water);
  }

  /** Instanced conifers on every forested cell. Rebuilt when trees are cleared. */
  syncTrees() {
    const s = this.s;
    if (this.treeRev === s.rev.trees) return;
    this.treeRev = s.rev.trees;
    if (!this.trees) {
      const lower = new THREE.ConeGeometry(0.34, 0.62, 6); lower.translate(0, 0.42, 0);
      const upper = new THREE.ConeGeometry(0.23, 0.52, 6); upper.translate(0, 0.82, 0);
      const trunk = new THREE.CylinderGeometry(0.045, 0.06, 0.2, 5); trunk.translate(0, 0.1, 0);
      const paint = (g: THREE.BufferGeometry, hex: number) => {
        const k = c(hex); const n = g.attributes.position.count; const a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { a[i * 3] = k.r; a[i * 3 + 1] = k.g; a[i * 3 + 2] = k.b; }
        g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g.toNonIndexed();
      };
      const parts = [paint(lower, PAL.pine), paint(upper, PAL.pineLight), paint(trunk, PAL.trunk)];
      const total = parts.reduce((a, g) => a + g.attributes.position.count, 0);
      const P = new Float32Array(total * 3), K = new Float32Array(total * 3);
      let o = 0;
      for (const g of parts) { P.set(g.attributes.position.array as Float32Array, o); K.set(g.attributes.color.array as Float32Array, o); o += g.attributes.position.count * 3; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(K, 3));
      geo.computeVertexNormals();
      this.trees = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), 9000);
      this.trees.castShadow = true; this.trees.receiveShadow = false;
      this.trees.frustumCulled = false;
      this.group.add(this.trees);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    let n = 0;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const f = s.forest[ci(x, z)];
      if (!f) continue;
      const count = f >= 3 ? 2 : 1;
      for (let k = 0; k < count && n < 9000; k++) {
        const rx = hash2(x * 3 + k, z, 11), rz = hash2(x, z * 3 + k, 12), rs = hash2(x + k * 7, z, 13);
        const px = x + 0.15 + rx * 0.7, pz = z + 0.15 + rz * 0.7;
        const fx = px - x, fz = pz - z;
        const h = s.height[vi(x, z)] * (1 - fx) * (1 - fz) + s.height[vi(x + 1, z)] * fx * (1 - fz) + s.height[vi(x, z + 1)] * (1 - fx) * fz + s.height[vi(x + 1, z + 1)] * fx * fz;
        const size = 0.75 + rs * 0.6 + (f - 1) * 0.08;
        p.set(px, h * VS - 0.02, pz); q.setFromAxisAngle(up, rs * 6.28); sc.set(size, size * (0.9 + rx * 0.35), size);
        this.trees.setMatrixAt(n, m.compose(p, q, sc));
        this.trees.setColorAt(n, tint.setHSL(0.25 + (rz - 0.5) * 0.2, 0.25, 0.88 + (rx - 0.5) * 0.2));
        n++;
      }
    }
    this.trees.count = n;
    this.trees.instanceMatrix.needsUpdate = true;
    if (this.trees.instanceColor) this.trees.instanceColor.needsUpdate = true;
  }
}
