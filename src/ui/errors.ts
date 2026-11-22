/**
 * Global error handling: nothing fails silently.
 *
 * Every uncaught error and unhandled promise rejection is logged to the console with context and kept in a short
 * in-memory log (window.__mlErrors). The first time a distinct problem happens the player sees a plain message, the
 * simulation pauses, and they can reload (the autosave is intact) or carry on. A problem that repeats, such as one
 * thrown every animation frame, is counted rather than shown again, so it can never flood the screen.
 */

export type ErrorKind = 'error' | 'rejection' | 'render';

export interface ErrorRecord {
  kind: ErrorKind;
  message: string;
  stack?: string;
  source?: string;
  first: number;
  last: number;
  count: number;
}

/** Browser noise that is not a fault in the game. */
const BENIGN = [/ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i];

export function describe(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: reason.message || reason.name || 'Error', stack: reason.stack };
  if (typeof reason === 'string') return { message: reason || 'Unknown error' };
  if (reason && typeof reason === 'object' && 'message' in reason && typeof (reason as { message: unknown }).message === 'string') {
    return { message: (reason as { message: string }).message || 'Unknown error' };
  }
  if (reason === undefined || reason === null) return { message: 'Unknown error' };
  try { return { message: JSON.stringify(reason) }; } catch { return { message: String(reason) }; }
}

export interface ReporterOptions {
  /** called once for each distinct problem the player should be told about */
  notify: (record: ErrorRecord) => void;
  log?: (...args: unknown[]) => void;
  now?: () => number;
  /** how many distinct problems to keep */
  keep?: number;
}

export class ErrorReporter {
  readonly records: ErrorRecord[] = [];
  private readonly notify: ReporterOptions['notify'];
  private readonly log: NonNullable<ReporterOptions['log']>;
  private readonly now: NonNullable<ReporterOptions['now']>;
  private readonly keep: number;

  constructor(o: ReporterOptions) {
    this.notify = o.notify;
    this.log = o.log ?? ((...a) => console.error(...a));
    this.now = o.now ?? (() => Date.now());
    this.keep = o.keep ?? 20;
  }

  /**
   * Record a problem. Returns the record, or null when it was benign browser noise.
   * `quiet` logs and records without telling the player (for a caller that shows its own screen).
   */
  report(kind: ErrorKind, reason: unknown, source?: string, quiet = false): ErrorRecord | null {
    const { message, stack } = describe(reason);
    if (BENIGN.some((re) => re.test(message))) return null;
    const t = this.now();
    const same = this.records.find((r) => r.kind === kind && r.message === message);
    if (same) {
      same.count++;
      same.last = t;
      // a repeating fault is still visible in the log, but sparsely: 10th, 100th, 1000th…
      if (Number.isInteger(Math.log10(same.count))) this.log(`[MONEY LINE] ${kind} repeated ${same.count} times: ${message}`);
      return same;
    }
    const rec: ErrorRecord = { kind, message, stack, source, first: t, last: t, count: 1 };
    this.records.push(rec);
    if (this.records.length > this.keep) this.records.shift();
    this.log(`[MONEY LINE] ${kind}: ${message}${source ? ` (${source})` : ''}`, reason);
    if (!quiet) {
      try { this.notify(rec); } catch (e) { this.log('[MONEY LINE] could not show the error message', e); }
    }
    return rec;
  }
}

/** Listen for uncaught errors and unhandled rejections on a window (or any event target, for tests). */
export function installErrorHandlers(target: EventTarget, reporter: ErrorReporter): () => void {
  const onError = (ev: Event) => {
    const e = ev as ErrorEvent;
    const where = e.filename ? `${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0}` : undefined;
    reporter.report('error', e.error ?? e.message, where);
  };
  const onRejection = (ev: Event) => reporter.report('rejection', (ev as PromiseRejectionEvent).reason);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => { target.removeEventListener('error', onError); target.removeEventListener('unhandledrejection', onRejection); };
}

/**
 * The player-facing message. Plain DOM, not React, so it still appears when the React tree itself has failed.
 * Styled by the game's stylesheet, with inline fallbacks in case the stylesheet is what failed to load.
 */
export function showErrorDialog(record: ErrorRecord, onDismiss: () => void): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ml-error')) return; // one message at a time; later problems are in the log
  const wrap = document.createElement('div');
  wrap.id = 'ml-error';
  wrap.className = 'modal';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:16px;background:rgba(18,36,28,.6)';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'alertdialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'ml-error-title');
  sheet.setAttribute('aria-describedby', 'ml-error-body');
  sheet.style.cssText = 'max-width:520px;background:#143327;color:#f4ead0;padding:24px;border-radius:8px;font-family:Archivo,Arial,sans-serif';
  const h = document.createElement('h2');
  h.id = 'ml-error-title';
  h.textContent = 'Something went wrong';
  const p = document.createElement('p');
  p.id = 'ml-error-body';
  p.textContent = 'The game hit an unexpected problem and has been paused. Your venture is saved automatically every 20 seconds, so reloading brings you back close to where you were.';
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = 'Details';
  const code = document.createElement('code');
  code.textContent = record.message;
  code.style.cssText = 'display:block;margin-top:8px;font-size:13px;white-space:pre-wrap;word-break:break-word';
  det.append(sum, code);
  const row = document.createElement('div');
  row.className = 'btnrow';
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'btn primary';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => location.reload());
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'btn';
  keep.textContent = 'Keep playing';
  keep.addEventListener('click', () => { wrap.remove(); onDismiss(); });
  for (const b of [reload, keep]) b.style.minHeight = '44px';
  row.append(reload, keep);
  sheet.append(h, p, det, row);
  wrap.append(sheet);
  document.body.append(wrap);
  reload.focus();
}
