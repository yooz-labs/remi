import { describe, expect, test } from 'bun:test';
import type {
  EngineModelCatalog,
  EngineProbe,
  ManagedModel,
} from '../../src/auto-approve/engine-models.ts';
import { persistModelInConfig, runModelCommand } from '../../src/cli/cmd-model.ts';
import { DEFAULT_CONFIG, type RemiConfig } from '../../src/config/config.ts';

/** Real config object with the yooz provider, as a fresh engine install has. */
function configWith(over: Partial<RemiConfig['auto_approve']> = {}): RemiConfig {
  return {
    ...DEFAULT_CONFIG,
    auto_approve: { ...DEFAULT_CONFIG.auto_approve, provider: 'yooz', ...over },
  } as RemiConfig;
}

function io(): {
  out: string[];
  err: string[];
  io: { out: (m: string) => void; err: (m: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (m) => out.push(m), err: (m) => err.push(m) } };
}

const REACHABLE: EngineProbe = {
  reachable: true,
  status: { loaded: true, modelId: 'yooz-quality-v3', state: 'ready' },
};

const INVENTORY: readonly ManagedModel[] = [
  {
    id: 'yooz-quality-v3',
    module: 'llm',
    displayName: 'Yooz-Quality',
    sizeBytes: 3_400_000_000,
    cached: true,
    loaded: true,
    isActive: true,
    deletable: false,
  },
  {
    id: 'yooz-light-v3',
    module: 'llm',
    displayName: 'Yooz-Light',
    sizeBytes: 800_000_000,
    cached: true,
    loaded: false,
    isActive: false,
    deletable: true,
  },
];

const CATALOG: EngineModelCatalog = {
  current: 'yooz-quality-v3',
  available: [
    {
      id: 'yooz-quality-v3',
      displayName: 'Yooz-Quality',
      sizeBytes: 2_400_000_000,
      loaded: true,
    },
    { id: 'yooz-light-v3', displayName: 'Yooz-Light', sizeBytes: 800_000_000, loaded: false },
  ],
};

describe('remi model — usage', () => {
  test('no verb prints usage and exits 2', async () => {
    const t = io();
    expect(await runModelCommand([], configWith(), t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('Usage: remi model');
  });

  test('an unknown verb names the valid ones', async () => {
    const t = io();
    expect(await runModelCommand(['frobnicate'], configWith(), t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('pull');
  });
});

describe('remi model — unreachable engine', () => {
  test('every verb explains that nothing is listening, and what it costs', async () => {
    // The #818 failure: without this, a missing engine shows up only as
    // auto-approve escalating everything with no explanation anywhere.
    for (const verb of ['ls', 'ps', 'status', 'pull', 'load', 'unload', 'use']) {
      const t = io();
      const code = await runModelCommand([verb, 'x'], configWith(), t.io, {
        probe: async (): Promise<EngineProbe> => ({ reachable: false, reason: 'ECONNREFUSED' }),
      });
      expect(code).toBe(1);
      expect(t.err.join('\n')).toContain('No LLM engine answering');
      expect(t.err.join('\n')).toContain('escalate');
    }
  });
});

describe('remi model ls / ps', () => {
  test('ls lists the DISK inventory with real footprints and marks the active model', async () => {
    const t = io();
    const code = await runModelCommand(['ls'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('3.4 GB'); // measured on-disk size, not an estimate
    expect(text).toContain('800 MB');
    expect(text).toContain('resident');
    expect(text).toMatch(/\*\s+yooz-quality-v3/); // active marker
  });

  test('ls distinguishes not-downloaded from on-disk', async () => {
    const t = io();
    await runModelCommand(['ls'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => [{ ...(INVENTORY[1] as ManagedModel), cached: false }],
    });

    expect(t.out.join('\n')).toContain('not downloaded');
  });

  test('ps shows only resident models', async () => {
    const t = io();
    await runModelCommand(['ps'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => CATALOG,
    });

    const text = t.out.join('\n');
    expect(text).toContain('yooz-quality-v3');
    expect(text).not.toContain('yooz-light-v3');
  });

  test('ps says so plainly when nothing is resident', async () => {
    const t = io();
    await runModelCommand(['ps'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () =>
        ({
          current: '',
          available: [{ ...CATALOG.available[0], loaded: false }],
        }) as EngineModelCatalog,
    });

    expect(t.out.join('\n')).toContain('No models resident');
  });
});

describe('remi model status', () => {
  test('reports the engine, the model, and an in-flight download', async () => {
    const t = io();
    const code = await runModelCommand(['status'], configWith(), t.io, {
      probe: async (): Promise<EngineProbe> => ({
        reachable: true,
        status: { loaded: false, modelId: 'yooz-light-v3', progress: 0.37, state: 'downloading' },
      }),
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('reachable');
    expect(text).toContain('yooz-light-v3');
    expect(text).toContain('37%');
  });

  test('surfaces a failed load rather than reporting a bare "not loaded"', async () => {
    const t = io();
    await runModelCommand(['status'], configWith(), t.io, {
      probe: async (): Promise<EngineProbe> => ({
        reachable: true,
        status: { loaded: false, state: 'failed', lastError: 'no space left on device' },
      }),
    });

    expect(t.out.join('\n')).toContain('no space left on device');
  });
});

describe('remi model pull', () => {
  test('reports progress, and is explicit that it does not change the active model', async () => {
    const t = io();
    const code = await runModelCommand(['pull', 'yooz-light-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      pull: async (_url, model, opts) => {
        opts?.onProgress?.({ fraction: 0.5, elapsedMs: 1000, advancing: true });
        // duplicate: must not double-print
        opts?.onProgress?.({ fraction: 0.5, elapsedMs: 1500, advancing: true });
        opts?.onProgress?.({ fraction: 1, elapsedMs: 2000, advancing: true });
        expect(model).toBe('yooz-light-v3');
      },
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('50%');
    expect(text).toContain('100%');
    expect(text.match(/50%/g)).toHaveLength(1); // deduped
    expect(text).toContain('is downloaded'); // downloading != making it active
    expect(text).toContain('does not change the active model');
  });

  test('defaults to the configured model when no id is given', async () => {
    const t = io();
    let pulled = '';
    await runModelCommand(['pull'], configWith({ model: 'configured-model' }), t.io, {
      probe: async () => REACHABLE,
      pull: async (_url, model) => {
        pulled = model;
      },
    });

    expect(pulled).toBe('configured-model');
  });

  test('a failed pull exits non-zero with the reason', async () => {
    const t = io();
    const code = await runModelCommand(['pull', 'm'], configWith(), t.io, {
      probe: async () => REACHABLE,
      pull: async () => {
        throw new Error('engine failed to load m: disk full');
      },
    });

    expect(code).toBe(1);
    expect(t.err.join('\n')).toContain('disk full');
  });
});

describe('remi model unload', () => {
  test('requires an explicit id: never guesses what to free', async () => {
    const t = io();
    expect(
      await runModelCommand(['unload'], configWith(), t.io, { probe: async () => REACHABLE }),
    ).toBe(2);
  });

  test('unloads the named model', async () => {
    const t = io();
    let unloaded = '';
    const code = await runModelCommand(['unload', 'yooz-quality-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      unload: async (_url, model) => {
        unloaded = model;
      },
    });

    expect(code).toBe(0);
    expect(unloaded).toBe('yooz-quality-v3');
  });
});

describe('remi model use', () => {
  test('persists the choice and tells the user it needs a restart', async () => {
    const t = io();
    let persisted = '';
    const code = await runModelCommand(['use', 'yooz-light-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => CATALOG,
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(0);
    expect(persisted).toBe('yooz-light-v3');
    expect(t.out.join('\n')).toContain('Restart');
  });

  test('refuses a model the engine does not know, listing what it does', async () => {
    const t = io();
    let persisted = '';
    const code = await runModelCommand(['use', 'not-a-model'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => CATALOG,
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(1);
    expect(persisted).toBe(''); // nothing written
    expect(t.err.join('\n')).toContain('yooz-quality-v3');
  });
});

describe('remi model rm', () => {
  test('deletes a deletable model and reports the disk reclaimed', async () => {
    const t = io();
    let removed = '';
    const code = await runModelCommand(['rm', 'yooz-light-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      remove: async (_url, id) => {
        removed = id;
        return { id, reclaimedBytes: 800_000_000 };
      },
    });

    expect(code).toBe(0);
    expect(removed).toBe('yooz-light-v3');
    expect(t.out.join('\n')).toContain('800 MB');
  });

  test('refuses to delete the ACTIVE model, and says how to switch first', async () => {
    const t = io();
    let removed = '';
    const code = await runModelCommand(['rm', 'yooz-quality-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      remove: async (_url, id) => {
        removed = id;
        return { id, reclaimedBytes: 0 };
      },
    });

    expect(code).toBe(1);
    expect(removed).toBe(''); // never called
    expect(t.err.join('\n')).toContain('remi model use');
  });

  test('requires an explicit id', async () => {
    const t = io();
    expect(
      await runModelCommand(['rm'], configWith(), t.io, { probe: async () => REACHABLE }),
    ).toBe(2);
  });
});

describe('remi model cleanup / cancel', () => {
  test('cleanup reports the total reclaimed', async () => {
    const t = io();
    const code = await runModelCommand(['cleanup'], configWith(), t.io, {
      probe: async () => REACHABLE,
      cleanup: async () => ({
        totalReclaimedBytes: 1_200_000_000,
        perRepo: { 'models--a--b': 1_200_000_000 },
      }),
    });

    expect(code).toBe(0);
    expect(t.out.join('\n')).toContain('1.2 GB');
  });

  test('cancel aborts the named download', async () => {
    const t = io();
    let cancelled = '';
    const code = await runModelCommand(['cancel', 'yooz-light-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      cancel: async (_url, id) => {
        cancelled = id;
      },
    });

    expect(code).toBe(0);
    expect(cancelled).toBe('yooz-light-v3');
  });
});

describe('remi model pull — flat-fraction rendering (engine#292/#293)', () => {
  test('never prints a percentage while the fraction is not advancing', async () => {
    // Both remi LLM tiers are single-big-file repos, so the engine's fraction
    // steps ~0.6% and sits. A percentage there reads as a wedged download.
    const t = io();
    await runModelCommand(['pull', 'yooz-quality-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      pull: async (_url, _model, opts) => {
        opts?.onProgress?.({
          fraction: 0.0058,
          sizeBytes: 3_400_000_000,
          elapsedMs: 0,
          advancing: false,
        });
        opts?.onProgress?.({
          fraction: 0.0058,
          sizeBytes: 3_400_000_000,
          elapsedMs: 30_000,
          advancing: false,
        });
      },
    });

    const text = t.out.join('\n');
    expect(text).not.toMatch(/\d+%/); // no misleading percentage anywhere
    expect(text).toContain('3.4 GB'); // the honest thing we do know
    expect(text).toContain('elapsed');
  });

  test('heartbeats rather than printing on every poll', async () => {
    const t = io();
    await runModelCommand(['pull', 'm'], configWith(), t.io, {
      probe: async () => REACHABLE,
      pull: async (_url, _model, opts) => {
        // Ten polls one second apart: a line every poll would be log spam.
        for (let i = 0; i < 10; i++) {
          opts?.onProgress?.({ elapsedMs: i * 1000, advancing: false });
        }
      },
    });

    const lines = t.out.filter((l) => l.includes('downloading'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(4); // heartbeat, not per-poll
  });
});

describe('remi model — shared-engine ownership boundary (#818)', () => {
  const shared = () => configWith({ engine: 'shared' as const });

  test('refuses every MUTATING verb, without even probing', async () => {
    // A super-yooz host owns residency and disk; another module may be
    // mid-generate on these weights.
    for (const verb of ['pull', 'cancel', 'rm', 'cleanup', 'unload']) {
      const t = io();
      let probed = false;
      const code = await runModelCommand([verb, 'some-model'], shared(), t.io, {
        probe: async () => {
          probed = true;
          return REACHABLE;
        },
      });
      expect(code).toBe(1);
      expect(probed).toBe(false);
      expect(t.err.join('\n')).toContain('shared engine');
    }
  });

  test('READ-ONLY verbs still work against a shared engine', async () => {
    const t = io();
    const code = await runModelCommand(['ls'], shared(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
    });

    expect(code).toBe(0);
    expect(t.out.join('\n')).toContain('yooz-quality-v3');
  });

  test('status names which mode this remi is in', async () => {
    const t = io();
    await runModelCommand(['status'], shared(), t.io, { probe: async () => REACHABLE });

    expect(t.out.join('\n')).toContain('shared');
  });
});

describe('persistModelInConfig — REAL filesystem (no seam)', () => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');

  function tmpConfig(contents?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cfg-'));
    const file = path.join(dir, 'config.toml');
    if (contents !== undefined) fs.writeFileSync(file, contents);
    return file;
  }

  test('creates a minimal config when none exists', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cfg-')), 'config.toml');

    persistModelInConfig('yooz-light-v3', file);

    expect(fs.readFileSync(file, 'utf-8')).toContain('[auto_approve]');
    expect(fs.readFileSync(file, 'utf-8')).toContain('model = "yooz-light-v3"');
  });

  test('replaces the key IN PLACE, preserving every surrounding comment', () => {
    const file = tmpConfig(
      ['# my notes', '[auto_approve]', '# a comment', 'model = "old"', 'timeout = 30', ''].join(
        '\n',
      ),
    );

    persistModelInConfig('new-model', file);

    const out = fs.readFileSync(file, 'utf-8');
    expect(out).toContain('# my notes');
    expect(out).toContain('# a comment');
    expect(out).toContain('timeout = 30');
    expect(out).toContain('model = "new-model"');
    expect(out).not.toContain('"old"');
  });

  test('NEVER touches a model key belonging to a different section', () => {
    // The unscoped regex this replaced would have rewritten the [stt] key.
    const file = tmpConfig(
      ['[stt]', 'model = "parakeet"', '', '[auto_approve]', 'model = "old"', ''].join('\n'),
    );

    persistModelInConfig('new-model', file);

    const out = fs.readFileSync(file, 'utf-8');
    expect(out).toContain('model = "parakeet"'); // untouched
    expect(out).toContain('model = "new-model"');
  });

  test('a fresh install (commented-out template) gets one live section, not two', () => {
    const file = tmpConfig(['# [auto_approve]', '# model = "yooz-quality-v3"', ''].join('\n'));

    persistModelInConfig('first-choice', file);
    persistModelInConfig('second-choice', file);

    const out = fs.readFileSync(file, 'utf-8');
    expect(out.match(/^\[auto_approve\]$/gm)).toHaveLength(1); // exactly one live section
    expect(out).toContain('model = "second-choice"');
    expect(out).not.toContain('model = "first-choice"');
    expect(out).toContain('# [auto_approve]'); // template comment survives
  });

  test('inserts the key under a live header that has none', () => {
    const file = tmpConfig(['[auto_approve]', 'timeout = 30', ''].join('\n'));

    persistModelInConfig('inserted', file);

    const out = fs.readFileSync(file, 'utf-8');
    expect(out).toContain('model = "inserted"');
    expect(out).toContain('timeout = 30');
  });

  test('an id containing $& is written literally, not expanded', () => {
    // String.replace would have injected the matched text here.
    const file = tmpConfig(['[auto_approve]', 'model = "old"', ''].join('\n'));

    persistModelInConfig('weird$&id', file);

    expect(fs.readFileSync(file, 'utf-8')).toContain('model = "weird$&id"');
  });
});

describe('remi model ls — inventory display (found by live engine run)', () => {
  const OTHER: ManagedModel[] = Array.from({ length: 5 }, (_, i) => ({
    id: `models--Qwen--Some-Very-Long-Repo-Name-${i}`,
    module: 'stt',
    displayName: 'stt thing',
    sizeBytes: 0,
    cached: true,
    loaded: false,
    isActive: false,
    deletable: true,
  }));

  test('shows only LLM models by default and says what it hid', async () => {
    // A live engine returned 69 rows, 67 of them STT hub directories. Burying
    // the two useful rows in that is not a listing.
    const t = io();
    await runModelCommand(['ls'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => [...INVENTORY, ...OTHER],
    });

    const text = t.out.join('\n');
    expect(text).toContain('yooz-quality-v3');
    expect(text).not.toContain('models--Qwen');
    expect(text).toContain('5 model(s) from other modules hidden');
  });

  test('--all shows every module', async () => {
    const t = io();
    await runModelCommand(['ls', '--all'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => [...INVENTORY, ...OTHER],
    });

    const text = t.out.join('\n');
    expect(text).toContain('models--Qwen');
    expect(text).not.toContain('hidden');
  });

  test('a size the engine could not measure reads as unknown, not "0 MB"', async () => {
    const t = io();
    await runModelCommand(['ls', '--all'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => OTHER,
    });

    expect(t.out.join('\n')).not.toContain('0 MB');
  });

  test('a long id does not break the columns', async () => {
    const t = io();
    await runModelCommand(['ls', '--all'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => OTHER,
    });

    // Every row keeps the module column at the same offset.
    const rows = t.out.filter((l) => l.includes('stt'));
    const offsets = new Set(rows.map((r) => r.indexOf('stt')));
    expect(offsets.size).toBe(1);
  });
});
