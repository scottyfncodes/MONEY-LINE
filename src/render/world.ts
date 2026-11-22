import * as THREE from 'three';
import { COMMODITIES, MILL, MINE, WORLD, type CommodityId } from '../sim/config';
import { millTier, mineTier } from '../sim/facilities';
import { findPath, pathPoints } from '../sim/rail';
import { cumulative } from '../sim/route';
import { heightAt } from '../sim/terrain';
import { cargoTons, tripPose } from '../sim/trains';
import type { GameState, TrackPoint, Train, Trip } from '../sim/types';
import { K_BRIDGE, K_TUNNEL } from '../sim/types';
import { ci } from '../sim/worldgen';
import { Kit, MAT, PAL, VS, makeCity, makeClaimMarker, makeLoco, makeMill, makeMine, makePile, makePlatform, makeRailhead, makeWagon, setPile, setWagonLoad } from './kit';
import { TerrainView } from './terrainView';

const N = WORLD.size;
const WAGON_LEN = 0.8;

export interface Preview {
  route?: { pts: TrackPoint[]; valid: boolean; way: Array<{ x: number; z: number }> } | null;
  brush?: { x: number; z: number; radius: number; color: number } | null;
  ghost?: { x: number; z: number; ok: boolean; half: number } | null;
  ring?: { x: number; z: number; r: number; color: number } | null;
  select?: { x: number; z: number; r: number } | null;
}

interface TrainView { group: THREE.Group; loco: THREE.Group; wagons: THREE.Group[]; kind: string; lastTrip: Trip | null; lastInbound: boolean; pos: THREE.Vector3; smoke: number }

/** Soft round particles for smoke, steam and dust. */
class Puffs {
  points: THREE.Points;
  private max = 700; private n = 0; private frames = 32;
  private pos = new Float32Array(this.max * 3); private vel = new Float32Array(this.max * 3);
  private age = new Float32Array(this.max); private life = new Float32Array(this.max);
  private size = new Float32Array(this.max); private grow = new Float32Array(this.max);
  private shade = new Float32Array(this.max * 3); private alpha = new Float32Array(this.max);
  private aSize = new Float32Array(this.max); private aAlpha = new Float32Array(this.max); private aFrame = new Float32Array(this.max);
  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.shade, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    geo.setAttribute('aFrame', new THREE.BufferAttribute(this.aFrame, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { uScale: { value: 600 }, uMap: { value: null }, uHasMap: { value: 0 }, uCols: { value: 6 } },
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute float aFrame; varying float vA; varying vec3 vC; varying float vF; uniform float uScale;
        void main(){ vA=aAlpha; vC=color; vF=aFrame; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*uScale/(-mv.z); gl_Position=projectionMatrix*mv; }`,
      // the puff's shape comes from the produced smoke flipbook (6×6 frames); a soft disc stands in until it loads
      fragmentShader: `varying float vA; varying vec3 vC; varying float vF; uniform sampler2D uMap; uniform float uHasMap; uniform float uCols;
        void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d)*2.0; float disc=smoothstep(1.0,0.25,r);
          float f=floor(vF+0.5); vec2 cell=vec2(mod(f,uCols),floor(f/uCols)); vec2 uv=(cell+0.5+d*0.6)/uCols;
          float shape=mix(disc, max(texture2D(uMap,uv).a, disc*0.55), uHasMap);
          float a=shape*vA; if(a<0.01) discard;
          float lit=0.82+0.18*smoothstep(0.6,-0.6,d.y); gl_FragColor=vec4(vC*lit,a); }`,
    });
    new THREE.TextureLoader().load('/assets/fx/smoke_flipbook.png', (tex) => { tex.flipY = false; tex.needsUpdate = true; mat.uniforms.uMap.value = tex; mat.uniforms.uHasMap.value = 1; }, undefined, () => { /* the disc remains */ });
    // grid and frame count come from the flipbook's own metadata
    fetch('/assets/fx/smoke_flipbook.json').then((r) => r.json()).then((m: { cols?: number }) => { if (m.cols) mat.uniforms.uCols.value = m.cols; }).catch(() => { /* defaults stand */ });
    fetch('/assets/fx/smoke_atlas.json').then((r) => r.json()).then((a: { frames?: Record<string, unknown> }) => { if (a.frames) this.frames = Object.keys(a.frames).length; }).catch(() => { /* defaults stand */ });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    geo.setDrawRange(0, 0);
  }
  emit(x: number, y: number, z: number, o: { vx?: number; vy?: number; vz?: number; life?: number; size?: number; grow?: number; shade?: number; tint?: number; alpha?: number }) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = o.vx ?? 0; this.vel[i * 3 + 1] = o.vy ?? 0.5; this.vel[i * 3 + 2] = o.vz ?? 0;
    this.age[i] = 0; this.life[i] = o.life ?? 2.2; this.size[i] = o.size ?? 0.2; this.grow[i] = o.grow ?? 0.5; this.alpha[i] = o.alpha ?? 0.7;
    const c = new THREE.Color(o.tint ?? 0xffffff).multiplyScalar(o.shade ?? 0.85);
    this.shade[i * 3] = c.r; this.shade[i * 3 + 1] = c.g; this.shade[i * 3 + 2] = c.b;
  }
  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { // swap-remove
        const l = --this.n;
        if (i !== l) {
          for (let k = 0; k < 3; k++) { this.pos[i * 3 + k] = this.pos[l * 3 + k]; this.vel[i * 3 + k] = this.vel[l * 3 + k]; this.shade[i * 3 + k] = this.shade[l * 3 + k]; }
          this.age[i] = this.age[l]; this.life[i] = this.life[l]; this.size[i] = this.size[l]; this.grow[i] = this.grow[l]; this.alpha[i] = this.alpha[l];
        }
        i--; continue;
      }
      const t = this.age[i] / this.life[i];
      this.pos[i * 3] += (this.vel[i * 3] + 0.12) * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += (this.vel[i * 3 + 2] + 0.05) * dt;
      this.vel[i * 3 + 1] *= 1 - 0.5 * dt;
      this.aSize[i] = this.size[i] + this.grow[i] * t;
      this.aFrame[i] = Math.min(this.frames - 1, Math.floor(t * this.frames));
      this.aAlpha[i] = this.alpha[i] * (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88);
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.aSize.needsUpdate = true; g.attributes.aAlpha.needsUpdate = true; g.attributes.aFrame.needsUpdate = true;
  }
}

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, 1, 0.5, 600);
  private terrain: TerrainView;
  private sun = new THREE.DirectionalLight(0xfff0d8, 2.15);
  private track = new THREE.Group(); private jobTrack = new THREE.Group(); private structures = new THREE.Group(); private overlay = new THREE.Group();
  private trainViews = new Map<number, TrainView>();
  private piles = new Map<string, THREE.Mesh>();
  private railheads = new Map<number, THREE.Group>();
  private puffs = new Puffs();
  private stacks: THREE.Vector3[] = [];
  private rev = { track: -1, structures: -1, jobs: '' };
  private preview: Preview = {};
  private previewKey = '';
  private mapBase: HTMLCanvasElement | null = null; private mapRev = -1;
  private time = 0; private slow = 0; private frames = 0;
  quality: 'high' | 'low' = 'high';

  cam = { x: 52, z: 70, dist: 150, yaw: 0.3, pitch: 0.66, follow: null as number | null };
  private camGoal: { x: number; z: number; dist?: number } | null = null;

  constructor(canvas: HTMLCanvasElement, private s: GameState) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.scene.background = new THREE.Color(PAL.table);
    this.scene.fog = new THREE.Fog(PAL.table, 150, 420);

    this.scene.add(new THREE.HemisphereLight(0xe8eef2, 0xa08a6c, 1.25));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    const table = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ color: PAL.table }));
    table.rotation.x = -Math.PI / 2; table.position.set(N / 2, -3.22, N / 2); table.receiveShadow = true;
    this.scene.add(table);

    this.terrain = new TerrainView(s);
    this.scene.add(this.terrain.group, this.track, this.jobTrack, this.structures, this.overlay, this.puffs.points);
    this.resize();
  }

  setState(s: GameState) {
    this.s = s; this.terrain.setState(s);
    this.rev = { track: -1, structures: -1, jobs: '' };
    for (const v of this.trainViews.values()) this.scene.remove(v.group);
    this.trainViews.clear();
    this.cam.follow = null;
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 1, h = c.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    (this.puffs.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h * this.renderer.getPixelRatio() * 1.9;
  }
  setQuality(q: 'high' | 'low') {
    this.quality = q;
    this.renderer.shadowMap.enabled = q === 'high';
    this.sun.castShadow = q === 'high';
    this.renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    this.resize();
    this.scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; });
  }

  // ───────────────────────────── camera ─────────────────────────────
  private ground(x: number, z: number) { return heightAt(this.s, THREE.MathUtils.clamp(x, 0, N), THREE.MathUtils.clamp(z, 0, N)) * VS; }
  pan(dxPx: number, dyPx: number) {
    const k = (this.cam.dist * 0.00115 * 900) / (this.renderer.domElement.clientHeight || 900);
    const c = Math.cos(this.cam.yaw), s = Math.sin(this.cam.yaw);
    this.cam.x -= (dxPx * c + dyPx * s / Math.sin(this.cam.pitch)) * k;
    this.cam.z -= (-dxPx * s + dyPx * c / Math.sin(this.cam.pitch)) * k;
    this.clampCam(); this.cam.follow = null; this.camGoal = null;
  }
  move(fwd: number, right: number) {
    const k = this.cam.dist * 0.012;
    const c = Math.cos(this.cam.yaw), s = Math.sin(this.cam.yaw);
    this.cam.x += (right * c - fwd * s) * k; this.cam.z += (-right * s - fwd * c) * k;
    this.clampCam(); this.cam.follow = null; this.camGoal = null;
  }
  zoom(factor: number) { this.cam.dist = THREE.MathUtils.clamp(this.cam.dist * factor, 7, 210); }
  rotate(dyaw: number, dpitch = 0) { this.cam.yaw += dyaw; this.cam.pitch = THREE.MathUtils.clamp(this.cam.pitch + dpitch, 0.38, 1.35); }
  focus(x: number, z: number, dist?: number) { this.camGoal = { x, z, dist }; this.cam.follow = null; }
  followTrain(id: number | null) { this.cam.follow = id; this.camGoal = null; if (id != null && this.cam.dist > 26) this.cam.dist = 22; }
  private clampCam() { this.cam.x = THREE.MathUtils.clamp(this.cam.x, -4, N + 4); this.cam.z = THREE.MathUtils.clamp(this.cam.z, -4, N + 4); }
  private updateCamera(dt: number) {
    const cam = this.cam;
    if (cam.follow != null) { const v = this.trainViews.get(cam.follow); if (v) { cam.x += (v.pos.x - cam.x) * Math.min(1, dt * 5); cam.z += (v.pos.z - cam.z) * Math.min(1, dt * 5); } }
    if (this.camGoal) {
      const g = this.camGoal, k = Math.min(1, dt * 4.5);
      cam.x += (g.x - cam.x) * k; cam.z += (g.z - cam.z) * k;
      if (g.dist) cam.dist += (g.dist - cam.dist) * k;
      if (Math.hypot(g.x - cam.x, g.z - cam.z) < 0.05 && (!g.dist || Math.abs(g.dist - cam.dist) < 0.3)) this.camGoal = null;
    }
    const ty = this.ground(cam.x, cam.z);
    const h = Math.sin(cam.pitch) * cam.dist, r = Math.cos(cam.pitch) * cam.dist;
    this.camera.position.set(cam.x + Math.sin(cam.yaw) * r, ty + h, cam.z + Math.cos(cam.yaw) * r);
    this.camera.lookAt(cam.x, ty, cam.z);
    // the sun follows the view so shadows stay crisp where the player is looking
    const ext = THREE.MathUtils.clamp(cam.dist * 0.75, 14, 80);
    this.sun.target.position.set(cam.x, ty, cam.z);
    this.sun.position.set(cam.x - 60, ty + 78, cam.z + 42);
    const sc = this.sun.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 10; sc.far = 260; sc.updateProjectionMatrix();
  }

  // ───────────────────────────── picking ─────────────────────────────
  private ray = new THREE.Raycaster(); private ndc = new THREE.Vector2();
  /** Where a screen point meets the ground, by marching the view ray against the heightmap. */
  pick(clientX: number, clientY: number): { x: number; z: number } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    let prev = 0;
    for (let t = 2; t < 420; t += 0.35) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (x < 0 || z < 0 || x > N || z > N) { prev = t; continue; }
      if (y <= heightAt(this.s, x, z) * VS) {
        let lo = prev, hi = t;
        for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; const mx = o.x + d.x * m, mz = o.z + d.z * m; if (o.y + d.y * m <= heightAt(this.s, THREE.MathUtils.clamp(mx, 0, N), THREE.MathUtils.clamp(mz, 0, N)) * VS) hi = m; else lo = m; }
        return { x: THREE.MathUtils.clamp(o.x + d.x * hi, 0, N), z: THREE.MathUtils.clamp(o.z + d.z * hi, 0, N) };
      }
      prev = t;
    }
    return null;
  }
  private v3 = new THREE.Vector3();
  /** Screen position (CSS pixels within the canvas) of a ground point. */
  project(x: number, z: number, lift = 0): { x: number; y: number; visible: boolean } {
    this.v3.set(x, this.ground(x, z) + lift, z).project(this.camera);
    const c = this.renderer.domElement;
    return { x: (this.v3.x * 0.5 + 0.5) * c.clientWidth, y: (-this.v3.y * 0.5 + 0.5) * c.clientHeight, visible: this.v3.z < 1 && Math.abs(this.v3.x) < 1.1 && Math.abs(this.v3.y) < 1.1 };
  }
  trainPos(id: number): { x: number; z: number } | null { const v = this.trainViews.get(id); return v ? { x: v.pos.x, z: v.pos.z } : null; }

  // ───────────────────────────── track ─────────────────────────────
  private buildTrack(group: THREE.Group, lines: TrackPoint[][], opts: { steel: boolean }) {
    for (const c of [...group.children]) { group.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    const ballast: number[] = [], rails: number[] = [], deck: number[] = [];
    const ties: THREE.Matrix4[] = [], posts: THREE.Matrix4[] = [], portals: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const quad = (arr: number[], a: number[], b: number[], c: number[], d: number[]) => arr.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (const pts of lines) {
      if (pts.length < 2) continue;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let tx = b.x - a.x, tz = b.z - a.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const nx = -tz, nz = tx, y = p.h * VS;
        const yaw = Math.atan2(-tz, tx);
        const tunnel = p.k === K_TUNNEL, bridge = p.k === K_BRIDGE;
        if (i < pts.length - 1) {
          const n = pts[i + 1], c2 = pts[Math.min(pts.length - 1, i + 2)];
          let ux = c2.x - p.x, uz = c2.z - p.z; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
          const mx = -uz, mz = ux, y2 = n.h * VS;
          if (!(tunnel && n.k === K_TUNNEL)) {
            const strip = (arr: number[], off: number, w: number, lift: number) =>
              quad(arr, [p.x + nx * (off - w), y + lift, p.z + nz * (off - w)], [p.x + nx * (off + w), y + lift, p.z + nz * (off + w)],
                [n.x + mx * (off + w), y2 + lift, n.z + mz * (off + w)], [n.x + mx * (off - w), y2 + lift, n.z + mz * (off - w)]);
            if (bridge || n.k === K_BRIDGE) {
              strip(deck, 0, 0.27, 0.045);
              quad(deck, [p.x + nx * 0.27, y + 0.045, p.z + nz * 0.27], [p.x + nx * 0.27, y - 0.06, p.z + nz * 0.27], [n.x + mx * 0.27, y2 - 0.06, n.z + mz * 0.27], [n.x + mx * 0.27, y2 + 0.045, n.z + mz * 0.27]);
              quad(deck, [p.x - nx * 0.27, y - 0.06, p.z - nz * 0.27], [p.x - nx * 0.27, y + 0.045, p.z - nz * 0.27], [n.x - mx * 0.27, y2 + 0.045, n.z - mz * 0.27], [n.x - mx * 0.27, y2 - 0.06, n.z - mz * 0.27]);
            } else {
              strip(ballast, 0, 0.26, 0.05);
              quad(ballast, [p.x + nx * 0.26, y + 0.05, p.z + nz * 0.26], [p.x + nx * 0.44, y - 0.05, p.z + nz * 0.44], [n.x + mx * 0.44, y2 - 0.05, n.z + mz * 0.44], [n.x + mx * 0.26, y2 + 0.05, n.z + mz * 0.26]);
              quad(ballast, [p.x - nx * 0.44, y - 0.05, p.z - nz * 0.44], [p.x - nx * 0.26, y + 0.05, p.z - nz * 0.26], [n.x - mx * 0.26, y2 + 0.05, n.z - mz * 0.26], [n.x - mx * 0.44, y2 - 0.05, n.z - mz * 0.44]);
            }
            strip(rails, 0.105, 0.017, 0.085); strip(rails, -0.105, 0.017, 0.085);
          }
        }
        if (!tunnel) ties.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, y + 0.058, p.z), q.clone().setFromAxisAngle(up, yaw), new THREE.Vector3(1, 1, 1)));
        if (bridge && i % 2 === 0) {
          const cx = Math.floor(p.x), cz = Math.floor(p.z);
          const wet = cx >= 0 && cz >= 0 && cx < N && cz < N && this.s.water[ci(cx, cz)];
          const gy = (wet ? this.s.waterLevel[ci(cx, cz)] - 0.9 : heightAt(this.s, p.x, p.z)) * VS;
          const hgt = y - gy;
          if (hgt > 0.05) for (const side of [-1, 1]) {
            m.compose(new THREE.Vector3(p.x + nx * side * (0.2 + hgt * 0.06), gy + hgt / 2, p.z + nz * side * (0.2 + hgt * 0.06)), q.clone().setFromAxisAngle(up, yaw), new THREE.Vector3(1, hgt, 1));
            posts.push(m.clone());
          }
          if (hgt > 0.05) posts.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, y - 0.1, p.z), q.clone().setFromAxisAngle(up, yaw + Math.PI / 2), new THREE.Vector3(0.62 / 0.07, 0.07 / 1, 1)));
        }
        const prevK = pts[Math.max(0, i - 1)].k;
        if (i > 0 && (tunnel !== (prevK === K_TUNNEL))) portals.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, y, p.z), q.clone().setFromAxisAngle(up, yaw + (tunnel ? 0 : Math.PI)), new THREE.Vector3(1, 1, 1)));
      }
    }
    const mesh = (arr: number[], color: number, shadow = true) => {
      if (!arr.length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); g.computeVertexNormals();
      const me = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide }));
      me.receiveShadow = true; me.castShadow = shadow; group.add(me);
    };
    mesh(ballast, PAL.ballast, false); mesh(deck, PAL.timber); mesh(rails, opts.steel ? PAL.steel : PAL.iron, false);
    const inst = (geo: THREE.BufferGeometry, color: number, mats: THREE.Matrix4[]) => {
      if (!mats.length) return;
      const im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color, flatShading: true }), mats.length);
      mats.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; group.add(im);
    };
    inst(new THREE.BoxGeometry(0.07, 0.03, 0.42), PAL.tie, ties);
    inst(new THREE.BoxGeometry(0.07, 1, 0.07), PAL.timberDark, posts);
    if (portals.length) {
      const k = new Kit();
      k.box(PAL.stone, 0.16, 0.74, 0.14, 0, 0, -0.42); k.box(PAL.stone, 0.16, 0.74, 0.14, 0, 0, 0.42); k.box(PAL.stone, 0.2, 0.16, 1.0, 0, 0.72, 0);
      k.box(PAL.black, 0.5, 0.74, 0.72, 0.28, 0, 0);
      inst(k.geometry(), 0xffffff, portals);
      (group.children[group.children.length - 1] as THREE.InstancedMesh).material = MAT.solid;
    }
  }

  private syncTrack() {
    const s = this.s;
    if (this.rev.track !== s.rev.track) {
      const key = s.edges.map((e) => e.id).join(',') + (s.upgrades.steel_rails ? 's' : '');
      if ((this.track.userData.key ?? '') !== key || this.rev.track < 0) {
        const yard: TrackPoint[] = [];
        const n0 = s.nodes.find((n) => n.id === s.city.node)!;
        for (let x = n0.x - 5.5; x <= n0.x + 1e-6; x += 0.5) yard.push({ x, z: n0.z, h: n0.h, k: 0 });
        this.buildTrack(this.track, [yard, ...s.edges.map((e) => e.pts)], { steel: !!s.upgrades.steel_rails });
        this.track.userData.key = key;
      }
      this.rev.track = s.rev.track;
    }
    const jk = s.jobs.map((j) => `${j.id}:${Math.floor(j.progress * 2)}`).join('|');
    if (jk !== this.rev.jobs) {
      this.rev.jobs = jk;
      const lines = s.jobs.map((j) => { const out: TrackPoint[] = []; for (let i = 0; i < j.pts.length && j.cum[i] <= j.progress; i++) out.push(j.pts[i]); return out; });
      this.buildTrack(this.jobTrack, lines, { steel: !!s.upgrades.steel_rails });
      // survey stakes ahead of the railhead
      const stakes: THREE.Matrix4[] = [];
      for (const j of s.jobs) for (let i = 0; i < j.pts.length; i += 3) if (j.cum[i] > j.progress && j.pts[i].k !== K_TUNNEL) stakes.push(new THREE.Matrix4().makeTranslation(j.pts[i].x, Math.max(j.pts[i].h, heightAt(s, j.pts[i].x, j.pts[i].z)) * VS + 0.12, j.pts[i].z));
      if (stakes.length) { const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.26, 0.05), new THREE.MeshBasicMaterial({ color: PAL.stake }), stakes.length); stakes.forEach((mm, i) => im.setMatrixAt(i, mm)); im.frustumCulled = false; this.jobTrack.add(im); }
      for (const [id, g] of this.railheads) if (!s.jobs.some((j) => j.id === id)) { this.scene.remove(g); this.railheads.delete(id); }
      for (const j of s.jobs) {
        let g = this.railheads.get(j.id);
        if (!g) { g = makeRailhead(); this.railheads.set(j.id, g); this.scene.add(g); }
        const idx = Math.max(1, Math.min(j.pts.length - 1, j.applied + 1));
        const p = j.pts[idx], a = j.pts[idx - 1];
        g.position.set(p.x, Math.max(p.h, p.k === K_TUNNEL ? p.h : 0) * VS + 0.06, p.z);
        g.rotation.y = Math.atan2(-(p.z - a.z), p.x - a.x);
        g.visible = p.k !== K_TUNNEL;
      }
    }
  }

  // ───────────────────────────── structures ─────────────────────────────
  private syncStructures() {
    const s = this.s;
    if (this.rev.structures === s.rev.structures) return;
    this.rev.structures = s.rev.structures;
    for (const c of [...this.structures.children]) this.structures.remove(c);
    this.piles.clear(); this.stacks = [];
    const place = (g: THREE.Object3D, x: number, z: number, ry = 0, h?: number) => { g.position.set(x, (h ?? heightAt(s, x, z)) * VS, z); g.rotation.y = ry; this.structures.add(g); };
    const city = makeCity(!!s.upgrades.assay_office);
    place(city.group, s.city.x, s.city.z, 0, s.city.h);
    for (const v of city.stacks) this.stacks.push(v.clone().add(city.group.position));
    const mt = s.upgrades.steam_drills ? 1 : 0, lt = s.upgrades.second_battery ? 1 : 0;
    for (const m of s.mines) {
      const dep = s.deposits.find((d) => d.id === m.deposit)!;
      const mm = makeMine(mt, m.exhausted);
      // the adit faces into the hill
      const gx = heightAt(s, m.x + 2, m.z) - heightAt(s, m.x - 2, m.z), gz = heightAt(s, m.x, m.z + 2) - heightAt(s, m.x, m.z - 2);
      const ry = Math.atan2(gz, -gx);
      place(mm.group, m.x, m.z, ry);
      if (mm.stack) this.stacks.push(mm.stack.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ry).add(mm.group.position));
      const pile = makePile(dep.resource === 'coal' ? PAL.coal : dep.resource === 'silver' ? 0x8f969a : PAL.ore);
      const off = new THREE.Vector3(0.75, 0, 0.35).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
      pile.position.set(m.x + off.x, heightAt(s, m.x, m.z) * VS + 0.2, m.z + off.z);
      this.structures.add(pile); this.piles.set('mine' + m.id, pile);
    }
    for (const l of s.mills) {
      const mine = s.mines.find((m) => m.id === l.mine);
      const ml = makeMill(lt);
      const ry = mine ? Math.atan2(-(mine.z - l.z), mine.x - l.x) + Math.PI : 0;
      place(ml.group, l.x, l.z, ry);
      this.stacks.push(ml.stack.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ry).add(ml.group.position));
      const dep = mine ? s.deposits.find((d) => d.id === mine.deposit) : null;
      const pile = makePile(dep?.resource === 'silver' ? PAL.silver : PAL.conc);
      const off = new THREE.Vector3(1.25, 0, 0.1).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
      pile.position.set(l.x + off.x, heightAt(s, l.x, l.z) * VS + 0.16, l.z + off.z);
      this.structures.add(pile); this.piles.set('mill' + l.id, pile);
    }
    for (const st of s.stations) {
      if (st.city) continue;
      // lie along the track, on the side the works are on
      let dx = 1, dz = 0;
      for (const e of s.edges) { const k = e.a === st.node ? 1 : e.b === st.node ? e.pts.length - 2 : -1; if (k >= 0) { const a = e.pts[k === 1 ? 0 : k], b = e.pts[k === 1 ? 1 : k + 1]; dx = b.x - a.x; dz = b.z - a.z; break; } }
      let ry = Math.atan2(-dz, dx);
      const works = [...s.mines, ...s.mills].sort((a, b) => Math.hypot(a.x - st.x, a.z - st.z) - Math.hypot(b.x - st.x, b.z - st.z))[0];
      if (works) { const side = (works.x - st.x) * -dz + (works.z - st.z) * dx; if (side < 0) ry += Math.PI; }
      const node = s.nodes.find((n) => n.id === st.node);
      place(makePlatform(), st.x, st.z, ry, node?.h);
    }
    for (const d of s.deposits) {
      if (!d.discovered) continue;
      const col = d.resource === 'gold' ? PAL.gold : d.resource === 'silver' ? PAL.silver : PAL.coal;
      if (!s.mines.some((m) => m.deposit === d.id)) place(makeClaimMarker(col, d.owned), d.x, d.z);
    }
  }

  // ───────────────────────────── trains ─────────────────────────────
  private pseudoTrip(t: Train): { trip: Trip; atEnd: boolean } {
    const s = this.s;
    const home = s.stations.find((x) => x.id === t.home)!;
    const dest = t.dest != null ? s.stations.find((x) => x.id === t.dest) : s.stations.find((x) => !x.city);
    const path = dest ? findPath(s, home.node, dest.node) : null;
    let pts: TrackPoint[];
    const atPlatform = t.at !== t.home;
    if (path && path.steps.length) pts = pathPoints(s, path.steps);
    else { const n0 = s.nodes.find((n) => n.id === s.city.node)!; pts = []; for (let x = n0.x - 5.5; x <= n0.x + 1e-6; x += 0.5) pts.push({ x, z: n0.z, h: n0.h, k: 0 }); }
    const cum = cumulative(pts);
    return { trip: { pts, cum, length: cum[cum.length - 1], edges: [], dist: 0, prev: 0 }, atEnd: atPlatform || !(path && path.steps.length) };
  }

  private syncTrains(alpha: number, dt: number) {
    const s = this.s;
    for (const [id, v] of this.trainViews) if (!s.trains.some((t) => t.id === id) || s.trains.find((t) => t.id === id)!.loco !== v.kind) { this.scene.remove(v.group); this.trainViews.delete(id); }
    for (const t of s.trains) {
      let v = this.trainViews.get(t.id);
      if (!v) {
        const group = new THREE.Group(); const loco = makeLoco(t.loco); loco.rotation.order = 'YZX'; group.add(loco);
        v = { group, loco, wagons: [], kind: t.loco, lastTrip: null, lastInbound: false, pos: new THREE.Vector3(), smoke: 0 };
        this.trainViews.set(t.id, v); this.scene.add(group);
      }
      const n = Math.min(10, t.trip || t.phase === 'loading' || t.phase === 'unloading' ? t.consist : Math.max(t.consist, Math.min(t.wagons, 10)));
      while (v.wagons.length < n) { const w = makeWagon(); w.rotation.order = 'YZX'; v.wagons.push(w); v.group.add(w); }
      v.wagons.forEach((w, i) => (w.visible = i < n));
      let trip: Trip, d: number, inbound: boolean;
      if (t.trip) { trip = t.trip; d = trip.prev + (trip.dist - trip.prev) * alpha; inbound = t.phase === 'inbound'; v.lastTrip = trip; v.lastInbound = inbound; }
      else if (v.lastTrip) { trip = v.lastTrip; d = trip.length; inbound = v.lastInbound; }
      else { const p = this.pseudoTrip(t); trip = p.trip; d = p.atEnd ? trip.length : 0; inbound = false; v.lastTrip = trip; v.lastInbound = false; if (!p.atEnd) trip.dist = 0; }
      const locoLen = (v.loco.userData.length as number), cl = locoLen + n * WAGON_LEN;
      const L = trip.length, run = Math.max(0, L - cl);
      const scale = L > 1e-6 ? d / L : 1;
      // The engine always stands at the city end of its train: it pushes empties up and leads the loads down.
      const cityEnd = inbound ? L - (cl + scale * run) : scale * run;  // distance from the city along the outbound direction
      const at = (fromCity: number) => tripPose(trip, inbound ? L - fromCity : fromCity);
      const setV = (o: THREE.Object3D, fromCity: number) => {
        const p = at(Math.max(0, Math.min(L, fromCity)));
        const sgn = inbound ? -1 : 1;
        o.position.set(p.x, p.h * VS + 0.075, p.z);
        o.rotation.y = Math.atan2(-p.dz * sgn, p.dx * sgn);
        o.rotation.z = Math.atan(p.dh * sgn * VS);
        o.visible = o.visible && p.k !== K_TUNNEL;
        return p;
      };
      v.loco.visible = true;
      const lp = setV(v.loco, cityEnd + locoLen * (v.kind === 'consolidation' ? 0.68 : 0.5));
      v.pos.set(lp.x, lp.h * VS, lp.z);
      const tons = cargoTons(t), per = n > 0 ? tons / (n * 12) : 0;
      let cargoColor = PAL.ore;
      for (const [c, qn] of Object.entries(t.cargo)) if ((qn ?? 0) > 0.01) cargoColor = new THREE.Color(COMMODITIES[c as CommodityId].color).getHex();
      for (let i = 0; i < n; i++) { const w = v.wagons[i]; w.visible = true; setV(w, cityEnd + locoLen + WAGON_LEN * (i + 0.5)); setWagonLoad(w, per, cargoColor); }
      // exhaust: working hard when moving, a lazy wisp when standing
      if (v.loco.visible) {
        const moving = !!t.trip;
        v.smoke += dt * (moving ? 9 + t.speed * 0.25 : 1.2);
        while (v.smoke >= 1) {
          v.smoke -= 1;
          const w = (v.loco.userData.stack as THREE.Vector3).clone().applyEuler(v.loco.rotation).add(v.loco.position);
          this.puffs.emit(w.x, w.y, w.z, { vy: moving ? 0.9 : 0.4, vx: (Math.random() - 0.5) * 0.15, vz: (Math.random() - 0.5) * 0.15, life: moving ? 2.4 : 1.6, size: 0.13, grow: moving ? 0.75 : 0.35, shade: moving ? 0.55 + Math.random() * 0.3 : 0.95, alpha: moving ? 0.6 : 0.35 });
        }
      }
    }
  }

  private syncWorks(dt: number) {
    const s = this.s;
    for (const m of s.mines) { const p = this.piles.get('mine' + m.id); if (p) setPile(p, m.stock / mineTier(s).capacity, 1.5); }
    for (const l of s.mills) { const p = this.piles.get('mill' + l.id); if (p) setPile(p, l.stock / millTier(s).capacity, 0.9); }
    // chimneys: the city always breathes; works smoke only while they run
    const active = s.mills.some((l) => l.active) || s.mines.some((m) => m.active && !m.exhausted);
    this.time += dt;
    if (Math.floor(this.time * 3) !== Math.floor((this.time - dt) * 3)) {
      this.stacks.forEach((p, i) => {
        if (i >= 2 && !active) return;
        this.puffs.emit(p.x, p.y, p.z, { vy: 0.55, life: 3.4, size: 0.16, grow: 0.9, shade: i < 2 ? 0.8 : 0.5, alpha: 0.42 });
      });
    }
    for (const g of this.railheads.values()) if (g.visible && Math.random() < dt * 5) this.puffs.emit(g.position.x + (Math.random() - 0.5) * 0.8, g.position.y + 0.08, g.position.z + (Math.random() - 0.5) * 0.8, { vy: 0.25, life: 1.1, size: 0.12, grow: 0.3, tint: 0xc9ad84, alpha: 0.45 });
  }

  /** A burst of dust or a blast, driven by simulation events. */
  burst(kind: 'dig' | 'blast' | 'build' | 'sale', x: number, z: number) {
    const y = this.ground(x, z);
    const n = kind === 'blast' ? 26 : kind === 'sale' ? 14 : 9;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, sp = (kind === 'blast' ? 1.6 : 0.6) * (0.3 + Math.random());
      this.puffs.emit(x + Math.cos(a) * 0.3, y + 0.1, z + Math.sin(a) * 0.3, {
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: kind === 'blast' ? 1.4 + Math.random() * 1.6 : kind === 'sale' ? 1.3 : 0.5,
        life: kind === 'blast' ? 2.2 : 1.3, size: kind === 'blast' ? 0.3 : 0.16, grow: kind === 'blast' ? 1.3 : 0.5,
        tint: kind === 'sale' ? 0xf0c84a : kind === 'blast' && i < 6 ? 0xffd9a0 : 0xc2a680, shade: kind === 'blast' && i >= 6 ? 0.7 : 1, alpha: kind === 'sale' ? 0.9 : 0.6,
      });
    }
  }

  // ───────────────────────────── tool previews ─────────────────────────────
  setPreview(p: Preview) { this.preview = p; }
  private syncPreview() {
    const p = this.preview;
    const key = JSON.stringify([p.route ? [p.route.pts.length, p.route.valid, p.route.way, p.route.pts[p.route.pts.length - 1]] : 0, p.brush, p.ghost, p.ring, p.select, this.s.rev.terrain]);
    if (key === this.previewKey) return;
    this.previewKey = key;
    for (const c of [...this.overlay.children]) { this.overlay.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    const s = this.s;
    const drape = (x: number, z: number, r: number, color: number, width = 0.09, opacity = 0.95) => {
      const pos: number[] = [];
      const seg = Math.max(24, Math.round(r * 14));
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * 6.2832, a1 = ((i + 1) / seg) * 6.2832;
        const pt = (a: number, rr: number) => { const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr; return [px, this.ground(px, pz) + 0.07, pz]; };
        pos.push(...pt(a0, r), ...pt(a1, r), ...pt(a1, r + width), ...pt(a0, r), ...pt(a1, r + width), ...pt(a0, r + width));
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity, depthTest: false }));
      m.renderOrder = 5; this.overlay.add(m);
    };
    if (p.brush) drape(p.brush.x, p.brush.z, p.brush.radius, p.brush.color, 0.1);
    if (p.ring) drape(p.ring.x, p.ring.z, p.ring.r, p.ring.color, 0.14, 0.8);
    if (p.select) drape(p.select.x, p.select.z, p.select.r, 0xffffff, 0.07, 0.9);
    if (p.ghost) {
      const g = p.ghost, pos: number[] = [];
      const h = heightAt(s, g.x, g.z) * VS + 0.1;
      pos.push(g.x - g.half, h, g.z - g.half, g.x - g.half, h, g.z + g.half, g.x + g.half, h, g.z + g.half, g.x - g.half, h, g.z - g.half, g.x + g.half, h, g.z + g.half, g.x + g.half, h, g.z - g.half);
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: g.ok ? 0x7fd08a : 0xd9614e, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false }));
      m.renderOrder = 5; this.overlay.add(m);
      const box = new THREE.Mesh(new THREE.BoxGeometry(g.half * 1.5, 0.7, g.half * 1.5), new THREE.MeshBasicMaterial({ color: g.ok ? 0x7fd08a : 0xd9614e, transparent: true, opacity: 0.35 }));
      box.position.set(g.x, h + 0.35, g.z); this.overlay.add(box);
    }
    if (p.route) {
      const r = p.route;
      const colors = [0xf4ecd8, 0xe0a34a, 0x6fb7d9, 0xb28ad6];
      const pos: number[] = [], col: number[] = [];
      const c = new THREE.Color();
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const nx = -tz * 0.16, nz = tx * 0.16;
        const ya = Math.max(a.h, a.k === K_TUNNEL ? heightAt(s, a.x, a.z) : a.h) * VS + 0.12, yb = Math.max(b.h, b.k === K_TUNNEL ? heightAt(s, b.x, b.z) : b.h) * VS + 0.12;
        pos.push(a.x - nx, ya, a.z - nz, a.x + nx, ya, a.z + nz, b.x + nx, yb, b.z + nz, a.x - nx, ya, a.z - nz, b.x + nx, yb, b.z + nz, b.x - nx, yb, b.z - nz);
        c.set(r.valid ? colors[a.k] : 0xd9614e);
        for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b);
        // stilts show how far the grade line floats above or sinks below the ground
        if (i % 4 === 0 && a.k !== K_TUNNEL) {
          const gy = heightAt(s, a.x, a.z) * VS;
          if (Math.abs(ya - gy) > 0.2) { pos.push(a.x - 0.03, ya, a.z, a.x + 0.03, ya, a.z, a.x + 0.03, gy, a.z, a.x - 0.03, ya, a.z, a.x + 0.03, gy, a.z, a.x - 0.03, gy, a.z); for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b); }
        }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false }));
      m.renderOrder = 6; this.overlay.add(m);
      r.way.forEach((w, i) => {
        const k = new THREE.Mesh(new THREE.SphereGeometry(i === 0 || i === r.way.length - 1 ? 0.34 : 0.26, 12, 8), new THREE.MeshBasicMaterial({ color: i === 0 ? 0x7fd08a : i === r.way.length - 1 ? 0xf0c84a : 0xffffff, depthTest: false }));
        k.position.set(w.x, this.ground(w.x, w.z) + 0.3, w.z); k.renderOrder = 7; this.overlay.add(k);
      });
    }
  }

  // ───────────────────────────── frame ─────────────────────────────
  frame(alpha: number, dt: number) {
    const s = this.s;
    this.terrain.applyDirty();
    this.terrain.syncTrees();
    this.syncTrack();
    this.syncStructures();
    this.syncTrains(alpha, dt);
    this.syncWorks(dt);
    this.syncPreview();
    this.puffs.update(dt);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
    // drop to the light renderer if this machine cannot hold the frame rate
    this.frames++;
    if (dt > 0.05) this.slow++;
    if (this.frames === 90) { if (this.quality === 'high' && this.slow > 55) this.setQuality('low'); this.frames = 0; this.slow = 0; }
    void s;
  }

  // ───────────────────────────── overview map ─────────────────────────────
  drawMap(ctx: CanvasRenderingContext2D, size: number) {
    const s = this.s;
    if (!this.mapBase || this.mapRev !== s.rev.terrain + s.rev.trees) {
      this.mapRev = s.rev.terrain + s.rev.trees;
      const cv = this.mapBase ?? document.createElement('canvas'); cv.width = N; cv.height = N;
      const c2 = cv.getContext('2d')!; const img = c2.createImageData(N, N);
      const col = new THREE.Color(), a = new THREE.Color(PAL.grassLow), b = new THREE.Color(PAL.grassHigh), rk = new THREE.Color(PAL.rock), pale = new THREE.Color(PAL.snow), fo = new THREE.Color(0x56805a), wa = new THREE.Color(PAL.water), ea = new THREE.Color(PAL.earth);
      for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
        const i = z * (N + 1) + x, h = s.height[i];
        if (s.water[ci(x, z)]) col.copy(wa);
        else if (s.soil[i] < 0.22) col.copy(rk).lerp(pale, THREE.MathUtils.clamp((h - 20) / 22, 0, 1));
        else if (Math.abs(h - s.baseHeight[i]) > 0.15) col.copy(ea);
        else { col.copy(a).lerp(b, THREE.MathUtils.clamp((h - 4) / 14, 0, 1)); if (s.forest[ci(x, z)]) col.lerp(fo, 0.75); }
        const shade = 1 + THREE.MathUtils.clamp((s.height[i] - s.height[Math.min(i + 1, s.height.length - 1)]) * 0.12, -0.25, 0.25);
        const o = (z * N + x) * 4;
        img.data[o] = Math.min(255, col.r * 255 * shade); img.data[o + 1] = Math.min(255, col.g * 255 * shade); img.data[o + 2] = Math.min(255, col.b * 255 * shade); img.data[o + 3] = 255;
      }
      c2.putImageData(img, 0, 0); this.mapBase = cv;
    }
    const k = size / N;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.mapBase, 0, 0, size, size);
    const line = (pts: TrackPoint[], color: string, w: number, upTo = Infinity, cum?: number[]) => {
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
      pts.forEach((p, i) => { if (cum && cum[i] > upTo) return; if (i === 0) ctx.moveTo(p.x * k, p.z * k); else ctx.lineTo(p.x * k, p.z * k); });
      ctx.stroke();
    };
    for (const j of s.jobs) { ctx.setLineDash([3, 3]); line(j.pts, 'rgba(255,255,255,.75)', 1.2); ctx.setLineDash([]); line(j.pts, '#231f1c', 2, j.progress, j.cum); }
    for (const e of s.edges) line(e.pts, '#231f1c', 2);
    const dot = (x: number, z: number, r: number, fill: string, stroke = '#231f1c') => { ctx.beginPath(); ctx.arc(x * k, z * k, r, 0, 6.2832); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); };
    for (const d of s.deposits) {
      if (d.discovered) dot(d.x, d.z, 3.4, d.resource === 'gold' ? '#e0b23a' : d.resource === 'silver' ? '#d5dbdf' : '#2a2826', d.owned ? '#231f1c' : '#ffffff');
      else if (d.rumor) { ctx.beginPath(); ctx.arc(d.rumor.x * k, d.rumor.z * k, d.rumor.r * k, 0, 6.2832); ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); }
    }
    ctx.fillStyle = '#7b2f25'; ctx.strokeStyle = '#f4ecd8'; ctx.lineWidth = 1; ctx.fillRect(s.city.x * k - 4, s.city.z * k - 4, 8, 8); ctx.strokeRect(s.city.x * k - 4, s.city.z * k - 4, 8, 8);
    for (const st of s.stations) if (!st.city) { ctx.fillStyle = '#f4ecd8'; ctx.fillRect(st.x * k - 2.5, st.z * k - 2.5, 5, 5); ctx.strokeStyle = '#231f1c'; ctx.strokeRect(st.x * k - 2.5, st.z * k - 2.5, 5, 5); }
    for (const v of this.trainViews.values()) dot(v.pos.x, v.pos.z, 2.6, '#c8442f', '#ffffff');
    // view marker
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.2;
    const r = this.cam.dist * 0.32 * k;
    ctx.beginPath(); ctx.arc(this.cam.x * k, this.cam.z * k, Math.max(4, r), 0, 6.2832); ctx.stroke();
  }

  dispose() { this.renderer.dispose(); }
}
export { MINE, MILL };
