import { describe, expect, test } from 'bun:test';
import { fileActivityRecord } from '../../src/auto-approve/engine-activity.ts';
import { ClearCacheUnsupportedError } from '../../src/auto-approve/engine-models.ts';
import { ModelResidency } from '../../src/auto-approve/model-residency.ts';

/**
 * Collects unload/clear-cache calls and log lines from a real ModelResidency
 * (no mocks; both timers are driven through the injected seam so nothing
 * waits). `setTimer` dispatches by the requested delay: as long as a test's
 * `cacheIdleMs` and `keepAliveMs` are distinct (the default pairing already
 * is: 500 vs 1000), the two timers never collide in the harness's tracking.
 */
function harness(
  over: Partial<ConstructorParameters<typeof ModelResidency>[0]> = {},
  opts: {
    unloadThrows?: string;
    clearCacheThrows?: unknown;
    clearCacheReturns?: readonly string[];
  } = {},
) {
  const config = {
    keepAliveMs: 1000,
    cacheIdleMs: 0, // stage 1 disabled unless a test opts in
    models: ['model-a'],
    ownsEngine: true,
    ...over,
  };
  const unloaded: string[] = [];
  const cacheCleared: Array<readonly string[]> = [];
  const logs: string[] = [];
  let unloadFire: (() => void) | undefined;
  let cacheFire: (() => void) | undefined;
  const residency = new ModelResidency(config, {
    unload: async (m) => {
      if (opts.unloadThrows) throw new Error(opts.unloadThrows);
      unloaded.push(m);
    },
    clearCache: async () => {
      if (opts.clearCacheThrows !== undefined) throw opts.clearCacheThrows;
      const cleared = opts.clearCacheReturns ?? config.models;
      cacheCleared.push(cleared);
      return cleared;
    },
    log: (m) => logs.push(m),
    setTimer: (fn, ms) => {
      if (ms === config.keepAliveMs) unloadFire = fn;
      else if (ms === config.cacheIdleMs) cacheFire = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      // hasArmed*ForTest() reads the instance's own private field (nulled by
      // the class itself on stop()/re-arm), not this seam, so there is
      // nothing this mock needs to track.
    },
  });
  return {
    residency,
    unloaded,
    cacheCleared,
    logs,
    fireUnloadTimer: () => unloadFire?.(),
    fireCacheTimer: () => cacheFire?.(),
  };
}

describe('ModelResidency stage 2 (unload, #820)', () => {
  test('unloads every model remi loaded once the idle window elapses', async () => {
    const h = harness({ models: ['model-a', 'escalate-b'] });
    h.residency.noteActivity();
    expect(h.residency.hasArmedTimerForTest()).toBe(true);

    h.fireUnloadTimer();
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

    expect(() => h.fireUnloadTimer()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.logs.join('\n')).toContain('engine restarted');
    // And it does not give up for the whole idle window: a transient failure
    // would otherwise leave the weights pinned overnight with one log line.
    expect(h.logs.join('\n')).toContain('retrying once');
  });

  test('one failing model does not skip the others', async () => {
    const unloaded: string[] = [];
    const logs: string[] = [];
    let fire: (() => void) | undefined;
    const residency = new ModelResidency(
      { keepAliveMs: 1000, cacheIdleMs: 0, models: ['bad', 'good'], ownsEngine: true },
      {
        unload: async (m) => {
          if (m === 'bad') throw new Error('nope');
          unloaded.push(m);
        },
        clearCache: async () => [],
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

    h.fireUnloadTimer();
    await Promise.resolve();
    await Promise.resolve();
    h.fireUnloadTimer();
    await Promise.resolve();

    expect(h.unloaded).toEqual(['model-a']);
  });
});

describe('ModelResidency stage 2 — failure retry and mid-unload activity', () => {
  test('retries once after a failed unload, then stops', async () => {
    let attempts = 0;
    let fire: (() => void) | undefined;
    const logs: string[] = [];
    const residency = new ModelResidency(
      { keepAliveMs: 1000, cacheIdleMs: 0, models: ['m'], ownsEngine: true },
      {
        unload: async () => {
          attempts++;
          throw new Error('engine mid-restart');
        },
        clearCache: async () => [],
        log: (m) => logs.push(m),
        setTimer: (fn) => {
          fire = fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {},
      },
    );
    residency.noteActivity();

    fire?.(); // first attempt fails, re-arms
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    fire?.(); // retry, also fails
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    fire?.(); // must NOT try a third time
    await Promise.resolve();
    await Promise.resolve();

    expect(attempts).toBe(2);
  });

  test('an evaluation arriving mid-unload aborts the remaining unloads', async () => {
    // The unload loop is a sequence of awaited HTTP calls; a new eval landing
    // in the middle must not have its model freed underneath it.
    const unloaded: string[] = [];
    let fire: (() => void) | undefined;
    // Holder so the unload callback can reach the instance it belongs to.
    const self: { residency?: ModelResidency } = {};
    const residency = new ModelResidency(
      { keepAliveMs: 1000, cacheIdleMs: 0, models: ['first', 'second'], ownsEngine: true },
      {
        unload: async (m) => {
          unloaded.push(m);
          // A permission arrives while we are freeing the first model.
          if (m === 'first') self.residency?.noteActivity();
        },
        clearCache: async () => [],
        log: () => {},
        setTimer: (fn) => {
          fire = fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {},
      },
    );
    self.residency = residency;
    residency.noteActivity();

    fire?.();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(unloaded).toEqual(['first']); // 'second' was spared
  });
});

describe('ModelResidency stage 1 (cache-drop, #820)', () => {
  test('drops the cache without unloading once cache_idle elapses', async () => {
    const h = harness({ cacheIdleMs: 500, keepAliveMs: 1000 });
    h.residency.noteActivity();
    expect(h.residency.hasArmedCacheTimerForTest()).toBe(true);

    h.fireCacheTimer();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.cacheCleared).toEqual([['model-a']]);
    expect(h.unloaded).toEqual([]); // weights untouched
    expect(h.logs.join('\n')).toContain('cache_idle');
  });

  test('stage 2 still unloads afterwards, on the same activity', async () => {
    const h = harness({ cacheIdleMs: 500, keepAliveMs: 1000 });
    h.residency.noteActivity();

    h.fireCacheTimer();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.cacheCleared).toHaveLength(1);
    expect(h.unloaded).toEqual([]);

    h.fireUnloadTimer();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.unloaded).toEqual(['model-a']);
  });

  test('activity between the two stages resets both deadlines', async () => {
    const h = harness({ cacheIdleMs: 500, keepAliveMs: 1000 });
    h.residency.noteActivity();

    h.fireCacheTimer();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.cacheCleared).toHaveLength(1);

    // New activity before stage 2 ever fires.
    h.residency.noteActivity();

    expect(h.residency.hasArmedTimerForTest()).toBe(true);
    expect(h.residency.hasArmedCacheTimerForTest()).toBe(true);
    expect(h.unloaded).toEqual([]);
  });

  test('cache_idle = 0 disables stage 1 only; stage 2 is unaffected', async () => {
    const h = harness({ cacheIdleMs: 0, keepAliveMs: 1000 });
    h.residency.noteActivity();

    expect(h.residency.cacheStageEnabled).toBe(false);
    expect(h.residency.hasArmedCacheTimerForTest()).toBe(false);
    expect(h.residency.hasArmedTimerForTest()).toBe(true);

    h.fireUnloadTimer();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.unloaded).toEqual(['model-a']);
  });

  test('NEVER arms either stage under a shared engine (#818)', () => {
    const h = harness({ ownsEngine: false, cacheIdleMs: 500 });
    h.residency.noteActivity();

    expect(h.residency.enabled).toBe(false);
    expect(h.residency.cacheStageEnabled).toBe(false);
    expect(h.residency.hasArmedTimerForTest()).toBe(false);
    expect(h.residency.hasArmedCacheTimerForTest()).toBe(false);
  });

  test('stop() cancels stage 1 without clearing (another daemon may still want it)', () => {
    const h = harness({ cacheIdleMs: 500 });
    h.residency.noteActivity();

    h.residency.stop();

    expect(h.residency.hasArmedCacheTimerForTest()).toBe(false);
    expect(h.residency.hasArmedTimerForTest()).toBe(false);
    expect(h.cacheCleared).toEqual([]);
  });

  test('a 404 degrades gracefully, logs ONCE, and stage 2 keeps working', async () => {
    const h = harness(
      { cacheIdleMs: 500, keepAliveMs: 1000 },
      {
        clearCacheThrows: new ClearCacheUnsupportedError(
          '/v1/llm/clear-cache failed 404: not found',
        ),
      },
    );
    h.residency.noteActivity();

    expect(() => h.fireCacheTimer()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    const unsupportedLogs = h.logs.filter((l) => l.includes('does not support cache-clear'));
    expect(unsupportedLogs).toHaveLength(1);
    expect(h.residency.cacheStageEnabled).toBe(false);

    // A later activity/idle-window pair must not re-arm stage 1 or log again.
    h.residency.noteActivity();
    expect(h.residency.hasArmedCacheTimerForTest()).toBe(false);
    expect(h.logs.filter((l) => l.includes('does not support cache-clear'))).toHaveLength(1);

    // Stage 2 (unload) is a completely separate timer and must be unaffected.
    expect(h.residency.hasArmedTimerForTest()).toBe(true);
    h.fireUnloadTimer();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.unloaded).toEqual(['model-a']);
  });

  test('a 501 degrades the same way as a 404', async () => {
    const h = harness(
      { cacheIdleMs: 500 },
      { clearCacheThrows: new ClearCacheUnsupportedError('/v1/llm/clear-cache failed 501: nope') },
    );
    h.residency.noteActivity();

    h.fireCacheTimer();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.residency.cacheStageEnabled).toBe(false);
    expect(h.logs.filter((l) => l.includes('does not support cache-clear'))).toHaveLength(1);
  });

  test('noteEngineChanged re-enables stage 1 after an engine upgrade (#826)', async () => {
    // `cacheUnsupported` is a fact about an engine PROCESS, stored on a daemon
    // that outlives it. Once EngineHost can start engines mid-life, a user
    // upgrading the engine under a long-running daemon is ordinary, and without
    // this the daemon would keep ~1.5 GB of prompt KV resident until restart.
    const h = harness(
      { cacheIdleMs: 500 },
      { clearCacheThrows: new ClearCacheUnsupportedError('/v1/llm/clear-cache failed 404: nope') },
    );
    h.residency.noteActivity();
    h.fireCacheTimer();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.residency.cacheStageEnabled).toBe(false);

    h.residency.noteEngineChanged();

    expect(h.residency.cacheStageEnabled).toBe(true);
    expect(h.logs.join('\n')).toContain('New engine detected');
  });

  test('noteEngineChanged is silent when stage 1 was never degraded', async () => {
    // It runs on every spawn, including the ordinary first one at boot, so it
    // must not narrate a recovery that did not happen.
    const h = harness({ cacheIdleMs: 500 });
    h.residency.noteEngineChanged();
    expect(h.residency.cacheStageEnabled).toBe(true);
    expect(h.logs.join('\n')).not.toContain('New engine detected');
  });

  test('a transient clear-cache failure is logged and never thrown out of the timer callback', async () => {
    const h = harness({ cacheIdleMs: 500 }, { clearCacheThrows: new Error('engine restarted') });
    h.residency.noteActivity();

    expect(() => h.fireCacheTimer()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.logs.join('\n')).toContain('engine restarted');
    expect(h.logs.join('\n')).toContain('retrying once');
    // A transient failure is not "unsupported" -- stage 1 must stay armable.
    expect(h.residency.cacheStageEnabled).toBe(true);
  });
});

describe('ModelResidency stage 1 — failure retry and mid-clear activity', () => {
  test('retries stage 1 once after a transient failure, then stops', async () => {
    let attempts = 0;
    let cacheFire: (() => void) | undefined;
    const logs: string[] = [];
    const residency = new ModelResidency(
      { keepAliveMs: 1000, cacheIdleMs: 500, models: ['m'], ownsEngine: true },
      {
        unload: async () => {},
        clearCache: async () => {
          attempts++;
          throw new Error('engine mid-restart');
        },
        log: (m) => logs.push(m),
        setTimer: (fn, ms) => {
          if (ms === 500) cacheFire = fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {},
      },
    );
    residency.noteActivity();

    cacheFire?.(); // first attempt fails, re-arms
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    cacheFire?.(); // retry, also fails
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    cacheFire?.(); // must NOT try a third time
    await Promise.resolve();
    await Promise.resolve();

    expect(attempts).toBe(2);
  });

  test('an evaluation arriving mid-clear is reported, not claimed as a clean window', async () => {
    const logs: string[] = [];
    let cacheFire: (() => void) | undefined;
    const self: { residency?: ModelResidency } = {};
    const residency = new ModelResidency(
      { keepAliveMs: 1000, cacheIdleMs: 500, models: ['m'], ownsEngine: true },
      {
        unload: async () => {},
        clearCache: async () => {
          // A permission arrives while the HTTP call is in flight.
          self.residency?.noteActivity();
          return ['m'];
        },
        log: (m) => logs.push(m),
        setTimer: (fn, ms) => {
          if (ms === 500) cacheFire = fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {},
      },
    );
    self.residency = residency;
    residency.noteActivity();

    cacheFire?.();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(logs.join('\n')).toContain('cache_idle clear finished after an evaluation started');
  });
});

describe('ModelResidency — machine-wide coordination (#818)', () => {
  function withActivity(sinceMs: number | null) {
    const unloaded: string[] = [];
    const cacheCleared: number[] = [];
    const touches: number[] = [];
    let unloadFire: (() => void) | undefined;
    let cacheFire: (() => void) | undefined;
    let unloadArmCount = 0;
    let cacheArmCount = 0;
    const residency = new ModelResidency(
      { keepAliveMs: 1000, cacheIdleMs: 500, models: ['m'], ownsEngine: true },
      {
        unload: async (model) => {
          unloaded.push(model);
        },
        clearCache: async () => {
          cacheCleared.push(1);
          return ['m'];
        },
        log: () => {},
        activity: {
          touch: () => touches.push(1),
          sinceLastMs: () => sinceMs,
        },
        setTimer: (fn, ms) => {
          if (ms === 1000) {
            unloadArmCount++;
            unloadFire = fn;
          } else if (ms === 500) {
            cacheArmCount++;
            cacheFire = fn;
          }
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {},
      },
    );
    return {
      residency,
      unloaded,
      cacheCleared,
      touches,
      fireUnload: () => unloadFire?.(),
      fireCache: () => cacheFire?.(),
      unloadArmCount: () => unloadArmCount,
      cacheArmCount: () => cacheArmCount,
    };
  }

  test('does NOT unload when another daemon evaluated recently', async () => {
    // Ten sessions share one engine; the first to idle must not evict weights
    // the other nine are using.
    const h = withActivity(200); // machine active 200ms ago, window is 1000ms
    h.residency.noteActivity();
    const armsBefore = h.unloadArmCount();

    h.fireUnload();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.unloaded).toEqual([]);
    expect(h.unloadArmCount()).toBeGreaterThan(armsBefore); // re-armed, not given up
  });

  test('does NOT clear the cache when another daemon evaluated recently', async () => {
    const h = withActivity(200); // machine active 200ms ago, cache window is 500ms
    h.residency.noteActivity();
    const armsBefore = h.cacheArmCount();

    h.fireCache();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.cacheCleared).toEqual([]);
    expect(h.cacheArmCount()).toBeGreaterThan(armsBefore); // re-armed, not given up
  });

  test('unloads when the whole MACHINE has been idle past the window', async () => {
    const h = withActivity(5000); // nobody has evaluated in 5s
    h.residency.noteActivity();

    h.fireUnload();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.unloaded).toEqual(['m']);
  });

  test('clears the cache when the whole MACHINE has been idle past the window', async () => {
    const h = withActivity(5000);
    h.residency.noteActivity();

    h.fireCache();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.cacheCleared).toEqual([1]);
  });

  test('an unreadable record never pins weights or cache forever', async () => {
    // A missing or broken activity file must degrade to acting, not to
    // "wait forever because we cannot prove the machine is idle".
    const h = withActivity(null);
    h.residency.noteActivity();

    h.fireCache();
    h.fireUnload();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.cacheCleared).toEqual([1]);
    expect(h.unloaded).toEqual(['m']);
  });

  test('every evaluation records machine-wide activity', () => {
    const h = withActivity(5000);

    h.residency.noteActivity();
    h.residency.noteActivity();

    expect(h.touches).toHaveLength(2);
  });
});

describe('fileActivityRecord — real filesystem', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');

  test('touch then read reports a fresh elapsed time', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-act-')), 'engine-activity');
    const record = fileActivityRecord(file);

    record.touch();

    const since = record.sinceLastMs();
    expect(since).not.toBeNull();
    expect(since ?? Number.POSITIVE_INFINITY).toBeLessThan(5_000);
  });

  test('a missing record reads as null, never as "just now"', () => {
    const file = path.join(os.tmpdir(), `remi-act-missing-${process.pid}`, 'engine-activity');

    expect(fileActivityRecord(file).sinceLastMs()).toBeNull();
  });

  test('an unwritable path degrades silently instead of throwing into an eval', () => {
    // /dev/null/... can never be created; touch must swallow it.
    const record = fileActivityRecord('/dev/null/nope/engine-activity');

    expect(() => record.touch()).not.toThrow();
  });
});
