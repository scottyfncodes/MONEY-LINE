import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Vertical exaggeration: scene units per elevation level. */
export const VS = 0.25;

/** The world's colours. Warm, natural, a little faded: a model railway under a low sun. */
export const PAL = {
  table: 0x1f4d3a,
  grassLow: 0xa3b56c, grassHigh: 0x86a05e, forestFloor: 0x6a8a52, meadow: 0xc9c27c,
  rock: 0x8d8a84, rockDark: 0x6f6c68, rockPale: 0xb9b6ae, snow: 0xe9e7df,
  earth: 0xa57f52, earthDark: 0x86623d, riverbed: 0x5e6b58, water: 0x4c8d96, waterDeep: 0x3a7480,
  strata1: 0x8a6a48, strata2: 0x6e5237, strata3: 0x574131,
  pine: 0x4a7550, pineLight: 0x66935e, trunk: 0x5b4330,
  ballast: 0x8e8478, tie: 0x4f3b2a, iron: 0x5d5a57, steel: 0xb8bcc0, timber: 0x8a6a45, timberDark: 0x6b4f33,
  brass: 0xc79a3c, copper: 0xb5683a, black: 0x26262a, boiler: 0x2f3b36, cab: 0x8e3a2b, wagon: 0x5e4a3a, wagonIron: 0x3c3b3d,
  ore: 0x9a8a62, gold: 0xe0b23a, conc: 0xd9c27a, coal: 0x2a2826, silver: 0xc8ced2,
  brick: 0x9c5a44, brickDark: 0x7f4636, roof: 0x5d595c, roofRed: 0x9b5544, plaster: 0xd9c9a8, canvas: 0xe4dcc6, stone: 0xa39c8e,
  window: 0xf2d489, flag: 0xb4352b, stake: 0xf1ead6,
};

const tmpColor = new THREE.Color();

/** Collects coloured primitives and bakes them into one flat-shaded mesh (one draw call per model). */
export class Kit {
  private parts: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  add(g: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): this {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    this.q.setFromEuler(this.e.set(rx, ry, rz));
    geo.applyMatrix4(this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz)));
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    tmpColor.set(color);
    for (let i = 0; i < n; i++) { col[i * 3] = tmpColor.r; col[i * 3 + 1] = tmpColor.g; col[i * 3 + 2] = tmpColor.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.deleteAttribute('uv');
    this.parts.push(geo);
    return this;
  }
  box(color: number, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y + h / 2, z, rx, ry, rz);
  }
  /** A cylinder standing on y. */
  cyl(color: number, r: number, h: number, x = 0, y = 0, z = 0, seg = 8, rTop = r) {
    return this.add(new THREE.CylinderGeometry(rTop, r, h, seg), color, x, y + h / 2, z);
  }
  /** A cylinder lying along local x. */
  barrel(color: number, r: number, len: number, x = 0, y = 0, z = 0, seg = 10, ry = 0) {
    return this.add(new THREE.CylinderGeometry(r, r, len, seg), color, x, y, z, 0, ry, Math.PI / 2);
  }
  /** A gabled roof: ridge along local x. */
  roof(color: number, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0) {
    const s = new THREE.Shape();
    s.moveTo(-d / 2, 0); s.lineTo(d / 2, 0); s.lineTo(0, h); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
    g.translate(0, 0, -w / 2); g.rotateY(Math.PI / 2);
    return this.add(g, color, x, y, z, 0, ry, 0);
  }
  cone(color: number, r: number, h: number, x = 0, y = 0, z = 0, seg = 6) {
    return this.add(new THREE.ConeGeometry(r, h, seg), color, x, y + h / 2, z);
  }
  build(material: THREE.Material, shadows = true): THREE.Mesh {
    const geo = mergeGeometries(this.parts, false)!;
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = shadows; mesh.receiveShadow = shadows;
    this.parts = [];
    return mesh;
  }
  geometry(): THREE.BufferGeometry {
    const geo = mergeGeometries(this.parts, false)!;
    geo.computeVertexNormals();
    this.parts = [];
    return geo;
  }
}

export const MAT = {
  solid: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  glow: new THREE.MeshBasicMaterial({ color: PAL.window }),
};

/** Ore stockpile: a cone whose size follows the tonnage. */
export function makePile(color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.42, 7), new THREE.MeshLambertMaterial({ color, flatShading: true }));
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
export function setPile(m: THREE.Mesh, fraction: number, maxScale = 1.5) {
  const f = Math.max(0, Math.min(1, fraction));
  m.visible = f > 0.01;
  const sc = (0.35 + 0.65 * Math.cbrt(f)) * maxScale;
  m.scale.set(sc, sc * (0.6 + 0.4 * f), sc);
}

/** A small tank engine (0-4-0T) or a larger tender engine (2-8-0). Built along +x, wheels on y=0. */
export function makeLoco(kind: string): THREE.Group {
  const g = new THREE.Group();
  const k = new Kit();
  const big = kind === 'consolidation';
  const L = big ? 1.5 : 1.02, W = 0.34;
  const hw = 0.085, bw = big ? 0.15 : 0.14;                 // wheel radius, boiler radius
  // frame and running gear
  k.box(PAL.black, L, 0.06, W * 0.86, 0, hw * 1.25, 0);
  const wheels = big ? [-0.42, -0.2, 0.02, 0.24] : [-0.16, 0.16];
  for (const wx of wheels) for (const side of [-1, 1]) {
    k.add(new THREE.CylinderGeometry(hw, hw, 0.04, 10), PAL.iron, wx, hw, side * W * 0.42, Math.PI / 2, 0, 0);
    k.add(new THREE.CylinderGeometry(hw * 0.45, hw * 0.45, 0.05, 6), PAL.cab, wx, hw, side * W * 0.43, Math.PI / 2, 0, 0);
  }
  if (big) for (const side of [-1, 1]) k.add(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 8), PAL.iron, 0.52, 0.05, side * W * 0.42, Math.PI / 2, 0, 0);
  for (const side of [-1, 1]) k.box(PAL.steel, big ? 0.72 : 0.36, 0.022, 0.02, big ? -0.09 : 0, hw - 0.01, side * W * 0.5);
  // boiler, smokebox, domes, stack
  const by = hw * 1.25 + 0.06 + bw;
  const bl = big ? 0.86 : 0.5, bx = big ? 0.16 : 0.12;
  k.barrel(PAL.boiler, bw, bl, bx, by, 0, 12);
  k.barrel(PAL.black, bw * 1.04, 0.13, bx + bl / 2 + 0.04, by, 0, 12);
  k.barrel(PAL.brass, bw * 1.045, 0.025, bx - bl * 0.18, by, 0, 12);
  k.barrel(PAL.brass, bw * 1.045, 0.025, bx + bl * 0.2, by, 0, 12);
  k.cyl(PAL.black, 0.045, 0.2, bx + bl / 2 + 0.04, by + bw * 0.7, 0, 8, 0.07);
  k.cyl(PAL.brass, 0.06, 0.11, bx + bl * 0.02, by + bw * 0.75, 0, 8, 0.045);
  k.cyl(PAL.copper, 0.045, 0.08, bx - bl * 0.26, by + bw * 0.8, 0, 8, 0.035);
  if (!big) for (const side of [-1, 1]) k.box(PAL.boiler, 0.42, 0.17, 0.07, bx, by - 0.1, side * (bw + 0.02));
  // cylinders and pilot
  for (const side of [-1, 1]) k.barrel(PAL.black, 0.05, 0.16, bx + bl / 2 - 0.02, hw + 0.02, side * W * 0.5, 8);
  k.add(new THREE.BoxGeometry(0.16, 0.1, W * 0.9), PAL.cab, L / 2 + 0.02, 0.07, 0, 0, 0, -0.5);
  // cab
  const cx = big ? -0.48 : -0.3;
  k.box(PAL.cab, 0.3, 0.3, W, cx, hw * 1.25 + 0.06, 0);
  k.box(PAL.roof, 0.38, 0.03, W * 1.12, cx, hw * 1.25 + 0.36, 0);
  for (const side of [-1, 1]) k.box(PAL.window, 0.12, 0.09, 0.012, cx + 0.03, hw * 1.25 + 0.2, side * W * 0.505);
  if (!big) k.box(PAL.black, 0.14, 0.2, W * 0.9, cx - 0.2, hw * 1.25 + 0.06, 0); // coal bunker
  g.add(k.build(MAT.solid));
  if (big) {
    const t = new Kit();
    t.box(PAL.black, 0.56, 0.05, W * 0.86, 0, 0.1, 0);
    t.box(PAL.boiler, 0.54, 0.2, W * 0.92, 0, 0.15, 0);
    t.box(PAL.coal, 0.3, 0.06, W * 0.7, 0.08, 0.35, 0);
    for (const wx of [-0.17, 0.17]) for (const side of [-1, 1]) t.add(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 8), PAL.iron, wx, 0.055, side * W * 0.42, Math.PI / 2, 0, 0);
    const tender = t.build(MAT.solid);
    tender.position.x = -1.06;
    g.add(tender);
  }
  g.userData.stack = new THREE.Vector3(bx + bl / 2 + 0.04, by + bw * 0.7 + 0.22, 0);
  g.userData.length = big ? 2.2 : 1.1;
  return g;
}

/** An ore hopper with a load that rises and falls. */
export function makeWagon(): THREE.Group {
  const g = new THREE.Group();
  const k = new Kit();
  const W = 0.32, L = 0.72;
  k.box(PAL.wagonIron, L, 0.04, W * 0.8, 0, 0.1, 0);
  for (const wx of [-0.22, 0.22]) for (const side of [-1, 1]) k.add(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 8), PAL.iron, wx, 0.055, side * W * 0.42, Math.PI / 2, 0, 0);
  // sloped hopper body: a box with slanted ends
  k.box(PAL.wagon, L * 0.92, 0.2, 0.025, 0, 0.14, W * 0.47);
  k.box(PAL.wagon, L * 0.92, 0.2, 0.025, 0, 0.14, -W * 0.47);
  k.add(new THREE.BoxGeometry(0.025, 0.24, W * 0.94), PAL.wagon, L * 0.42, 0.24, 0, 0, 0, -0.32);
  k.add(new THREE.BoxGeometry(0.025, 0.24, W * 0.94), PAL.wagon, -L * 0.42, 0.24, 0, 0, 0, 0.32);
  for (const x of [-0.2, 0, 0.2]) for (const side of [-1, 1]) k.box(PAL.wagonIron, 0.022, 0.22, 0.012, x, 0.13, side * W * 0.49);
  g.add(k.build(MAT.solid));
  const load = new THREE.Mesh(new THREE.BoxGeometry(L * 0.78, 0.16, W * 0.84), new THREE.MeshLambertMaterial({ color: PAL.ore, flatShading: true }));
  const pos = load.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) { pos.setX(i, pos.getX(i) * 0.55); pos.setZ(i, pos.getZ(i) * 0.5); }
  load.geometry.computeVertexNormals();
  load.castShadow = true;
  g.add(load);
  g.userData.load = load;
  return g;
}
export function setWagonLoad(w: THREE.Group, fraction: number, color: number) {
  const load = w.userData.load as THREE.Mesh;
  load.visible = fraction > 0.02;
  load.position.y = 0.13 + 0.17 * Math.min(1, fraction);
  (load.material as THREE.MeshLambertMaterial).color.setHex(color);
}

/** Prosperity: a terminal, warehouses, a bank, a roundhouse and a few smoking chimneys. Local origin at the city centre. */
export function makeCity(assay: boolean): { group: THREE.Group; stacks: THREE.Vector3[] } {
  const group = new THREE.Group();
  const k = new Kit();
  const house = (x: number, z: number, w: number, d: number, h: number, wall: number, roof: number, ry = 0) => {
    k.box(wall, w, h, d, x, 0, z, ry);
    k.roof(roof, w * 1.06, Math.min(w, d) * 0.42, d * 1.1, x, h, z, ry);
  };
  // freight terminal along the yard track (the node sits at +2, −1.5)
  k.box(PAL.stone, 4.6, 0.09, 0.7, 0.6, 0, -0.75);                         // platform
  house(0.4, -0.1, 3.2, 0.9, 0.62, PAL.brick, PAL.roof);
  k.box(PAL.plaster, 0.5, 0.95, 0.5, -0.4, 0, -0.1); k.cone(PAL.roofRed, 0.42, 0.4, -0.4, 0.95, -0.1, 4); // clock tower
  k.box(PAL.timber, 4.4, 0.04, 0.5, 0.6, 0.62, -0.78);                     // canopy
  for (let i = 0; i < 6; i++) k.box(PAL.timberDark, 0.05, 0.56, 0.05, -1.4 + i * 0.8, 0.08, -1.0);
  // warehouses and the market hall
  house(3.3, 0.9, 1.5, 1.0, 0.6, PAL.timber, PAL.roof, 0.1);
  house(3.5, -3.0, 1.7, 1.1, 0.66, PAL.brickDark, PAL.roofRed, -0.05);
  house(-2.6, 1.2, 1.3, 1.9, 0.72, PAL.plaster, PAL.roofRed, 0.3);
  // the bank: stone, flat roof, columns
  k.box(PAL.stone, 1.3, 0.8, 1.0, -2.9, 0, -2.0); k.box(PAL.rockPale, 1.42, 0.08, 1.12, -2.9, 0.8, -2.0);
  for (let i = 0; i < 4; i++) k.cyl(PAL.rockPale, 0.05, 0.7, -3.42 + i * 0.35, 0.06, -1.44, 6);
  // roundhouse / locomotive workshop
  k.cyl(PAL.brick, 1.0, 0.55, 0.4, 0, 2.6, 10); k.cone(PAL.roof, 1.12, 0.36, 0.4, 0.55, 2.6, 10);
  k.box(PAL.black, 0.5, 0.42, 0.06, 0.4, 0, 1.62);
  // houses
  const spots: Array<[number, number, number]> = [[-1.0, 3.3, 0.4], [-2.4, 3.6, -0.2], [2.4, 3.4, 0.2], [-4.2, 0.2, 0.1], [-4.4, -2.6, -0.3], [-1.2, -3.6, 0.2], [0.8, -4.0, -0.1], [4.6, -0.8, 0.5], [-3.6, 2.6, 0.6], [1.9, -4.4, 0.3]];
  spots.forEach(([x, z, r], i) => house(x, z, 0.75 + (i % 3) * 0.12, 0.62, 0.42 + (i % 2) * 0.08, i % 2 ? PAL.plaster : PAL.timber, i % 3 ? PAL.roof : PAL.roofRed, r));
  // smelter / industrial buyer with chimneys
  k.box(PAL.brickDark, 1.6, 0.7, 1.1, 2.4, 0, -1.4 + 3.6);
  const stacks = [new THREE.Vector3(2.9, 1.75, 2.5), new THREE.Vector3(-0.2, 1.3, 2.9)];
  k.cyl(PAL.brick, 0.13, 1.7, 2.9, 0, 2.5, 8, 0.09);
  k.cyl(PAL.brick, 0.1, 0.75, -0.2, 0.55, 2.9, 8, 0.07);
  if (assay) { house(4.4, -2.0 + 3.2, 0.9, 0.7, 0.5, PAL.plaster, PAL.roof, 0.2); k.box(PAL.brass, 0.4, 0.12, 0.03, 4.4, 0.5, 1.6); }
  group.add(k.build(MAT.solid));
  // lit windows
  const wk = new THREE.Group();
  const wm = new THREE.BoxGeometry(0.12, 0.14, 0.02);
  for (let i = 0; i < 6; i++) { const w = new THREE.Mesh(wm, MAT.glow); w.position.set(-0.8 + i * 0.5, 0.34, 0.36); wk.add(w); }
  group.add(wk);
  return { group, stacks };
}

export function makeMine(tier: number, exhausted: boolean): { group: THREE.Group; stack: THREE.Vector3 | null } {
  const group = new THREE.Group();
  const k = new Kit();
  // timbered adit
  k.box(PAL.timberDark, 0.1, 0.5, 0.1, -0.9, 0, -0.28); k.box(PAL.timberDark, 0.1, 0.5, 0.1, -0.9, 0, 0.28);
  k.box(PAL.timberDark, 0.14, 0.1, 0.76, -0.9, 0.5, 0); k.box(PAL.black, 0.06, 0.46, 0.48, -0.94, 0, 0);
  k.box(PAL.earthDark, 0.9, 0.5, 1.2, -1.4, 0, 0);
  // ore-cart track out of the adit to the tipple
  k.box(PAL.iron, 1.5, 0.02, 0.05, -0.1, 0.01, -0.08); k.box(PAL.iron, 1.5, 0.02, 0.05, -0.1, 0.01, 0.08);
  k.box(PAL.wagon, 0.2, 0.12, 0.16, 0.1, 0.05, 0);
  // camp: bunkhouse, cook shack, equipment shed, tents
  k.box(PAL.timber, 0.9, 0.34, 0.5, 0.5, 0, -1.05); k.roof(PAL.roof, 0.96, 0.2, 0.56, 0.5, 0.34, -1.05);
  k.box(PAL.timber, 0.5, 0.3, 0.42, -0.5, 0, -1.1); k.roof(PAL.roofRed, 0.54, 0.16, 0.48, -0.5, 0.3, -1.1);
  for (const [x, z] of [[1.0, 0.9], [0.5, 1.15], [1.15, 0.35]]) k.roof(PAL.canvas, 0.34, 0.22, 0.3, x, 0, z, 0.4);
  k.box(PAL.timberDark, 0.5, 0.26, 0.36, -0.3, 0, 1.0); k.box(PAL.roof, 0.56, 0.03, 0.42, -0.3, 0.26, 1.0);
  let stack: THREE.Vector3 | null = null;
  if (tier >= 1) {
    // headframe, hoist house and boiler stack
    for (const [x, z] of [[-0.25, -0.2], [0.05, -0.2], [-0.25, 0.2], [0.05, 0.2]]) k.box(PAL.timberDark, 0.05, 1.15, 0.05, x - 0.3, 0, z);
    k.box(PAL.timberDark, 0.42, 0.05, 0.5, -0.4, 1.15, 0); k.add(new THREE.CylinderGeometry(0.14, 0.14, 0.04, 10), PAL.iron, -0.4, 1.28, 0, Math.PI / 2, 0, 0);
    k.add(new THREE.BoxGeometry(0.04, 1.25, 0.04), PAL.timberDark, 0.12, 0.6, 0, 0, 0, -0.5);
    k.box(PAL.brick, 0.6, 0.4, 0.5, 0.75, 0, -0.25); k.roof(PAL.roof, 0.66, 0.2, 0.56, 0.75, 0.4, -0.25);
    k.cyl(PAL.iron, 0.05, 0.9, 1.0, 0.4, -0.25, 8);
    stack = new THREE.Vector3(1.0, 1.32, -0.25);
  }
  if (exhausted) k.box(PAL.timber, 0.5, 0.3, 0.04, -0.98, 0.1, 0);       // boarded up
  group.add(k.build(MAT.solid));
  return { group, stack };
}

export function makeMill(tier: number): { group: THREE.Group; stack: THREE.Vector3 } {
  const group = new THREE.Group();
  const k = new Kit();
  // stepped mill building: ore in at the top, concentrate out at the bottom
  const steps = tier >= 1 ? 4 : 3;
  for (let i = 0; i < steps; i++) {
    const x = -0.75 + i * 0.52, h = 1.1 - i * 0.22;
    k.box(i % 2 ? PAL.timber : PAL.timberDark, 0.56, h, 1.1, x, 0, 0);
    k.add(new THREE.BoxGeometry(0.62, 0.04, 1.2), PAL.roof, x, h + 0.05, 0, 0, 0, -0.32);
  }
  k.add(new THREE.BoxGeometry(1.2, 0.05, 0.22), PAL.timberDark, -1.5, 0.82, 0, 0, 0, 0.35);  // ore trestle in
  k.box(PAL.timberDark, 0.05, 0.6, 0.05, -1.7, 0, 0.1); k.box(PAL.timberDark, 0.05, 0.6, 0.05, -1.7, 0, -0.1);
  k.box(PAL.brick, 0.5, 0.42, 0.5, -0.2, 0, 0.85);                         // boiler house
  const sh = tier >= 1 ? 1.75 : 1.35;
  k.cyl(PAL.brick, 0.1, sh, -0.2, 0, 0.85, 8, 0.07);
  if (tier >= 1) { k.box(PAL.timber, 0.9, 0.6, 0.55, 0.2, 0, -0.9); k.roof(PAL.roof, 0.96, 0.24, 0.62, 0.2, 0.6, -0.9); }
  for (let i = 0; i < 3; i++) k.box(PAL.window, 0.012, 0.12, 0.12, -1.035, 0.55, -0.32 + i * 0.32);
  group.add(k.build(MAT.solid));
  return { group, stack: new THREE.Vector3(-0.2, sh + 0.05, 0.85) };
}

export function makePlatform(): THREE.Group {
  const g = new THREE.Group();
  const k = new Kit();
  k.box(PAL.timber, 2.4, 0.1, 0.42, 0, 0, 0.55);
  for (let i = 0; i < 5; i++) k.box(PAL.timberDark, 0.06, 0.1, 0.44, -1.1 + i * 0.55, -0.02, 0.55);
  // loading bin and chute over the track
  for (const x of [-0.3, 0.3]) for (const z of [0.4, 0.75]) k.box(PAL.timberDark, 0.05, 0.62, 0.05, x, 0.1, z);
  k.box(PAL.timber, 0.72, 0.3, 0.46, 0, 0.62, 0.57);
  k.add(new THREE.BoxGeometry(0.3, 0.03, 0.42), PAL.iron, 0, 0.6, 0.28, 0.55, 0, 0);
  k.box(PAL.plaster, 0.4, 0.26, 0.3, 0.9, 0.1, 0.6); k.roof(PAL.roofRed, 0.46, 0.12, 0.36, 0.9, 0.36, 0.6);
  k.box(PAL.stake, 0.5, 0.1, 0.02, -0.85, 0.45, 0.72); k.box(PAL.timberDark, 0.03, 0.45, 0.03, -0.85, 0.1, 0.72);
  g.add(k.build(MAT.solid));
  return g;
}

/** The gang at the railhead: a flat car of rails, a tool van and a handful of men. */
export function makeRailhead(): THREE.Group {
  const g = new THREE.Group();
  const k = new Kit();
  k.box(PAL.wagonIron, 0.7, 0.05, 0.28, -0.5, 0.1, 0);
  for (let i = 0; i < 3; i++) k.box(PAL.steel, 0.66, 0.02, 0.03, -0.5, 0.15 + i * 0.022, -0.08 + i * 0.07);
  k.box(PAL.timberDark, 0.3, 0.07, 0.26, -0.5, 0.2, 0);
  for (const [x, z, c] of [[0.2, 0.2, PAL.cab], [0.35, -0.22, PAL.boiler], [0.05, -0.1, PAL.timber], [0.5, 0.05, PAL.plaster]] as Array<[number, number, number]>) {
    k.cyl(c, 0.035, 0.13, x, 0, z, 5); k.add(new THREE.SphereGeometry(0.03, 5, 4), PAL.canvas, x, 0.16, z);
  }
  k.roof(PAL.canvas, 0.3, 0.2, 0.28, 0.1, 0, 0.6, 0.3);
  // the work train: a small contractor's engine behind the rail car, and a derrick swinging rails forward
  k.box(PAL.black, 0.6, 0.05, 0.26, -1.3, 0.1, 0);
  k.barrel(PAL.boiler, 0.11, 0.38, -1.22, 0.3, 0, 10);
  k.box(PAL.cab, 0.2, 0.3, 0.28, -1.52, 0.15, 0); k.box(PAL.roof, 0.26, 0.03, 0.32, -1.52, 0.45, 0);
  k.cyl(PAL.black, 0.04, 0.22, -1.08, 0.4, 0, 8, 0.06);
  for (const wx of [-1.45, -1.15]) for (const side of [-1, 1]) k.add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 8), PAL.iron, wx, 0.07, side * 0.13, Math.PI / 2, 0, 0);
  k.box(PAL.timberDark, 0.06, 0.95, 0.06, -0.2, 0.1, 0);
  k.add(new THREE.BoxGeometry(1.0, 0.05, 0.05), PAL.timberDark, 0.2, 0.95, 0, 0, 0, 0.32);
  k.add(new THREE.BoxGeometry(0.02, 0.5, 0.02), PAL.iron, 0.62, 0.82, 0);
  k.box(PAL.steel, 0.5, 0.02, 0.03, 0.62, 0.52, 0);
  k.add(new THREE.BoxGeometry(0.03, 0.9, 0.03), PAL.flag, 0.9, 0.45, 0.32); k.add(new THREE.BoxGeometry(0.3, 0.18, 0.02), PAL.flag, 1.05, 0.82, 0.32);
  g.add(k.build(MAT.solid));
  g.userData.stack = new THREE.Vector3(-1.08, 0.66, 0);
  return g;
}

/** A claim marker: four corner stakes and a flag. */
export function makeClaimMarker(color: number, owned: boolean): THREE.Group {
  const g = new THREE.Group();
  const k = new Kit();
  k.cyl(PAL.timberDark, 0.035, 1.5, 0, 0, 0, 5);
  k.add(new THREE.BoxGeometry(0.52, 0.3, 0.02), owned ? color : PAL.stake, 0.28, 1.32, 0);
  if (owned) k.add(new THREE.BoxGeometry(0.2, 0.1, 0.03), PAL.stake, 0.28, 1.32, 0);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(PAL.stake, 0.03, 0.3, x * 0.7, 0, z * 0.7, 4);
  g.add(k.build(MAT.solid));
  return g;
}
