import { WORLD, FINANCE } from './config';
import { clamp, fbm, lerp, mulberry32, ridged, smoothstep } from './rng';
import type { Deposit, GameState } from './types';

const N = WORLD.size;
const V = N + 1;
export const vi = (x: number, z: number) => z * V + x;
export const ci = (x: number, z: number) => z * N + x;
export const quant = (h: number) => Math.round(h / WORLD.heightStep) * WORLD.heightStep;

/** River centreline x for a given z; it wanders down the valley from north to south. */
export function riverX(z: number, seed: number): number {
  const p = (seed % 97) * 0.13;
  return 61 + 8.5 * Math.sin(z * 0.043 + p) + 4 * Math.sin(z * 0.108 + p * 2.3) + 1.6 * Math.sin(z * 0.27 + p);
}
export const valleyFloor = (z: number) => 2.4 + (N - z) * 0.034;
/** Height of the river surface where it passes a given z. */
export const riverSurface = (z: number) => valleyFloor(z) - 0.75;

function distToRiver(x: number, z: number, seed: number): number {
  // the river is a function of z, so a short search around z is enough
  let best = Infinity;
  for (let dz = -6; dz <= 6; dz += 0.5) {
    const zz = z + dz;
    const dx = x - riverX(zz, seed);
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}

export interface Sites { city: { x: number; z: number }; gold: { x: number; z: number }; silver: { x: number; z: number }; coal: { x: number; z: number } }
export const SITES: Sites = {
  city: { x: 24, z: 101 },
  gold: { x: 89, z: 62 },
  silver: { x: 26, z: 27 },
  coal: { x: 76, z: 84 },
};

function rawHeight(x: number, z: number, seed: number): number {
  const floor = valleyFloor(z);
  const dr = distToRiver(x, z, seed);
  const away = smoothstep(3, 34, dr);

  // rolling foothills, taller away from the river
  let h = floor + away * (fbm(x * 0.045, z * 0.045, seed, 4) * 9 - 1.2);
  h += smoothstep(2, 12, dr) * fbm(x * 0.14, z * 0.14, seed + 7, 3) * 1.8;

  // the Sawtooth massif in the north-east
  const mx = x - 106, mz = z - 26;
  const md = Math.hypot(mx * 0.82, mz);
  const massif = Math.exp(-(md * md) / (34 * 34)) * 30;
  h += massif * (0.55 + 0.75 * ridged(x * 0.05, z * 0.05, seed + 31, 4));

  // a western ridge between the city and the far north-west, with one low saddle
  const ridgeZ = 61 + 5 * Math.sin(x * 0.07 + 1.3);
  const rd = z - ridgeZ;
  const ridgeMask = smoothstep(57, 44, x) * Math.exp(-(rd * rd) / (8.5 * 8.5));
  const saddle = 1 - 0.62 * Math.exp(-((x - 37) * (x - 37)) / (5.5 * 5.5));
  h += ridgeMask * saddle * (13 + 6 * ridged(x * 0.09, z * 0.09, seed + 53, 3));

  // northern wall closing the valley head
  h += smoothstep(22, 0, z) * smoothstep(8, 30, dr) * 9 * (0.6 + 0.6 * ridged(x * 0.07, z * 0.07, seed + 77, 3));

  // south-east hills
  const sx = x - 104, sz = z - 104;
  h += Math.exp(-(sx * sx + sz * sz) / (26 * 26)) * 9 * (0.5 + fbm(x * 0.08, z * 0.08, seed + 91, 3));

  // the river cuts its bed
  const bank = smoothstep(4.5, 1.2, dr);
  h = lerp(h, floor - 1.5, bank);
  return h;
}

/** Blend terrain toward a level bench around a site so there is a plausible place to work. */
function bench(height: Float32Array, cx: number, cz: number, radius: number, strength: number, level?: number) {
  const target = level ?? height[vi(Math.round(cx), Math.round(cz))];
  for (let z = Math.max(0, Math.floor(cz - radius - 2)); z <= Math.min(N, Math.ceil(cz + radius + 2)); z++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 2)); x <= Math.min(N, Math.ceil(cx + radius + 2)); x++) {
      const d = Math.hypot(x - cx, z - cz);
      const w = strength * smoothstep(radius + 2, radius * 0.45, d);
      const i = vi(x, z);
      height[i] = lerp(height[i], target, w);
    }
  }
  return target;
}

export function generateWorld(seed: number): GameState {
  const rnd = mulberry32(seed * 7919 + 13);
  const height = new Float32Array(V * V);
  const soil = new Float32Array(V * V);
  const forest = new Uint8Array(N * N);
  const water = new Uint8Array(N * N);
  const waterLevel = new Float32Array(N * N);
  const locked = new Uint8Array(V * V);

  for (let z = 0; z <= N; z++) for (let x = 0; x <= N; x++) height[vi(x, z)] = rawHeight(x, z, seed);

  const cityH = bench(height, SITES.city.x, SITES.city.z, 8, 1, valleyFloor(SITES.city.z) + 0.9);
  bench(height, SITES.gold.x, SITES.gold.z, 4.6, 1);
  bench(height, SITES.silver.x, SITES.silver.z, 4, 0.5);
  bench(height, SITES.coal.x, SITES.coal.z, 3.5, 0.5);

  for (let i = 0; i < height.length; i++) height[i] = quant(height[i]);

  // water cells and their surface
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const dr = distToRiver(x + 0.5, z + 0.5, seed);
    if (dr < 1.55) {
      water[ci(x, z)] = 1;
      waterLevel[ci(x, z)] = quant(valleyFloor(z + 0.5) - 0.75);
    }
  }
  // keep river banks below nothing odd: the bed must sit under the surface
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (water[ci(x, z)]) {
    const wl = waterLevel[ci(x, z)];
    for (const [vx, vz] of [[x, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]]) {
      const i = vi(vx, vz);
      if (height[i] > wl - 0.4) height[i] = quant(wl - 0.4 - 0.4 * rnd());
    }
  }

  // soil cover: deep in the valley, thin on steep and high ground, bare rock on crags
  for (let z = 0; z <= N; z++) for (let x = 0; x <= N; x++) {
    const h = height[vi(x, z)];
    const hx = height[vi(Math.min(N, x + 1), z)] - height[vi(Math.max(0, x - 1), z)];
    const hz = height[vi(x, Math.min(N, z + 1))] - height[vi(x, Math.max(0, z - 1))];
    const slope = Math.hypot(hx, hz) * 0.5;
    const s = 3.4 - slope * 1.7 - Math.max(0, h - 15) * 0.16 + (fbm(x * 0.2, z * 0.2, seed + 5, 2) - 0.5) * 1.2;
    soil[vi(x, z)] = quant(clamp(s, 0, 3.6));
  }

  // forest on the foothills
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    if (water[ci(x, z)]) continue;
    const h = height[vi(x, z)];
    const s = soil[vi(x, z)];
    const dc = Math.hypot(x - SITES.city.x, z - SITES.city.z);
    if (dc < 12 || s < 0.7 || h > 24) continue;
    const dr = distToRiver(x + 0.5, z + 0.5, seed);
    const n = fbm(x * 0.07, z * 0.07, seed + 211, 3) + smoothstep(4, 22, h) * 0.22 - (dr < 3 ? 0.25 : 0);
    if (n > 0.56) forest[ci(x, z)] = n > 0.7 ? 3 : n > 0.62 ? 2 : 1;
  }

  const dep = (id: number, resource: Deposit['resource'], name: string, at: { x: number; z: number }, radius: number,
               depth: number, tons: number, grade: number, difficulty: number): Deposit => {
    const bias = (rnd() - 0.5) * 0.5;
    return {
      id, resource, name, x: at.x, z: at.z, radius, depth, actualTons: tons, remaining: tons, grade, difficulty, bias,
      surveyLevel: 0, discovered: false, owned: false,
      hiddenExtension: 0, extensionFound: false, rumor: null,
    };
  };
  const gold = dep(1, 'gold', 'Eureka Lode', SITES.gold, 5, 2, Math.round(6400 + rnd() * 1800), 1, 1);
  gold.discovered = true; gold.owned = true; gold.surveyLevel = 1;
  const silver = dep(2, 'silver', 'Sawtooth Vein', SITES.silver, 5, 3, Math.round(9000 + rnd() * 3000), 1.1, 1.15);
  silver.hiddenExtension = Math.round(silver.actualTons * (0.3 + rnd() * 0.2));
  silver.rumor = { x: SITES.silver.x + Math.round((rnd() - 0.5) * 8), z: SITES.silver.z + Math.round((rnd() - 0.5) * 8), r: 11 };
  const coal = dep(3, 'coal', 'River Bend Seam', SITES.coal, 4.5, 1, Math.round(15000 + rnd() * 5000), 1, 0.6);

  const state: GameState = {
    version: 1, seed, tick: 0, day: 0, size: N,
    height, soil, baseHeight: new Float32Array(height), forest, water, waterLevel, locked,
    city: { x: SITES.city.x, z: SITES.city.z, h: cityH, radius: 6, node: 1, station: 1, name: 'Prosperity' },
    deposits: [gold, silver, coal],
    nodes: [{ id: 1, x: SITES.city.x + 2, z: SITES.city.z - 1.5, h: quant(cityH) }],
    edges: [], jobs: [],
    stations: [{ id: 1, node: 1, x: SITES.city.x + 2, z: SITES.city.z - 1.5, name: 'Prosperity Terminal', shipRaw: true, city: true }],
    mines: [], mills: [],
    trains: [{
      id: 1, loco: 'tank', name: 'No. 1 “Prospector”', wagons: 4, home: 1, dest: null, phase: 'idle', trip: null,
      cargo: {}, at: 1, dwell: 0, consist: 0, status: 'Standing at the terminal, no service assigned', tripsDone: 0, hauled: 0, speed: 0,
    }],
    wagonsOwned: 4,
    materials: { spoil: 0, stone: 0, timber: 0 },
    finance: {
      cash: FINANCE.startCash, debt: 0, restructured: false, rateAdd: 0, assetValue: 9000, insolventDays: 0, receivership: false,
      period: { index: 0, startDay: 0, revenue: 0, operating: 0, interest: 0, capital: 0, by: {} }, history: [],
      daily: [], today: 0,
      totals: { revenue: 0, operating: 0, interest: 0, capital: 0, borrowed: 0, repaid: 0 },
    },
    upgrades: {},
    objective: 0,
    stats: {
      borrowedOnce: false, terrainEdits: 0, reachedClaim: false, firstSale: false, firstConcSale: false, profitableMonth: false,
      upgrades: 0, shipmentsSold: 0, tonsSold: 0, minesBuilt: 0, millsBuilt: 0, platformsBuilt: 0, discoveries: 0,
    },
    notes: [], nextId: 10,
    rev: { terrain: 1, track: 1, structures: 1, trees: 1 },
    dirtyCells: [], events: [],
  };
  lockCity(state);
  return state;
}

/** The city pad can never be dug up. */
export function lockCity(s: GameState) {
  const { x, z, radius } = s.city;
  for (let vz = Math.floor(z - radius); vz <= Math.ceil(z + radius); vz++)
    for (let vx = Math.floor(x - radius); vx <= Math.ceil(x + radius); vx++)
      if (vx >= 0 && vz >= 0 && vx <= N && vz <= N && Math.hypot(vx - x, vz - z) <= radius) s.locked[vi(vx, vz)] = 1;
}
