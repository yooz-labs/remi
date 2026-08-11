import { describe, expect, test } from 'bun:test';
import { isOlderThanPinned } from '../../src/auto-approve/engine-install.ts';
import type {
  EngineModelCatalog,
  EngineProbe,
  ManagedModel,
} from '../../src/auto-approve/engine-models.ts';
import {
  type ModelCommandDeps,
  type ModelCommandIO,
  persistModelInConfig,
  runModelCommand,
} from '../../src/cli/cmd-model.ts';
import { DEFAULT_CONFIG, type RemiConfig } from '../../src/config/config.ts';

/**
 * Every test goes through this rather than calling `runModelCommand` directly,
 * so the engine-START seam is injected BY CONSTRUCTION.
 *
 * The real one downloads a helper into `~/.remi`, spawns a detached process
 * and claims the machine-wide engine pidfile — none of which a unit test can
 * undo. Writing the injection out at each call site means one forgotten line
 * does all three against the developer's own machine; it did, during this
 * change. (`ensureEngineViaHost` also refuses to run under the test runner,
 * which is the backstop for exactly that slip.)
 *
 * A test that wants to observe the start attempt passes its own `ensureEngine`.
 */
function run(
  args: readonly string[],
  config: RemiConfig,
  cmdIo: ModelCommandIO,
  deps: ModelCommandDeps = {},
): Promise<number> {
  return runModelCommand(args, config, cmdIo, { ensureEngine: async () => false, ...deps });
}

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
    expect(await run([], configWith(), t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('Usage: remi model');
  });

  test('an unknown verb names the valid ones', async () => {
    const t = io();
    expect(await run(['frobnicate'], configWith(), t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('pull');
  });
});

describe('remi model — unreachable engine', () => {
  test('every engine-backed verb explains that nothing is listening, and what it costs', async () => {
    // The #818 failure: without this, a missing engine shows up only as
    // auto-approve escalating everything with no explanation anywhere.
    // `status` and `use` are excluded deliberately — see their own tests: one
    // REPORTS this state rather than failing on it, the other never needed an
    // engine at all (#843).
    for (const verb of ['ls', 'ps', 'pull', 'load', 'unload']) {
      const t = io();
      const code = await run([verb, 'x'], configWith(), t.io, {
        probe: async (): Promise<EngineProbe> => ({ reachable: false, reason: 'ECONNREFUSED' }),
      });
      expect(code).toBe(1);
      expect(t.err.join('\n')).toContain('No LLM engine answering');
      expect(t.err.join('\n')).toContain('escalate');
    }
  });

  test('status REPORTS the engine being down instead of only erroring', async () => {
    // The diagnostic verb. A user runs this precisely when nothing works, so
    // it has to answer "which model, on which engine, and what does that cost
    // me" — not just repeat that the port is quiet.
    const t = io();
    const code = await run(['status'], configWith({ model: 'YoozLabs/Some-Model' }), t.io, {
      probe: async (): Promise<EngineProbe> => ({ reachable: false, reason: 'ECONNREFUSED' }),
    });

    expect(code).toBe(1);
    const text = t.out.join('\n');
    expect(text).toContain('not running');
    expect(text).toContain('YoozLabs/Some-Model');
    expect(text).toContain('escalates every permission');
  });

  test('status does NOT start an engine — that would destroy the question', async () => {
    let started = false;
    const t = io();
    await run(['status'], configWith(), t.io, {
      ensureEngine: async () => {
        started = true;
        return true;
      },
      probe: async (): Promise<EngineProbe> => ({ reachable: false, reason: 'ECONNREFUSED' }),
    });
    expect(started).toBe(false);
  });

  test('a verb that needs an engine starts one first (#843)', async () => {
    // The whole point: on a machine that has never run a daemon, `pull` has to
    // work. Before this it failed until the user started a daemon, which
    // inverts the order anyone would try.
    const startedFor: string[] = [];
    for (const verb of ['ls', 'ps', 'pull', 'load', 'unload', 'cleanup', 'rm', 'cancel']) {
      const t = io();
      await run([verb, 'x'], configWith(), t.io, {
        ensureEngine: async () => {
          startedFor.push(verb);
          return false;
        },
        probe: async (): Promise<EngineProbe> => ({ reachable: false, reason: 'ECONNREFUSED' }),
      });
    }
    expect(startedFor).toEqual(['ls', 'ps', 'pull', 'load', 'unload', 'cleanup', 'rm', 'cancel']);
  });
});

describe('remi model ls / ps', () => {
  test('ls lists the DISK inventory with real footprints and marks REMI’s model', async () => {
    const t = io();
    const code = await run(['ls'], configWith({ model: 'yooz-light-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      // `ls` resolves purpose labels via `purposeMap`, which calls `list`.
      // Without injecting it the call escapes to the REAL engine on :19924 and
      // the assertion below depends on whether one happens to be running:
      // locally it printed "engine proofread tier", in CI "engine active".
      // CATALOG carries no `purpose`, which is the unqualified-label case.
      list: async () => CATALOG,
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('3.4 GB'); // measured on-disk size, not an estimate
    expect(text).toContain('800 MB');
    expect(text).toContain('resident');
    // The marker follows REMI's configured model, not the engine's active
    // tier. Marking the picker's tier as "yours" is the misattribution that
    // sent a user chasing `remi model use` to release someone else's model
    // (#843); `yooz-quality-v3` is the engine-active one here.
    expect(text).toMatch(/\*\s+yooz-light-v3/);
    expect(text).not.toMatch(/\*\s+yooz-quality-v3/);
    // ...but the engine's choice is still visible, because it holds the GPU
    // and cannot be deleted. Unqualified here because CATALOG reports no
    // purpose; the qualified form is pinned by the next test.
    expect(text).toContain('engine active');
  });

  test('ls names what the engine-active model is active FOR when the purpose is known', async () => {
    // The #860 half of the label. A bare "engine active" read as "the engine is
    // using this INSTEAD of your model" and sent a user chasing a problem that
    // did not exist, so the label names the tier when the engine reports one.
    // Nothing covered this branch before, which is how the sibling test above
    // could silently depend on a live engine supplying purposes.
    const t = io();
    const code = await run(['ls'], configWith({ model: 'yooz-light-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      list: async () => ({
        current: 'yooz-quality-v3',
        available: [
          {
            id: 'yooz-quality-v3',
            displayName: 'Yooz-Quality',
            sizeBytes: 2_400_000_000,
            loaded: true,
            purpose: 'proofread',
          },
        ],
      }),
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('engine proofread tier');
    // The qualified form REPLACES the bare one; printing both would be noise.
    expect(text).not.toMatch(/,\s+engine active/);
  });

  test('ls distinguishes not-downloaded from on-disk', async () => {
    const t = io();
    await run(['ls'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => [{ ...(INVENTORY[1] as ManagedModel), cached: false }],
    });

    expect(t.out.join('\n')).toContain('not downloaded');
  });

  test('ps shows only resident models', async () => {
    const t = io();
    await run(['ps'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => CATALOG,
    });

    const text = t.out.join('\n');
    expect(text).toContain('yooz-quality-v3');
    expect(text).not.toContain('yooz-light-v3');
  });

  test('ps says so plainly when nothing is resident', async () => {
    const t = io();
    await run(['ps'], configWith(), t.io, {
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
    // The status fixture must name the CONFIGURED model: `/v1/llm/status`
    // describes the engine's active tier, so a download it reports is only
    // remi's when that tier is remi's model. (The fixture used to say
    // `yooz-light-v3` while the config asked for something else, and expected
    // remi to claim that download as its own — the misattribution this
    // command was fixed to stop.)
    const t = io();
    const configured = DEFAULT_CONFIG.auto_approve.model;
    const code = await run(['status'], configWith(), t.io, {
      probe: async (): Promise<EngineProbe> => ({
        reachable: true,
        status: { loaded: false, modelId: configured, progress: 0.37, state: 'downloading' },
      }),
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('reachable');
    expect(text).toContain(configured);
    expect(text).toContain('37%');
  });

  test('an alias the engine lists under a canonical id is not called missing', async () => {
    // The default config names a HuggingFace repo id, which the engine
    // resolves server-side to a canonical catalogue id -- and neither model
    // listing exposes that mapping. So an id comparison finds nothing for a
    // model that is present and working. Reporting "not served" there would
    // be a false alarm on the SHIPPED default (yooz-engine#308).
    const t = io();
    await run(['status'], configWith({ model: 'YoozLabs/Some-Repo-Id' }), t.io, {
      probe: async (): Promise<EngineProbe> => ({ reachable: true, status: { loaded: true } }),
      // The engine lists it under its canonical id, not the alias.
      inventory: async () => [
        {
          id: 'yooz-instruct-4b',
          module: 'llm',
          displayName: 'Yooz-Instruct-4B',
          sizeBytes: 2_387_349_504,
          cached: true,
          loaded: false,
          isActive: false,
          deletable: true,
        },
      ],
    });

    const text = t.out.join('\n');
    expect(text).not.toContain('not served');
    expect(text).toContain('unknown');
  });

  test('does not disown remi’s own model when it is configured by alias', async () => {
    // Live repro: configure a TouchUp tier by its HuggingFace id. `modelId` is
    // always canonical (`yooz-light-v3`), `configured` is the alias, and
    // nothing exposes the mapping — so the ids compare unequal for the SAME
    // model, and the old code concluded "not used by remi" about remi's own
    // model. Two spellings of one model gave two different answers, one wrong.
    //
    // The default config hides this: `yooz-instruct-4b` can never be a picker
    // `modelId` (it is not a TouchUpModelSelection case), so every mismatch
    // there is a real one by coincidence.
    const t = io();
    await run(['status'], configWith({ model: 'YoozLabs/Yooz-Light-v3-Qwen3.5-0.8B' }), t.io, {
      probe: async (): Promise<EngineProbe> => ({
        reachable: true,
        status: { loaded: true, modelId: 'yooz-light-v3', state: 'idle' },
      }),
      inventory: async () => [],
    });

    const text = t.out.join('\n');
    expect(text).not.toContain('not used by remi');
    expect(text).toContain('cannot tell');
  });

  test('never reports another model’s state as remi’s', async () => {
    // The engine's picker sits on a different tier and is mid-download. None
    // of that is remi's: reporting it would tell a user their model is busy or
    // warm when it is neither.
    const t = io();
    await run(['status'], configWith({ model: 'yooz-instruct-4b' }), t.io, {
      probe: async (): Promise<EngineProbe> => ({
        reachable: true,
        status: { loaded: true, modelId: 'yooz-light-v3', progress: 0.37, state: 'downloading' },
      }),
      inventory: async () => INVENTORY,
    });

    const text = t.out.join('\n');
    expect(text).not.toContain('37%');
    // ...but it is named, not hidden — it shares the GPU.
    expect(text).toContain('engine picker: yooz-light-v3');
  });

  test('names the picker’s model by its registered id when the engine reports one', async () => {
    // Both lines of the report should speak the same vocabulary: it is
    // confusing to print remi's model as a repo id and the picker's as a
    // nickname when the engine has just told us both names.
    const t = io();
    await run(['status'], configWith({ model: 'YoozLabs/Instruct' }), t.io, {
      probe: async (): Promise<EngineProbe> => ({
        reachable: true,
        status: { loaded: true, modelId: 'yooz-light-v3', state: 'idle' },
      }),
      inventory: async () => [
        {
          id: 'yooz-instruct-4b',
          module: 'llm',
          displayName: 'Yooz-Instruct-4B',
          sizeBytes: 2_400_000_000,
          cached: true,
          loaded: false,
          isActive: false,
          deletable: true,
          huggingFaceID: 'YoozLabs/Instruct',
        },
        {
          id: 'yooz-light-v3',
          module: 'llm',
          displayName: 'Yooz-Light',
          sizeBytes: 632_000_000,
          cached: true,
          loaded: true,
          isActive: true,
          deletable: false,
          huggingFaceID: 'YoozLabs/Yooz-Light-v3-Qwen3.5-0.8B',
        },
      ],
    });

    const text = t.out.join('\n');
    expect(text).toContain('engine picker: YoozLabs/Yooz-Light-v3-Qwen3.5-0.8B (not used by remi)');
    expect(text).not.toContain('engine picker: yooz-light-v3');
  });

  test('surfaces a failed load rather than reporting a bare "not loaded"', async () => {
    const t = io();
    await run(['status'], configWith(), t.io, {
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
    const code = await run(['pull', 'yooz-light-v3'], configWith(), t.io, {
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
    await run(['pull'], configWith({ model: 'configured-model' }), t.io, {
      probe: async () => REACHABLE,
      pull: async (_url, model) => {
        pulled = model;
      },
    });

    expect(pulled).toBe('configured-model');
  });

  test('a failed pull exits non-zero with the reason', async () => {
    const t = io();
    const code = await run(['pull', 'm'], configWith(), t.io, {
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
    expect(await run(['unload'], configWith(), t.io, { probe: async () => REACHABLE })).toBe(2);
  });

  test('unloads the named model', async () => {
    const t = io();
    let unloaded = '';
    const code = await run(['unload', 'yooz-quality-v3'], configWith(), t.io, {
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
    const code = await run(['use', 'yooz-light-v3'], configWith(), t.io, {
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
    const code = await run(['use', 'not-a-model'], configWith(), t.io, {
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
    const code = await run(['rm', 'yooz-light-v3'], configWith(), t.io, {
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

  test("refuses to delete REMI's own model, and says how to switch first", async () => {
    const t = io();
    let removed = '';
    const code = await run(
      ['rm', 'yooz-quality-v3'],
      configWith({ model: 'yooz-quality-v3' }),
      t.io,
      {
        probe: async () => REACHABLE,
        inventory: async () => INVENTORY,
        remove: async (_url, id) => {
          removed = id;
          return { id, reclaimedBytes: 0 };
        },
      },
    );

    expect(code).toBe(1);
    expect(removed).toBe(''); // never called
    // Here the advice WORKS: it really is remi's configured model.
    expect(t.err.join('\n')).toContain('remi model use <other>');
  });

  test("releases the ENGINE's active model on an owned engine, then deletes it", async () => {
    // The reported friction (#860). `isActive` belongs to the TouchUp picker,
    // so `remi model use` provably cannot release it -- and neither can
    // restarting, because a fresh engine re-selects that tier at boot. On an
    // engine remi owns, remi moves the picker itself.
    const t = io();
    let pointedAt = '';
    let removed = '';
    const code = await run(
      ['rm', 'yooz-quality-v3'],
      configWith({ model: 'yooz-light-v3', engine: 'owned' }),
      t.io,
      {
        probe: async () => REACHABLE,
        inventory: async () => INVENTORY,
        list: async () => ({
          current: 'yooz-quality-v3',
          available: [
            // Listed FIRST and of the WRONG purpose: the picker would refuse
            // it, so choosing by position rather than purpose breaks here.
            { id: 'yooz-instruct-4b', displayName: 'I', loaded: false, purpose: 'general' },
            { id: 'yooz-quality-v3', displayName: 'Q', loaded: true, purpose: 'proofread' },
            { id: 'yooz-light-v3', displayName: 'L', loaded: false, purpose: 'proofread' },
          ],
        }),
        setTouchUpModel: async (_url, id) => {
          pointedAt = id;
        },
        remove: async (_url, id) => {
          removed = id;
          return { id, reclaimedBytes: 800_000_000 };
        },
      },
    );

    expect(code).toBe(0);
    expect(pointedAt).toBe('yooz-light-v3'); // same purpose, so the picker accepts it
    expect(removed).toBe('yooz-quality-v3');
    // The second mutation must be visible: this moved a setting the user did
    // not name.
    expect(t.out.join('\n')).toContain('pointing that picker at');
  });

  test('refuses when the engine will not say what a model is used for', async () => {
    // `m.purpose === targetPurpose` with both absent is `undefined ===
    // undefined`, which matches EVERY row -- the same trap `matchesModel`
    // documents. An engine that reports no purposes must stop the release,
    // not silently make the filter a pass-through.
    const t = io();
    let pointedAt = '';
    let removed = '';
    const code = await run(
      ['rm', 'yooz-quality-v3'],
      configWith({ model: 'yooz-light-v3', engine: 'owned' }),
      t.io,
      {
        probe: async () => REACHABLE,
        inventory: async () => INVENTORY,
        list: async () => ({
          current: 'yooz-quality-v3',
          available: [
            { id: 'yooz-quality-v3', displayName: 'Q', loaded: true },
            { id: 'yooz-light-v3', displayName: 'L', loaded: false },
          ],
        }),
        setTouchUpModel: async (_url, id) => {
          pointedAt = id;
        },
        remove: async (_url, id) => {
          removed = id;
          return { id, reclaimedBytes: 0 };
        },
      },
    );

    expect(code).toBe(1);
    expect(pointedAt).toBe('');
    expect(removed).toBe('');
    expect(t.err.join('\n')).toContain('does not report what');
  });

  test('prefers a replacement already on disk over one that would download', async () => {
    // Releasing must not kick off a multi-GB download as a side effect of a
    // delete. The catalogue has no disk state, so this cross-references the
    // inventory's `cached`.
    const t = io();
    let pointedAt = '';
    const code = await run(
      ['rm', 'yooz-quality-v3'],
      configWith({ model: 'yooz-instruct-4b', engine: 'owned' }),
      t.io,
      {
        probe: async () => REACHABLE,
        inventory: async () => [
          {
            id: 'yooz-quality-v3',
            module: 'llm',
            displayName: 'Q',
            sizeBytes: 1,
            cached: true,
            loaded: true,
            isActive: true,
            deletable: false,
          },
          {
            id: 'not-downloaded',
            module: 'llm',
            displayName: 'N',
            sizeBytes: 1,
            cached: false,
            loaded: false,
            isActive: false,
            deletable: true,
          },
          {
            id: 'on-disk',
            module: 'llm',
            displayName: 'D',
            sizeBytes: 1,
            cached: true,
            loaded: false,
            isActive: false,
            deletable: true,
          },
        ],
        list: async () => ({
          current: 'yooz-quality-v3',
          available: [
            { id: 'yooz-quality-v3', displayName: 'Q', loaded: true, purpose: 'proofread' },
            // Listed FIRST but NOT downloaded: picking by position would
            // trigger a fetch.
            { id: 'not-downloaded', displayName: 'N', loaded: false, purpose: 'proofread' },
            { id: 'on-disk', displayName: 'D', loaded: false, purpose: 'proofread' },
          ],
        }),
        setTouchUpModel: async (_url, id) => {
          pointedAt = id;
        },
        remove: async (_url, id) => ({ id, reclaimedBytes: 0 }),
      },
    );

    expect(code).toBe(0);
    expect(pointedAt).toBe('on-disk');
  });

  test('refuses when the engine has no other model of that purpose', async () => {
    // Releasing by pointing the picker at nothing would leave that module
    // without a model, which is worse than refusing to delete.
    const t = io();
    let removed = '';
    const code = await run(
      ['rm', 'yooz-quality-v3'],
      configWith({ model: 'yooz-light-v3', engine: 'owned' }),
      t.io,
      {
        probe: async () => REACHABLE,
        inventory: async () => INVENTORY,
        list: async () => ({
          current: 'yooz-quality-v3',
          available: [
            { id: 'yooz-quality-v3', displayName: 'Q', loaded: true, purpose: 'proofread' },
            // A general-purpose model is NOT a substitute for a proofread tier.
            { id: 'yooz-instruct-4b', displayName: 'I', loaded: false, purpose: 'general' },
          ],
        }),
        remove: async (_url, id) => {
          removed = id;
          return { id, reclaimedBytes: 0 };
        },
      },
    );

    expect(code).toBe(1);
    expect(removed).toBe('');
    expect(t.err.join('\n')).toContain('nothing to point the picker at');
  });

  test("never moves a SHARED engine's picker", async () => {
    // Repointing another host's picker is hostile: that app is using it.
    // Note this is enforced by the pre-existing MUTATING guard (#818), which
    // returns before any rm-specific code runs -- so this pins the OUTCOME,
    // not the release branch. Stated because a reader could otherwise assume
    // `releaseActiveModel` re-checks ownership; it deliberately does not.
    const t = io();
    let pointedAt = '';
    const code = await run(
      ['rm', 'yooz-quality-v3'],
      configWith({ model: 'yooz-light-v3', engine: 'shared' }),
      t.io,
      {
        probe: async () => REACHABLE,
        inventory: async () => INVENTORY,
        setTouchUpModel: async (_url, id) => {
          pointedAt = id;
        },
      },
    );

    expect(code).toBe(1);
    expect(pointedAt).toBe('');
  });

  test('requires an explicit id', async () => {
    const t = io();
    expect(await run(['rm'], configWith(), t.io, { probe: async () => REACHABLE })).toBe(2);
  });
});

describe('remi model cleanup / cancel', () => {
  test('cleanup reports the total reclaimed', async () => {
    const t = io();
    const code = await run(['cleanup'], configWith(), t.io, {
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
    const code = await run(['cancel', 'yooz-light-v3'], configWith(), t.io, {
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
    await run(['pull', 'yooz-quality-v3'], configWith(), t.io, {
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
    await run(['pull', 'm'], configWith(), t.io, {
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
      const code = await run([verb, 'some-model'], shared(), t.io, {
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
    const code = await run(['ls'], shared(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
    });

    expect(code).toBe(0);
    expect(t.out.join('\n')).toContain('yooz-quality-v3');
  });

  test('status names which mode this remi is in', async () => {
    const t = io();
    await run(['status'], shared(), t.io, { probe: async () => REACHABLE });

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
    await run(['ls'], configWith(), t.io, {
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
    await run(['ls', '--all'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => [...INVENTORY, ...OTHER],
    });

    const text = t.out.join('\n');
    expect(text).toContain('models--Qwen');
    expect(text).not.toContain('hidden');
  });

  test('a size the engine could not measure reads as unknown, not "0 MB"', async () => {
    const t = io();
    await run(['ls', '--all'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => OTHER,
    });

    expect(t.out.join('\n')).not.toContain('0 MB');
  });

  test('a long id does not break the columns', async () => {
    const t = io();
    await run(['ls', '--all'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => OTHER,
    });

    // Every row keeps the module column at the same offset.
    const rows = t.out.filter((l) => l.includes('stt'));
    const offsets = new Set(rows.map((r) => r.indexOf('stt')));
    expect(offsets.size).toBe(1);
  });
});

describe('remi model — flag handling regressions', () => {
  test('--all on a verb that does not take it is a usage error, not a bogus model id', async () => {
    // The parser collects --all for every `model` verb; without a guard,
    // `rm --all foo` read "--all" as the id and dropped the real one.
    const t = io();
    let removed = '';
    const code = await run(['rm', '--all', 'yooz-light-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      remove: async (_u, id) => {
        removed = id;
        return { id, reclaimedBytes: 0 };
      },
    });

    expect(code).toBe(2);
    expect(removed).toBe(''); // nothing was deleted under a wrong id
    expect(t.err.join('\n')).toContain('ls');
  });
});

/**
 * Models have two names: the engine's canonical wire id (`yooz-instruct-4b`)
 * and the registered HuggingFace repo the weights actually come from
 * (`YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx`). The engine accepts either on
 * input and, since yooz-engine#308, reports both.
 *
 * remi's shipped default is the repo id, so every one of these paths is the
 * DEFAULT configuration, not an exotic one.
 */
describe('remi model — registered names vs canonical ids (#843)', () => {
  const HF = 'YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx';

  /** Alias-aware rows, as an engine >= 0.7.8 returns them. */
  const ALIASED: readonly ManagedModel[] = [
    {
      id: 'yooz-instruct-4b',
      module: 'llm',
      displayName: 'Yooz-Instruct-4B',
      sizeBytes: 2_400_000_000,
      cached: true,
      loaded: true,
      isActive: false,
      deletable: true,
      huggingFaceID: HF,
    },
  ];

  const ALIASED_CATALOG: EngineModelCatalog = {
    current: 'yooz-light-v3',
    available: [
      {
        id: 'yooz-instruct-4b',
        displayName: 'Yooz-Instruct-4B',
        loaded: true,
        huggingFaceID: HF,
      },
    ],
  };

  test('ls shows the REGISTERED name, not the internal nickname', async () => {
    const t = io();
    await run(['ls'], configWith({ model: HF }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => ALIASED,
    });

    const text = t.out.join('\n');
    expect(text).toContain(HF);
    expect(text).not.toContain('yooz-instruct-4b');
    expect(text).toMatch(/\*\s+YoozLabs/); // and it is recognized as remi's
  });

  test('status resolves a repo-id config through the alias instead of giving up', async () => {
    // Before the alias existed this printed "unknown -- this engine's listing
    // does not name it" for a model that was present, cached and working.
    const t = io();
    const code = await run(['status'], configWith({ model: HF }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => ALIASED,
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('loaded:   yes');
    expect(text).toContain('on disk:  yes');
    expect(text).not.toContain('unknown');
  });

  test('status says "not downloaded" only when the rows COULD have named it', async () => {
    // Alias-aware rows that genuinely do not include the configured model. Now
    // a negative is real information and worth acting on.
    const t = io();
    await run(['status'], configWith({ model: 'YoozLabs/Not-Installed' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => ALIASED,
    });

    const text = t.out.join('\n');
    expect(text).toContain('not downloaded');
    expect(text).toContain('remi model pull');
  });

  test('status stays honest on an engine too old to report aliases', async () => {
    // INVENTORY has no huggingFaceID on any row, so a repo-shaped config
    // cannot be resolved either way. Guessing "not downloaded" here would be a
    // false alarm on the default config against a 0.7.7 engine.
    const t = io();
    await run(['status'], configWith({ model: HF }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
    });

    const text = t.out.join('\n');
    expect(text).toContain('unknown');
    expect(text).not.toContain('not downloaded');
  });

  test('use accepts the registered repo id', async () => {
    // The 0.7.0 bug: `use` required `m.id === id`, so it refused the very
    // default remi ships with.
    const t = io();
    let persisted = '';
    const code = await run(['use', HF], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => ALIASED_CATALOG,
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(0);
    expect(persisted).toBe(HF);
  });

  test('rm accepts the registered repo id and deletes by the canonical one', async () => {
    const t = io();
    let removed = '';
    const code = await run(['rm', HF], configWith({ model: 'yooz-light-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => ALIASED,
      remove: async (_u, id) => {
        removed = id;
        return { id, reclaimedBytes: 2_400_000_000 };
      },
    });

    expect(code).toBe(0);
    expect(removed).toBe('yooz-instruct-4b');
  });
});

describe('remi model use — never needs an engine (#843)', () => {
  test('persists with no engine running, and says it could not verify', async () => {
    // The worst friction in 0.7.0: configuring a model was impossible while
    // the engine was down, which is exactly when a user is setting one up.
    const t = io();
    let persisted = '';
    const code = await run(['use', 'yooz-light-v3'], configWith(), t.io, {
      probe: async (): Promise<EngineProbe> => ({ reachable: false, reason: 'ECONNREFUSED' }),
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(0);
    expect(persisted).toBe('yooz-light-v3');
    const text = t.out.join('\n');
    expect(text).toContain('Not verified');
    expect(text).toContain('Restart');
  });

  test('never starts an engine just to set a config value', async () => {
    let started = false;
    const t = io();
    await run(['use', 'yooz-light-v3'], configWith(), t.io, {
      ensureEngine: async () => {
        started = true;
        return true;
      },
      probe: async (): Promise<EngineProbe> => ({ reachable: false, reason: 'ECONNREFUSED' }),
      persistModel: () => {},
    });
    expect(started).toBe(false);
  });

  test('still validates when an engine IS there', async () => {
    // The check is a nicety layered on top, not a precondition — but while it
    // can run, a typo caught now beats a multi-GB download of nothing later.
    const t = io();
    let persisted = '';
    const code = await run(['use', 'nonsense'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => CATALOG,
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(1);
    expect(persisted).toBe('');
  });
});

describe('remi model use — an older engine must not resurrect the original bug', () => {
  test('accepts a registered repo id against a catalogue that lists canonical ids only', async () => {
    // yooz-engine < 0.7.8 reports no aliases, so a repo-shaped id cannot be
    // checked against the catalogue — but the engine RESOLVES it server-side
    // and runs it fine. Rejecting it here is exactly the 0.7.0 friction
    // (verified live against a 0.7.7 engine while fixing #843), so an
    // undecidable id is accepted with a note, never refused.
    const t = io();
    let persisted = '';
    const code = await run(['use', 'YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => CATALOG, // no huggingFaceID on any row
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(0);
    expect(persisted).toBe('YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx');
    expect(t.out.join('\n')).toContain('Not verified');
  });

  test('a canonical typo is still decidable there, and still refused', async () => {
    // The safety half: an id with no slash can be compared directly against
    // the catalogue on ANY engine version, so a typo is caught rather than
    // waved through by the same leniency.
    const t = io();
    let persisted = '';
    const code = await run(['use', 'yooz-lite-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => CATALOG,
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(1);
    expect(persisted).toBe('');
  });
});

/**
 * A failed call is not an empty result. `listManagedModels` / `listModels`
 * throw on a non-2xx, a timeout, or an unparsable body — all real against an
 * engine that is otherwise answering — and collapsing that to "no rows" makes
 * every downstream conclusion confident and wrong.
 */
describe('remi model — a broken engine response is never read as an answer', () => {
  const boom = () => {
    throw new Error('HTTP 500 from /v1/models');
  };

  test('status reports the read failure instead of "not downloaded"', async () => {
    const t = io();
    const code = await run(['status'], configWith({ model: 'yooz-light-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => boom(),
    });

    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('could not read');
    expect(text).toContain('HTTP 500'); // the actual cause, not a guess
    expect(text).not.toContain('not downloaded');
    expect(text).not.toContain('upgrade the engine');
  });

  test('use says validation could not run, rather than reporting a clean write', async () => {
    // Otherwise a typo is persisted and reported identically to a validated
    // write, with the check silently disabled by a network hiccup.
    const t = io();
    let persisted = '';
    const code = await run(['use', 'yooz-light-v3'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => boom(),
      persistModel: (id) => {
        persisted = id;
      },
    });

    expect(code).toBe(0);
    expect(persisted).toBe('yooz-light-v3'); // still configurable
    const text = t.out.join('\n');
    expect(text).toContain('Not verified');
    expect(text).toContain('HTTP 500');
  });

  test('use says so when the engine reports an empty catalogue', async () => {
    const t = io();
    const code = await run(['use', 'anything-at-all'], configWith(), t.io, {
      probe: async () => REACHABLE,
      list: async () => ({ current: '', available: [] }) as EngineModelCatalog,
      persistModel: () => {},
    });

    expect(code).toBe(0);
    expect(t.out.join('\n')).toContain('Not verified');
  });
});

/**
 * On an engine that reports no aliases, remi cannot tell which row is its own
 * model when it is configured by repo id (the shipped default). Anything that
 * ASSERTS ownership either way there is a confidently wrong claim — the exact
 * bug #843 exists to remove, and easy to reintroduce at a call site that uses
 * the boolean matcher instead of the tri-state lookup.
 */
describe('remi model — undecidable ownership is never asserted (legacy engine)', () => {
  const HF = 'YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx';

  test('ls does not silently imply that none of the models is yours', async () => {
    const t = io();
    await run(['ls'], configWith({ model: HF }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY, // no huggingFaceID on any row
    });

    const text = t.out.join('\n');
    expect(text).not.toContain('*'); // nothing marked...
    expect(text).toContain("cannot mark which is remi's"); // ...and it says why
    expect(text).toContain(HF);
  });

  test('rm does not claim the engine-active model "is not remi\'s"', async () => {
    // It very likely IS remi's, resolved server-side. Asserting otherwise also
    // denies the one remedy that would actually work.
    const t = io();
    const code = await run(['rm', 'yooz-quality-v3'], configWith({ model: HF }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
    });

    expect(code).toBe(1);
    const text = t.err.join('\n');
    expect(text).not.toContain("It is not remi's model");
    expect(text).toContain('cannot be determined');
    expect(text).toContain('remi model use <other>'); // offered, not denied
  });
});

describe('ls labels what the engine model is active FOR (#860)', () => {
  test('names the purpose instead of a bare "engine active"', async () => {
    // `isActive` is the TOUCHUP picker's choice, so remi's own model can never
    // carry it and a model remi never uses always does. Unqualified, that reads
    // as "the engine is using this instead of the model I chose" -- which is
    // exactly the conclusion a user drew. remi's model was in use the whole
    // time; only the label was wrong.
    const t = io();
    const code = await run(['ls'], configWith({ model: 'yooz-quality-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      list: async () => ({
        current: 'yooz-light-v3',
        available: [
          { id: 'yooz-light-v3', displayName: 'L', loaded: true, purpose: 'proofread' },
          { id: 'yooz-quality-v3', displayName: 'Q', loaded: true, purpose: 'proofread' },
        ],
      }),
    });
    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('engine proofread tier');
    expect(text).not.toContain(', engine active');
  });

  test('falls back to the bare label when the catalogue cannot be read', async () => {
    // A catalogue we cannot read must cost one qualifier, not the whole listing.
    const t = io();
    const code = await run(['ls'], configWith({ model: 'yooz-quality-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      list: async () => {
        throw new Error('catalogue unavailable');
      },
    });
    expect(code).toBe(0);
    expect(t.out.join('\n')).toContain('engine active');
  });
});

describe('engine version (#852)', () => {
  test('isOlderThanPinned is three-way, never a guess', () => {
    // "cannot tell" must not collapse into either answer: both are claims about
    // the user's machine, and both were being made up before this existed.
    expect(isOlderThanPinned('0.7.7')).toBe(true);
    expect(isOlderThanPinned('0.7.8')).toBe(false);
    expect(isOlderThanPinned('0.7.9')).toBe(false);
    expect(isOlderThanPinned('0.8.0')).toBe(false);
    expect(isOlderThanPinned('1.0.0')).toBe(false);
    expect(isOlderThanPinned('0.6.24')).toBe(true);
    expect(isOlderThanPinned(undefined)).toBeUndefined();
    expect(isOlderThanPinned('not-a-version')).toBeUndefined();
  });

  test('a prerelease of the pinned version is not older than it', () => {
    // `0.7.8-dev.1` carries the 0.7.8 features, which is what the comparison is
    // actually asking. Ordering it below 0.7.8 would nag on every dev build.
    expect(isOlderThanPinned('0.7.8-dev.1')).toBe(false);
  });

  test('status reports the running version alongside the pin', async () => {
    const t = io();
    const code = await run(['status'], configWith({ model: 'yooz-quality-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      engineVersion: async () => '0.7.8',
    });
    expect(code).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('0.7.8');
    expect(text).toContain('remi pins 0.7.8');
  });

  test('status names the restart command when the engine is older than the pin', async () => {
    // The 0.7.1 message said "upgrade the engine to 0.7.8+" and named no way to
    // do it -- the only implementation was an uncalled function (#852).
    const t = io();
    await run(['status'], configWith({ model: 'yooz-quality-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      engineVersion: async () => '0.7.7',
    });
    const text = t.out.join('\n');
    expect(text).toContain('0.7.7');
    expect(text).toContain('older than the 0.7.8');
    expect(text).toContain('remi model restart');
  });

  test('status says "not reported" rather than inventing a version', async () => {
    const t = io();
    await run(['status'], configWith({ model: 'yooz-quality-v3' }), t.io, {
      probe: async () => REACHABLE,
      inventory: async () => INVENTORY,
      engineVersion: async () => undefined,
    });
    const text = t.out.join('\n');
    expect(text).toContain('not reported');
    expect(text).not.toContain('remi model restart');
  });
});

describe('remi model restart (#852)', () => {
  test('stops the running engine, then starts the pinned one', async () => {
    const stopped: number[] = [];
    let started = false;
    let calls = 0;
    const t = io();
    const code = await run(['restart'], configWith(), t.io, {
      // reachable -> (after stop) unreachable -> reachable again
      probe: async () => {
        calls++;
        return calls === 1 || calls > 2 ? REACHABLE : { reachable: false, reason: 'down' };
      },
      engineVersion: async () => (started ? '0.7.8' : '0.7.7'),
      stopEngine: () => {
        stopped.push(4242);
        return 4242;
      },
      ensureEngine: async () => {
        started = true;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(stopped).toEqual([4242]);
    expect(started).toBe(true);
    expect(t.out.join('\n')).toContain('0.7.7 -> 0.7.8');
  });

  test('refuses to kill an engine remi has no record of starting', async () => {
    // Killing whatever holds the port on a guess is how you take down something
    // the user cared about. Nothing is stopped and nothing is started.
    let started = false;
    const t = io();
    const code = await run(['restart'], configWith(), t.io, {
      probe: async () => REACHABLE,
      engineVersion: async () => '0.7.7',
      stopEngine: () => null,
      ensureEngine: async () => {
        started = true;
        return true;
      },
    });
    expect(code).toBe(1);
    expect(started).toBe(false);
    expect(t.err.join('\n')).toContain('no record of starting it');
  });

  test('starts an engine when none is running', async () => {
    let started = false;
    let calls = 0;
    const t = io();
    const code = await run(['restart'], configWith(), t.io, {
      probe: async () => {
        calls++;
        return calls === 1 ? { reachable: false, reason: 'down' } : REACHABLE;
      },
      engineVersion: async () => '0.7.8',
      stopEngine: () => {
        throw new Error('must not stop an engine that is not running');
      },
      ensureEngine: async () => {
        started = true;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(started).toBe(true);
  });

  test('reports failure when the relaunched engine is still older than the pin', async () => {
    // Restarting cannot fix a stale helper on disk, and claiming success would
    // be a lie the user discovers later.
    let calls = 0;
    const t = io();
    const code = await run(['restart'], configWith(), t.io, {
      probe: async () => {
        calls++;
        return calls === 1 || calls > 2 ? REACHABLE : { reachable: false, reason: 'down' };
      },
      engineVersion: async () => '0.7.7',
      stopEngine: () => 4242,
      ensureEngine: async () => true,
    });
    expect(code).toBe(1);
    expect(t.err.join('\n')).toContain('still 0.7.7');
  });

  test('will not start a second engine when the old one keeps the port', async () => {
    // SIGTERM is asynchronous. If the old engine never lets go, starting anyway
    // yields a second engine that fails to bind and exits -- leaving the OLD
    // one serving while the command claims success.
    let started = false;
    const t = io();
    const code = await run(['restart'], configWith(), t.io, {
      probe: async () => REACHABLE, // never releases
      engineVersion: async () => '0.7.7',
      stopEngine: () => 4242,
      ensureEngine: async () => {
        started = true;
        return true;
      },
    });
    expect(code).toBe(1);
    expect(started).toBe(false);
    expect(t.err.join('\n')).toContain('still holding the port');
  });

  test('refuses against a shared engine', async () => {
    const t = io();
    const code = await run(['restart'], configWith({ engine: 'shared' }), t.io, {
      stopEngine: () => {
        throw new Error("must not kill another host's engine");
      },
    });
    expect(code).toBe(1);
    expect(t.err.join('\n')).toContain('shared engine');
  });
});

// #822: llama-server serves the one GGUF it was started with and has none of
// the engine's /v1/llm/* control plane. Without a guard these verbs reach a
// server that IS running and IS answering evals, and come back as opaque
// 404s -- which reads as "remi is broken", the exact unexplained degradation
// #818 exists to remove, on another platform.
describe('remi model — provider = "llamacpp" (#822)', () => {
  const ENGINE_VERBS = [
    'ls',
    'ps',
    'status',
    'pull',
    'cancel',
    'rm',
    'cleanup',
    'load',
    'unload',
    'restart',
  ] as const;

  for (const verb of ENGINE_VERBS) {
    test(`"${verb}" refuses with the reason and the lever that exists`, async () => {
      const t = io();
      const code = await run([verb, 'some-model'], configWith({ provider: 'llamacpp' }), t.io);
      expect(code).toBe(1);
      const err = t.err.join('\n');
      expect(err).toContain('llamacpp');
      // The actionable half: the model is chosen by the process, so the
      // command to restart it is the answer, not an apology.
      expect(err).toContain('llama-server -hf');
      expect(err).toContain('#822');
    });
  }

  test('"use" still works and persists through the injected seam, never the real config', async () => {
    // The one verb that never needed a backend. Gating it would make the
    // model impossible to configure while llama-server is down -- exactly
    // when someone is setting this up.
    //
    // `persistModel` MUST be injected. The first draft of this test passed a
    // misspelled dep behind an `as ModelCommandDeps` cast, so the real
    // persister ran and rewrote the developer's own ~/.remi/config.toml to a
    // GGUF id -- which the macOS engine cannot load, i.e. the test silently
    // broke auto-approve on the machine running it. No cast here, so a
    // misspelling is a compile error.
    const t = io();
    let persisted = '';
    const code = await run(
      ['use', 'YoozLabs/Qwen3.5-0.8B-qat-GGUF:Q4_0'],
      {
        ...configWith({ provider: 'llamacpp' }),
      },
      t.io,
      {
        persistModel: (id) => {
          persisted = id;
        },
      },
    );
    expect(code).toBe(0);
    expect(persisted).toBe('YoozLabs/Qwen3.5-0.8B-qat-GGUF:Q4_0');
    expect(t.err.join('\n')).not.toContain('not available');
  });

  test('the guard does not fire for the engine provider', async () => {
    const t = io();
    await run(['status'], configWith({ provider: 'yooz' }), t.io, { probe: async () => REACHABLE });
    expect(t.err.join('\n')).not.toContain('llamacpp');
  });
});
