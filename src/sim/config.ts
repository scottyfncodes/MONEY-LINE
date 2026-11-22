/**
 * MONEY LINE — gameplay configuration.
 * Every tunable number lives here; simulation systems read it, rendering never hardcodes gameplay values.
 */

export const WORLD = {
  size: 128,            // cells per side; vertices are size+1
  cellMeters: 30,       // one cell ≈ 30 m on the ground
  levelMeters: 3,       // one elevation level ≈ 3 m
  heightStep: 0.05,     // elevations are quantised to this many levels
  defaultSeed: 1890,
} as const;

export const TIME = {
  ticksPerDay: 20,
  secondsPerDay: 5,     // real seconds per game day at 1× speed
  speeds: [0, 1, 3, 8] as const,
  daysPerMonth: 30,
  startYear: 1890,
} as const;

/** One level per cell is a 10% grade (3 m in 30 m). */
export const gradePct = (levelsPerCell: number) => levelsPerCell * (WORLD.levelMeters / WORLD.cellMeters) * 100;

export type CommodityId = 'gold_ore' | 'gold_conc' | 'silver_ore' | 'silver_conc' | 'coal';
export type ResourceId = 'gold' | 'silver' | 'coal';

export interface CommodityDef { name: string; short: string; basePrice: number; swing: number; color: string }
export const COMMODITIES: Record<CommodityId, CommodityDef> = {
  gold_ore:    { name: 'Gold ore',           short: 'Au ore',  basePrice: 34,  swing: 0.16, color: '#b89a55' },
  gold_conc:   { name: 'Gold concentrate',   short: 'Au conc', basePrice: 520, swing: 0.16, color: '#e2b23c' },
  silver_ore:  { name: 'Silver ore',         short: 'Ag ore',  basePrice: 19,  swing: 0.22, color: '#9aa3a8' },
  silver_conc: { name: 'Silver concentrate', short: 'Ag conc', basePrice: 345, swing: 0.22, color: '#cfd6da' },
  coal:        { name: 'Coal',               short: 'Coal',    basePrice: 11,  swing: 0.10, color: '#2c2a29' },
};

export interface ResourceDef {
  name: string; ore: CommodityId; concentrate: CommodityId | null;
  /** tons of concentrate per ton of ore at 100% recovery, before the deposit's own grade multiplier */
  concentrateRatio: number; hardness: number; claimBase: number;
}
export const RESOURCES: Record<ResourceId, ResourceDef> = {
  gold:   { name: 'Gold',   ore: 'gold_ore',   concentrate: 'gold_conc',   concentrateRatio: 0.125, hardness: 1.0,  claimBase: 9000 },
  silver: { name: 'Silver', ore: 'silver_ore', concentrate: 'silver_conc', concentrateRatio: 0.15,  hardness: 1.15, claimBase: 7000 },
  coal:   { name: 'Coal',   ore: 'coal',       concentrate: null,          concentrateRatio: 0,     hardness: 0.6,  claimBase: 2500 },
};

export const FINANCE = {
  startCash: 18000,
  baseCreditLimit: 60000,
  creditPerAssetDollar: 0.45,
  monthlyRate: 0.015,
  stressedRateAdd: 0.006,     // added after a loss-making month
  insolvencyDays: 45,         // days with negative cash and no credit before receivership
  restructureCredit: 25000,
  restructureRateAdd: 0.01,
  assetBookFactor: 0.6,       // construction keeps 60% of its cost as book value
  resaleFactor: 0.5,
} as const;

export const TERRAIN = {
  excavateSoil: 22,       // $ per level·cell of soil
  blastRock: 118,         // $ per level·cell of rock (labour + powder)
  fillFromSpoil: 12,      // $ per level·cell when spoil is on hand
  fillBorrowed: 30,       // $ per level·cell when material must be brought in
  clearForest: 14,        // $ per forested cell
  timberPerCell: 1.5,     // timber units recovered per cleared cell
  brushStep: 0.5,         // levels moved per application at the brush centre
  remoteSurchargeMax: 0.4,
  remoteDistance: 70,
} as const;

export const TRACK = {
  maxGradePct: 3.5,
  minRadius: 1.9,          // cells
  sampleStep: 0.5,         // cells between route samples
  railsAndTies: 118,       // $ per cell
  labour: 86,              // $ per cell
  landAccess: 26,          // $ per cell
  cutSoil: 20,             // $ per level·cell
  cutRock: 105,            // $ per level·cell (explosives)
  fill: 16,                // $ per level·cell
  bridgeBase: 760,         // $ per cell of bridge
  bridgePerLevel: 70,      // $ per cell per level of height
  tunnel: 2350,            // $ per cell
  bridgeThreshold: 2.4,    // fill deeper than this becomes a trestle
  tunnelThreshold: 5.5,    // cut deeper than this becomes a tunnel
  bridgeClearance: 1.1,    // deck height over water, levels
  formationWidth: 1.15,
  sideSlope: 0.75,
  buildCellsPerDay: 3.2,
  buildCellsPerDayFast: 4.6,
  maintenance: 0.42,       // $ per cell per day
  maintenanceBridge: 2.1,
  maintenanceTunnel: 1.3,
  steelMaintenanceFactor: 0.65,
  steelSpeedFactor: 1.12,
  timberPerCell: 0.35,     // ties
  timberCredit: 16,        // $ saved per timber unit used from stock
  stonePerCell: 0.25,      // ballast
  stoneCredit: 14,
  snapRadius: 1.6,
  demolishRefund: 0.2,
} as const;

export interface LocoDef {
  id: string; name: string; wheels: string; price: number;
  tractiveEffort: number;   // lb
  weight: number;           // tons, engine + tender
  speed: number;            // cells per day on level track
  crewPerDay: number;       // $
  fuelPerCell: number;      // $ per cell travelled
  reliability: number;      // 0..1, share of days without a shop visit
  blurb: string;
}
export const LOCOS: Record<string, LocoDef> = {
  tank: {
    id: 'tank', name: 'Prospector', wheels: '0-4-0T', price: 5200, tractiveEffort: 8200, weight: 24, speed: 46,
    crewPerDay: 14, fuelPerCell: 0.34, reliability: 0.95,
    blurb: 'A small second-hand tank engine. Cheap to run, weak on a grade.',
  },
  consolidation: {
    id: 'consolidation', name: 'Consolidation', wheels: '2-8-0', price: 16500, tractiveEffort: 21500, weight: 62, speed: 54,
    crewPerDay: 22, fuelPerCell: 0.52, reliability: 0.97,
    blurb: 'Eight coupled drivers. Hauls three times the tonnage up the same hill.',
  },
};

export const WAGON = { tare: 6, capacity: 12, price: 700, batch: 2, resale: 350 } as const;
/** Train resistance: lb per ton on level track, plus lb per ton per 1% of grade. */
export const RESISTANCE = { rolling: 5, perGradePct: 20 } as const;
export const STATION = { loadRate: 70, unloadRate: 90, dwellDays: 2.5, serviceRadius: 6.5, platformCost: 1500, cityRadius: 5 } as const;

export interface MineTier { name: string; rate: number; labour: number; capacity: number }
export const MINE = {
  cost: 6000,
  footprint: 1.5,          // half-size in cells of the level pad required
  maxPadRelief: 1.2,       // levels of relief tolerated across the pad
  railRadius: 7,           // must be within this many cells of connected track
  tiers: [
    { name: 'Hand mining',   rate: 14, labour: 68,  capacity: 260 },
    { name: 'Steam drills',  rate: 27, labour: 96,  capacity: 420 },
  ] as MineTier[],
} as const;

export interface MillTier { name: string; throughput: number; recovery: number; cost: number; capacity: number }
export const MILL = {
  cost: 13500,
  footprint: 1.5,
  maxPadRelief: 1.2,
  mineRadius: 6.5,
  tiers: [
    { name: 'Five-stamp mill', throughput: 20, recovery: 0.82, cost: 62, capacity: 60 },
    { name: 'Ten-stamp mill',  throughput: 42, recovery: 0.9,  cost: 88, capacity: 110 },
  ] as MillTier[],
} as const;

export const SURVEY = {
  prospectCost: 650,       // surface prospecting of an area
  prospectRadius: 9,
  testPitCost: 1400,
  drillCost: 3800,
  /** half-width of the reserve estimate as a share of the estimate, per survey level 0..3 */
  uncertainty: [0.75, 0.45, 0.22, 0.05],
  assayDiscount: 0.6,
  names: ['Rumour', 'Preliminary survey', 'Test pits', 'Core drilling'],
} as const;

export type UpgradeId = 'steam_drills' | 'second_battery' | 'steel_rails' | 'assay_office' | 'giant_powder' | 'track_gangs';
export interface UpgradeDef { id: UpgradeId; name: string; group: 'Railroad' | 'Mining' | 'Processing' | 'Business'; cost: number; effect: string; shows: string }
export const UPGRADES: UpgradeDef[] = [
  { id: 'steam_drills', name: 'Steam drills & hoist', group: 'Mining', cost: 9500,
    effect: 'Mines extract 27 t/day instead of 14 and hold a larger stockpile. Labour rises to $96/day.',
    shows: 'A headframe, hoist house and boiler stack rise over every mine.' },
  { id: 'giant_powder', name: 'Giant powder', group: 'Mining', cost: 3800,
    effect: 'Dynamite replaces black powder: blasting and rock cuts cost 40% less.',
    shows: 'Cheaper rock cuts on every estimate.' },
  { id: 'second_battery', name: 'Second stamp battery', group: 'Processing', cost: 8200,
    effect: 'Mills treat 42 t/day instead of 20 and recover 90% of the metal instead of 82%.',
    shows: 'Every mill gains a second battery house and a taller stack.' },
  { id: 'steel_rails', name: 'Steel rails', group: 'Railroad', cost: 6800,
    effect: 'Track maintenance falls 35% and trains run 12% faster.',
    shows: 'Bright steel replaces the dull iron on every line.' },
  { id: 'track_gangs', name: 'Second track gang', group: 'Railroad', cost: 3200,
    effect: 'Construction crews lay 4.6 cells of line a day instead of 3.2.',
    shows: 'Railheads advance visibly faster.' },
  { id: 'assay_office', name: 'Company assay office', group: 'Business', cost: 3000,
    effect: 'Test pits and core drilling cost 40% less.',
    shows: 'An assay office opens beside the city terminal.' },
];

export const BLAST = { rockDiscount: 0.6 } as const;

export const fmtMoney = (v: number) => {
  const a = Math.abs(Math.round(v));
  return (v < 0 ? '−$' : '$') + a.toLocaleString('en-US');
};
