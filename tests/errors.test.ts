import { describe as suite, expect, it } from 'vitest';
import { ErrorReporter, describe, installErrorHandlers, type ErrorRecord } from '../src/ui/errors';

function setup() {
  const shown: ErrorRecord[] = [];
  const logged: unknown[][] = [];
  let t = 1000;
  const r = new ErrorReporter({ notify: (rec) => shown.push(rec), log: (...a) => logged.push(a), now: () => t++ });
  return { r, shown, logged };
}

suite('global error handling', () => {
  it('describes any thrown value as a readable message', () => {
    expect(describe(new Error('boom')).message).toBe('boom');
    expect(describe(new TypeError('x is undefined')).stack).toContain('TypeError');
    expect(describe('plain text').message).toBe('plain text');
    expect(describe({ message: 'from an object' }).message).toBe('from an object');
    expect(describe(undefined).message).toBe('Unknown error');
    expect(describe(null).message).toBe('Unknown error');
    expect(describe({ code: 7 }).message).toBe('{"code":7}');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(describe(cyclic).message).toBe('[object Object]');
  });

  it('logs, records and tells the player about a new problem', () => {
    const { r, shown, logged } = setup();
    const rec = r.report('error', new Error('frame failed'), 'world.ts:12:4');
    expect(rec?.count).toBe(1);
    expect(shown).toHaveLength(1);
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain('[MONEY LINE] error: frame failed (world.ts:12:4)');
    expect(r.records).toHaveLength(1);
  });

  it('counts a repeating fault instead of showing it again, and logs it only sparsely', () => {
    const { r, shown, logged } = setup();
    for (let i = 0; i < 1000; i++) r.report('error', new Error('every frame'));
    expect(shown).toHaveLength(1);
    expect(r.records).toHaveLength(1);
    expect(r.records[0].count).toBe(1000);
    // first occurrence, then the 10th, 100th and 1000th
    expect(logged).toHaveLength(4);
    expect(r.records[0].last).toBeGreaterThan(r.records[0].first);
  });

  it('treats a different message or kind as a different problem', () => {
    const { r, shown } = setup();
    r.report('error', new Error('a'));
    r.report('error', new Error('b'));
    r.report('rejection', new Error('a'));
    expect(shown).toHaveLength(3);
  });

  it('ignores benign browser noise', () => {
    const { r, shown, logged } = setup();
    expect(r.report('error', 'ResizeObserver loop completed with undelivered notifications.')).toBeNull();
    expect(r.report('error', 'ResizeObserver loop limit exceeded')).toBeNull();
    expect(shown).toHaveLength(0);
    expect(logged).toHaveLength(0);
  });

  it('can log quietly for a caller that shows its own screen', () => {
    const { r, shown, logged } = setup();
    r.report('render', new Error('tree failed'), undefined, true);
    expect(shown).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(r.records[0].kind).toBe('render');
  });

  it('keeps only the most recent distinct problems', () => {
    const { r } = setup();
    for (let i = 0; i < 30; i++) r.report('error', new Error(`p${i}`));
    expect(r.records).toHaveLength(20);
    expect(r.records[0].message).toBe('p10');
  });

  it('still logs when showing the message itself fails', () => {
    const logged: unknown[][] = [];
    const r = new ErrorReporter({ notify: () => { throw new Error('no document'); }, log: (...a) => logged.push(a) });
    expect(() => r.report('error', new Error('x'))).not.toThrow();
    expect(logged.map((l) => String(l[0]))).toEqual(['[MONEY LINE] error: x', '[MONEY LINE] could not show the error message']);
  });

  it('catches uncaught errors and unhandled rejections from the window', () => {
    const { r, shown } = setup();
    const target = new EventTarget();
    const remove = installErrorHandlers(target, r);
    const err = Object.assign(new Event('error'), { error: new Error('uncaught'), message: 'uncaught', filename: 'main.js', lineno: 3, colno: 9 });
    target.dispatchEvent(err);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('rejected') }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'a string reason' }));
    expect(shown.map((s) => [s.kind, s.message])).toEqual([['error', 'uncaught'], ['rejection', 'rejected'], ['rejection', 'a string reason']]);
    expect(shown[0].source).toBe('main.js:3:9');
    remove();
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('after removal') }));
    expect(shown).toHaveLength(3);
  });

  it('uses the event message when an error event carries no error object', () => {
    const { r, shown } = setup();
    const target = new EventTarget();
    installErrorHandlers(target, r);
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.' }));
    expect(shown[0].message).toBe('Script error.');
    expect(shown[0].source).toBeUndefined();
  });
});
