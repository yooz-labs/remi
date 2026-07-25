import { describe, expect, test } from 'bun:test';
import { ModelResidency } from '../../src/auto-approve/model-residency.ts';

/** Collects unload calls and log lines from a real ModelResidency (no mocks;
 *  the timer is driven through the injected seam so nothing waits). */
function harness(
  over: Partial<ConstructorParameters<typeof ModelResidency>[0]> = {},
  opts: { unloadThrows?: string } = {},
) {
  const unloaded: string[] = [];
  const logs: string[] = [];
  let fire: (() => void) | undefined;
  const residency = new ModelResidency(
    { keepAliveMs: 1000, models: ['model-a'], ownsEngine: true, ...over },
    {
      unload: async (m) => {
        if (opts.unloadThrows) throw new Error(opts.unloadThrows);
        unloaded.push(m);
      },
      log: (m) => logs.push(m),
      setTimer: (fn) => {
        fire = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        fire = undefined;
      },
    },
  );
  return { residency, unloaded, logs, fireTimer: () => fire?.() };
}

describe('ModelResidency (#820)', () => {
  test('unloads every model remi loaded once the idle window elapses', async () => {
    const h = harness({ models: ['model-a', 'escalate-b'] });
    h.residency.noteActivity();
    expect(h.residency.hasArmedTimerForTest()).toBe(true);

    h.fireTimer();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.unloaded).toEqual(['model-a', 'escalate-b']);
    expect(h.logs.join('\n')).toContain('keep_alive');
  });

  test('activity re-arms the timer, so a busy daemon never unloads', () => {
    const h = harness();
    h.residency.noteActivity();
    h.residency.noteActivity();
    h.residency.noteActivity();

    // Still armed and nothing unloaded: only the LAST window can fire.
    expect(h.residency.hasArmedTimerForTest()).toBe(true);
    expect(h.unloaded).toEqual([]);
  });

  test('NEVER arms under a shared engine: residency is the host policy there', () => {
    // #818: another super-yooz module may be mid-generate on these weights.
    const h = harness({ ownsEngine: false });
    h.residency.noteActivity();

    expect(h.residency.enabled).toBe(false);
    expect(h.residency.hasArmedTimerForTest()).toBe(false);
  });

  test('keep_alive = 0 means never unload', () => {
    const h = harness({ keepAliveMs: 0 });
    h.residency.noteActivity();

    expect(h.residency.enabled).toBe(false);
    expect(h.residency.hasArmedTimerForTest()).toBe(false);
  });

  test('stop() cancels without unloading (another daemon may still want it)', () => {
    const h = harness();
    h.residency.noteActivity();

    h.residency.stop();

    expect(h.residency.hasArmedTimerForTest()).toBe(false);
    expect(h.unloaded).toEqual([]);
  });

  test('a failed unload is logged and never thrown out of the timer callback', async () => {
    const h = harness({ models: ['model-a'] }, { unloadThrows: 'engine restarted' });
    h.residency.noteActivity();

    expect(() => h.fireTimer()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.logs.join('\n')).toContain('engine restarted');
    expect(h.logs.join('\n')).toContain('stays resident');
  });

  test('one failing model does not skip the others', async () => {
    const unloaded: string[] = [];
    const logs: string[] = [];
    let fire: (() => void) | undefined;
    const residency = new ModelResidency(
      { keepAliveMs: 1000, models: ['bad', 'good'], ownsEngine: true },
      {
        unload: async (m) => {
          if (m === 'bad') throw new Error('nope');
          unloaded.push(m);
        },
        log: (m) => logs.push(m),
        setTimer: (fn) => {
          fire = fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {},
      },
    );
    residency.noteActivity();

    fire?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(unloaded).toEqual(['good']);
  });

  test('a second fire without new activity does not re-unload', async () => {
    const h = harness();
    h.residency.noteActivity();

    h.fireTimer();
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimer();
    await Promise.resolve();

    expect(h.unloaded).toEqual(['model-a']);
  });
});
