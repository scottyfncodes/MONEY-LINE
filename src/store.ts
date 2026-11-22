import { create } from 'zustand';
import { WORLD, fmtMoney } from './sim/config';
import { availableCredit } from './sim/economy';
import { previewLine, type LinePreview } from './sim/rail';
import type { RouteOptions } from './sim/route';
import type { TerrainTool } from './sim/terrain';
import { exec, newGame, type Command } from './sim/sim';
import { fromSave, toSave, type SaveFile } from './sim/save';
import type { GameState, Result } from './sim/types';
import { readSave, writeSave } from './persist/db';
import { audio } from './audio/audio';

export type Tool = 'inspect' | 'survey' | 'terrain' | 'rail' | 'build' | 'trains' | 'finance' | 'works';
export type BuildKind = 'mine' | 'mill' | 'platform';
export type Selection =
  | { kind: 'train' | 'mine' | 'mill' | 'station' | 'deposit' | 'edge'; id: number }
  | { kind: 'city' } | { kind: 'terrain'; x: number; z: number };
export interface Toast { id: number; kind: 'info' | 'good' | 'warn' | 'bad'; text: string; until: number; action?: { label: string; run: () => void } }
type XZ = { x: number; z: number };

/** On a phone the valley is the whole screen, so tools that work on the map keep their paperwork folded away. */
export const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 820px)').matches;

/** What the bank would have to lend to cover a shortfall, in whole thousands, if the credit line has it. */
export function loanFor(g: GameState, short: number, reserve = 1000): number | null {
  if (short <= 0) return null;
  // a loan that leaves the till empty only brings the player straight back, so it carries a little working cash
  const want = Math.ceil((short + reserve) / 1000) * 1000, free = Math.floor(availableCredit(g));
  return want <= free ? want : short <= free ? free : null;
}
const SHORT = /^Short by \$([\d,]+)/;

interface UI {
  screen: 'title' | 'game';
  game: GameState | null;
  /** bumped a few times a second so panels re-read the (mutable) simulation state */
  rev: number;
  speed: number;                      // index into TIME.speeds
  tool: Tool; panelOpen: boolean;
  terrainTool: TerrainTool; brush: number;
  buildKind: BuildKind; lifting: boolean;
  way: XZ[]; routeOpt: RouteOptions; line: LinePreview | null;
  /** earlier shapes of the line being laid out, for Undo */
  wayUndo: XZ[][];
  /** a finger or the mouse is drawing a line right now */
  drawing: boolean;
  selection: Selection | null;
  toasts: Toast[]; chip: { text: string; tone: 'ok' | 'bad' | 'info' } | null;
  sound: boolean; music: boolean; help: boolean; menu: boolean;
  saveInfo: SaveFile['summary'] | null; savedAt: number;
  bump: () => void;
  setTool: (t: Tool) => void;
  set: (p: Partial<UI>) => void;
  toast: (kind: Toast['kind'], text: string, action?: Toast['action']) => void;
  run: (c: Command, quiet?: boolean) => Result<unknown>;
  setWay: (way: XZ[], opt?: Partial<RouteOptions>) => void;
  /** remember the line as it is now, before changing it */
  keepWay: () => void;
  undoWay: () => void;
  startNew: (seed?: number) => void;
  continueGame: () => Promise<boolean>;
  save: (slot?: string) => Promise<void>;
  probeSave: () => Promise<void>;
}

const FRESH = { tool: 'inspect' as Tool, panelOpen: false, selection: null, way: [], line: null, wayUndo: [], drawing: false, lifting: false, speed: 1, toasts: [], menu: false };

let toastId = 1;
export const useUI = create<UI>((set, get) => ({
  screen: 'title', game: null, rev: 0, speed: 1, tool: 'inspect', panelOpen: false,
  terrainTool: 'grade', brush: 2, buildKind: 'mine', lifting: false,
  way: [], routeOpt: { bias: 0, tunnels: true, bridges: true }, line: null, wayUndo: [], drawing: false,
  selection: null, toasts: [], chip: null, sound: true, music: true, help: false, menu: false, saveInfo: null, savedAt: 0,
  bump: () => set((s) => ({ rev: s.rev + 1 })),
  set: (p) => set(p),
  setTool: (t) => {
    const s = get();
    const same = s.tool === t;
    // Picking the tool already in hand only folds or unfolds its panel; it never drops the tool.
    // Track is laid on the map itself, so on a phone the Railroad paperwork stays folded until it is asked for.
    set({ tool: t, panelOpen: t === 'inspect' ? false : same ? !s.panelOpen : !(t === 'rail' && isPhone()), chip: null, lifting: false, selection: null, drawing: false });
    if (t !== 'rail') set({ way: [], line: null, wayUndo: [] });
  },
  toast: (kind, text, action) => set((s) => ({ toasts: [...s.toasts.filter((t) => t.until > performance.now()).slice(-3), { id: toastId++, kind, text, action, until: performance.now() + (action ? 9000 : kind === 'bad' || kind === 'warn' ? 6500 : 5000) }] })),
  run: (c, quiet) => {
    const g = get().game;
    if (!g) return { ok: false, error: 'No game.' };
    const r = exec(g, c);
    if (!r.ok && !quiet) {
      // Being short of money is the one refusal the player can cure on the spot, so the loan is offered with it.
      const short = SHORT.exec(r.error ?? '');
      const loan = short ? loanFor(g, Number(short[1].replace(/,/g, ''))) : null;
      if (short && loan) get().toast('bad', `Short by $${short[1]}.`, { label: `Borrow ${fmtMoney(loan)}`, run: () => { get().run({ type: 'borrow', amount: loan }); } });
      else if (short) get().toast('bad', `Short by $${short[1]}, and the bank will lend no more. Free up cash first.`);
      else get().toast('bad', r.error ?? 'That cannot be done.');
      audio.play('thud', 0.35);
    }
    else if (r.ok && !quiet && c.type !== 'terrain') audio.play('click', 0.5);
    set((s) => ({ rev: s.rev + 1 }));
    return r;
  },
  setWay: (way, opt) => {
    const g = get().game; if (!g) return;
    const routeOpt = { ...get().routeOpt, ...opt };
    const clamped = way.map((p) => ({ x: Math.max(1.6, Math.min(WORLD.size - 1.6, p.x)), z: Math.max(1.6, Math.min(WORLD.size - 1.6, p.z)) }));
    set({ way: clamped, routeOpt, line: clamped.length >= 2 ? previewLine(g, clamped, routeOpt) : null, ...(clamped.length ? {} : { wayUndo: [] }) });
  },
  keepWay: () => set((s) => ({ wayUndo: [...s.wayUndo.slice(-19), s.way] })),
  undoWay: () => {
    const u = get().wayUndo; if (!u.length) return;
    const rest = u.slice(0, -1);
    get().setWay(u[u.length - 1]);
    set({ wayUndo: rest });
  },
  startNew: (seed) => { set({ game: newGame(seed ?? WORLD.defaultSeed), screen: 'game', ...FRESH }); },
  continueGame: async () => {
    const f = await readSave('auto');
    if (!f) return false;
    try { set({ game: fromSave(f), screen: 'game', ...FRESH }); return true; }
    catch (e) { get().toast('bad', (e as Error).message); return false; }
  },
  save: async (slot = 'auto') => {
    const g = get().game; if (!g) return;
    const f = toSave(g);
    await writeSave(slot, f);
    set({ saveInfo: f.summary, savedAt: Date.now() });
  },
  probeSave: async () => { const f = await readSave('auto'); set({ saveInfo: f ? f.summary : null }); },
}));
