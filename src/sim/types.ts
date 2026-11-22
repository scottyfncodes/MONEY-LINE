import type { CommodityId, ResourceId, UpgradeId } from './config';

export type SampleKind = 0 | 1 | 2 | 3; // 0 at grade, 1 cut/fill earthwork, 2 bridge, 3 tunnel
export const K_GRADE = 0, K_EARTH = 1, K_BRIDGE = 2, K_TUNNEL = 3;

/** A point along a line of track: position, formation height and structure kind. */
export interface TrackPoint { x: number; z: number; h: number; k: SampleKind }

export interface RailNode { id: number; x: number; z: number; h: number }
export interface RailEdge {
  id: number; a: number; b: number; pts: TrackPoint[]; length: number;
  /** steepest grade in percent, sign ignored */
  maxGrade: number; bridgeCells: number; tunnelCells: number; builtDay: number;
}

export interface CostItems {
  rails: number; labour: number; grading: number; explosives: number; bridges: number; tunnels: number; land: number;
  materialsCredit: number;
}

export interface RoutePlan {
  pts: TrackPoint[]; length: number; maxGrade: number; minRadius: number;
  cutSoil: number; cutRock: number; fill: number; bridgeCells: number; tunnelCells: number; forestCells: number;
  items: CostItems; total: number; valid: boolean; errors: string[];
  buildDays: number; timberUsed: number; stoneUsed: number;
}

export interface ConstructionJob {
  id: number; pts: TrackPoint[]; length: number; progress: number; total: number;
  startNode: number;            // node the line grows from
  endSnap: { x: number; z: number } | null;
  cum: number[];                // cumulative distance at each point
  applied: number;              // index of the last point whose earthworks are done
}

export interface Deposit {
  id: number; resource: ResourceId; name: string; x: number; z: number; radius: number; depth: number;
  actualTons: number; remaining: number;
  /** multiplier on the resource's concentrate ratio and ore price */
  grade: number; difficulty: number;
  /** signed error of the first estimate, fixed by the seed */
  bias: number;
  surveyLevel: number;          // 0 rumour … 3 drilled
  discovered: boolean; owned: boolean;
  /** an extension only core drilling can find, fixed by the seed */
  hiddenExtension: number; extensionFound: boolean;
  rumor: { x: number; z: number; r: number } | null;
}

export interface Station { id: number; node: number; x: number; z: number; name: string; shipRaw: boolean; city: boolean }
export interface Mine {
  id: number; deposit: number; x: number; z: number; stock: number; active: boolean; exhausted: boolean;
  producedTotal: number; builtDay: number; status: string;
}
export interface Mill {
  id: number; mine: number; x: number; z: number; stock: number; active: boolean; builtDay: number;
  processedTotal: number; status: string;
}

export type TrainPhase = 'idle' | 'outbound' | 'loading' | 'inbound' | 'unloading' | 'blocked';
export interface Trip {
  pts: TrackPoint[]; cum: number[]; length: number; edges: number[];
  /** distance travelled now and one tick ago (for smooth drawing) */
  dist: number; prev: number;
  /** station the trip ends at (absent in saves written before it was recorded) */
  to?: number;
}
export interface Train {
  id: number; loco: string; name: string; wagons: number;
  home: number;                 // city station id
  dest: number | null;          // assigned platform station id
  phase: TrainPhase; trip: Trip | null;
  cargo: Partial<Record<CommodityId, number>>;
  /** where it stands when not on a trip */
  at: number; dwell: number; consist: number; status: string;
  tripsDone: number; hauled: number; speed: number;
}

export type LedgerCat =
  | 'sales' | 'construction' | 'equipment' | 'claims' | 'survey' | 'terrain'
  | 'mine_ops' | 'mill_ops' | 'train_ops' | 'maintenance' | 'interest' | 'asset_sale';

export interface Period {
  index: number; startDay: number;
  revenue: number; operating: number; interest: number; capital: number;
  by: Partial<Record<LedgerCat, number>>;
}

export interface Finance {
  cash: number; debt: number; restructured: boolean; rateAdd: number;
  assetValue: number; insolventDays: number; receivership: boolean;
  period: Period; history: Period[];
  /** net operating result of each of the last 7 days */
  daily: number[]; today: number;
  totals: { revenue: number; operating: number; interest: number; capital: number; borrowed: number; repaid: number };
}

export interface Note { day: number; kind: 'info' | 'good' | 'warn' | 'bad'; text: string; id: number }

export interface Stats {
  borrowedOnce: boolean; terrainEdits: number; reachedClaim: boolean; firstSale: boolean; firstConcSale: boolean;
  profitableMonth: boolean; upgrades: number; shipmentsSold: number; tonsSold: number;
  minesBuilt: number; millsBuilt: number; platformsBuilt: number; discoveries: number;
}

export interface Materials { spoil: number; stone: number; timber: number }

export interface GameState {
  version: number; seed: number;
  tick: number; day: number;
  size: number;
  /** vertex arrays, (size+1)² */
  height: Float32Array; soil: Float32Array; baseHeight: Float32Array;
  /** cell arrays, size² */
  forest: Uint8Array; water: Uint8Array; waterLevel: Float32Array;
  /** vertex mask: 1 where terrain may not be edited (track bed, buildings, city) */
  locked: Uint8Array;
  city: { x: number; z: number; h: number; radius: number; node: number; station: number; name: string };
  deposits: Deposit[];
  nodes: RailNode[]; edges: RailEdge[]; jobs: ConstructionJob[];
  stations: Station[]; mines: Mine[]; mills: Mill[]; trains: Train[];
  wagonsOwned: number;
  materials: Materials;
  finance: Finance;
  upgrades: Partial<Record<UpgradeId, boolean>>;
  objective: number;
  stats: Stats;
  notes: Note[];
  nextId: number;
  /** bumped whenever terrain / track / structures change, so the renderer knows what to rebuild */
  rev: { terrain: number; track: number; structures: number; trees: number };
  dirtyCells: number[];        // x0,z0,x1,z1 quads of terrain touched since the renderer last looked
  events: SimEvent[];          // one-shot events for audio/visual feedback, drained by the client
}

export type SimEvent =
  | { type: 'blast'; x: number; z: number }
  | { type: 'dig'; x: number; z: number }
  | { type: 'sale'; amount: number; x: number; z: number }
  | { type: 'depart'; train: number }
  | { type: 'arrive'; train: number }
  | { type: 'built'; what: string; x: number; z: number }
  | { type: 'objective'; index: number }
  | { type: 'discovery'; deposit: number };

export interface Result<T = undefined> { ok: boolean; error?: string; value?: T }
export const ok = <T>(value?: T): Result<T> => ({ ok: true, value });
export const fail = <T = undefined>(error: string): Result<T> => ({ ok: false, error });
