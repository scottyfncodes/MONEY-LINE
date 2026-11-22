import { create } from 'zustand';
import { WORLD } from './sim/config';
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
export interface Toast { id: number; kind: 'info' | 'good' | 'warn' | 'bad'; text: string; until: number }

interface UI {
  screen: 'title' | 'game';
  game: GameState | null;
  /** bumped a few times a second so panels re-read the (mutable) simulation state */
  rev: number;
  speed: number;                      // index into TIME.speeds
  tool: Tool; panelOpen: boolean;
  terrainTool: TerrainTool; brush: number;
  buildKind: BuildKind; lifting: boolean;
  way: Array<{ x: number; z: number }>; routeOpt: RouteOptions; line: LinePreview | null;
  selection: Selection | null;
  toasts: Toast[]; chip: { text: string; tone: 'ok' | 'bad' | 'info' } | null;
  sound: boolean; music: boolean; help: boolean; menu: boolean;
  saveInfo: SaveFile['summary'] | null; savedAt: number;
  bump: () => void;
  setTool: (t: Tool) => void;
  set: (p: Partial<UI>) => void;
  toast: (kind: Toast['kind'], text: string) => void;
  run: (c: Command, quiet?: boolean) => Result<unknown>;
  setWay: (way: Array<{ x: number; z: number }>, opt?: Partial<RouteOptions>) => void;
  startNew: (seed?: number) => void;
  continueGame: () => Promise<boolean>;
  save: (slot?: string) => Promise<void>;
  probeSave: () => Promise<void>;
}

let toastId = 1;
export const useUI = create<UI>((set, get) => ({
  screen: 'title', game: null, rev: 0, speed: 1, tool: 'inspect', panelOpen: false,
  terrainTool: 'grade', brush: 2, buildKind: 'mine', lifting: false,
  way: [], routeOpt: { bias: 0, tunnels: true, bridges: true }, line: null,
  selection: null, toasts: [], chip: null, sound: true, music: true, help: false, menu: false, saveInfo: null, savedAt: 0,
  bump: () => set((s) => ({ rev: s.rev + 1 })),
  set: (p) => set(p),
  setTool: (t) => {
    const s = get();
    const same = s.tool === t;
    // picking the tool already in hand only folds or unfolds its panel; it never drops the tool
    set({ tool: t, panelOpen: t === 'inspect' ? false : same ? !s.panelOpen : true, chip: null, lifting: false, selection: null });
    if (t !== 'rail') set({ way: [], line: null });
  },
  toast: (kind, text) => set((s) => ({ toasts: [...s.toasts.filter((t) => t.until > performance.now()).slice(-3), { id: toastId++, kind, text, until: performance.now() + (kind === 'bad' || kind === 'warn' ? 6500 : 5000) }] })),
  run: (c, quiet) => {
    const g = get().game;
    if (!g) return { ok: false, error: 'No game.' };
    const r = exec(g, c);
    if (!r.ok && !quiet) { get().toast('bad', r.error ?? 'That cannot be done.'); audio.play('thud', 0.35); }
    else if (r.ok && !quiet && c.type !== 'terrain') audio.play('click', 0.5);
    set((s) => ({ rev: s.rev + 1 }));
    return r;
  },
  setWay: (way, opt) => {
    const g = get().game; if (!g) return;
    const routeOpt = { ...get().routeOpt, ...opt };
    const clamped = way.map((p) => ({ x: Math.max(1.6, Math.min(WORLD.size - 1.6, p.x)), z: Math.max(1.6, Math.min(WORLD.size - 1.6, p.z)) }));
    set({ way: clamped, routeOpt, line: clamped.length >= 2 ? previewLine(g, clamped, routeOpt) : null });
  },
  startNew: (seed) => { set({ game: newGame(seed ?? WORLD.defaultSeed), screen: 'game', tool: 'inspect', panelOpen: false, selection: null, way: [], line: null, speed: 1, toasts: [], menu: false }); },
  continueGame: async () => {
    const f = await readSave('auto');
    if (!f) return false;
    try { set({ game: fromSave(f), screen: 'game', tool: 'inspect', panelOpen: false, selection: null, way: [], line: null, speed: 1, toasts: [], menu: false }); return true; }
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
