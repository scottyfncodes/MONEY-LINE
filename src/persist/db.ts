import { decodeSave, encodeSave, type SaveFile } from '../sim/save';

const DB = 'money-line', STORE = 'saves', LS_PREFIX = 'money-line:save:';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = run(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    t.oncomplete = () => db.close();
  }));
}

/** Saves live in IndexedDB; if the browser refuses (private mode), they fall back to localStorage as text. */
export async function writeSave(slot: string, file: SaveFile): Promise<void> {
  try { await tx('readwrite', (s) => s.put(file, slot)); }
  catch { try { localStorage.setItem(LS_PREFIX + slot, encodeSave(file)); } catch { /* storage unavailable: the game still runs */ } }
}
export async function readSave(slot: string): Promise<SaveFile | null> {
  try { const f = await tx<SaveFile | undefined>('readonly', (s) => s.get(slot)); if (f) return f; } catch { /* fall through */ }
  try { const t = localStorage.getItem(LS_PREFIX + slot); return t ? decodeSave(t) : null; } catch { return null; }
}
export async function deleteSave(slot: string): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(slot)); } catch { /* ignore */ }
  try { localStorage.removeItem(LS_PREFIX + slot); } catch { /* ignore */ }
}
