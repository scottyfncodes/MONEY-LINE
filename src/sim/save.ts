import { recomputeLocks } from './terrain';
import type { GameState } from './types';

export const SAVE_VERSION = 2;
const TYPED = ['height', 'soil', 'baseHeight', 'forest', 'water', 'waterLevel'] as const;

export interface SaveFile { version: number; savedAt: number; summary: { day: number; cash: number; debt: number; seed: number }; state: Record<string, unknown> }

/** A structured-clone-friendly snapshot (typed arrays stay typed, so IndexedDB stores them compactly). */
export function toSave(s: GameState, now = Date.now()): SaveFile {
  const { locked, dirtyCells, events, ...rest } = s;
  void locked; void dirtyCells; void events;
  const state = structuredClone(rest) as Record<string, unknown>;
  return { version: SAVE_VERSION, savedAt: now, summary: { day: s.day, cash: Math.round(s.finance.cash), debt: Math.round(s.finance.debt), seed: s.seed }, state };
}

export function fromSave(file: SaveFile): GameState {
  if (!file || typeof file !== 'object' || !file.state) throw new Error('Not a MONEY LINE save.');
  if (file.version > SAVE_VERSION) throw new Error('This save comes from a newer version of MONEY LINE.');
  const st = migrate(structuredClone(file.state), file.version) as unknown as GameState;
  if (!Number.isInteger(st.size) || st.size <= 0) throw new Error('Save is damaged (terrain size).');
  const verts = (st.size + 1) * (st.size + 1), cells = st.size * st.size;
  // every terrain layer must be the right kind of array and the right length, or the simulation would read past its end
  const LAYERS: Record<(typeof TYPED)[number], [typeof Float32Array | typeof Uint8Array, number]> = {
    height: [Float32Array, verts], soil: [Float32Array, verts], baseHeight: [Float32Array, verts],
    forest: [Uint8Array, cells], water: [Uint8Array, cells], waterLevel: [Float32Array, cells],
  };
  for (const k of TYPED) {
    const v = (st as unknown as Record<string, unknown>)[k];
    const [kind, length] = LAYERS[k];
    if (!(v instanceof kind)) throw new Error(`Save is damaged (${k}).`);
    if (v.length !== length) throw new Error(`Save is damaged (${k}: terrain size).`);
  }
  st.locked = new Uint8Array(verts);
  st.dirtyCells = []; st.events = [];
  st.rev = { terrain: 1, track: 1, structures: 1, trees: 1 };
  recomputeLocks(st);
  return st;
}

/** Schema migrations, oldest first. Version 1 was the first public schema. */
function migrate(state: Record<string, unknown>, from: number): Record<string, unknown> {
  let v = from;
  while (v < SAVE_VERSION) {
    // 1 → 2: the guided path opens with the line itself (borrowing happens at the contract), so a venture that had only
    // been to the bank goes back to the first step; the simulation moves it on if a contract is already signed.
    if (v === 1 && state.objective === 1) state.objective = 0;
    v++;
  }
  state.version = SAVE_VERSION;
  return state;
}

const b64 = (u8: Uint8Array) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (str: string) => { const bin = atob(str); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };

/** Text form of a save (for export, the localStorage fallback and tests). */
export function encodeSave(file: SaveFile): string {
  return JSON.stringify(file, (_k, v) => {
    if (v instanceof Float32Array) return { __f32: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof Uint8Array) return { __u8: b64(v) };
    return v;
  });
}
export function decodeSave(text: string): SaveFile {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.__f32 === 'string') { const u = unb64(v.__f32); return new Float32Array(u.buffer, 0, Math.floor(u.byteLength / 4)); }
    if (v && typeof v === 'object' && typeof v.__u8 === 'string') return unb64(v.__u8);
    return v;
  });
}
