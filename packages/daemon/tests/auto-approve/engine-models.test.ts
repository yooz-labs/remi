import { afterEach, describe, expect, test } from 'bun:test';
import {
  ClearCacheUnsupportedError,
  cleanupModels,
  clearModelCache,
  deleteModel,
  getModelState,
  getStatus,
  listManagedModels,
  listModels,
  preloadAsync,
  probeEngine,
  pullModel,
  unloadModel,
} from '../../src/auto-approve/engine-models.ts';

/**
 * A real local HTTP server standing in for the Yooz engine's /v1/llm control
 * plane (no mocks, per the repo's testing rules). Each test scripts the
 * responses it wants and asserts on the requests the client actually made.
 */
function engineServer(handler: (path: string, body: unknown) => Response): {
  url: string;
  seen: Array<{ path: string; search: string; method: string; body: unknown }>;
  stop: () => void;
} {
  const seen: Array<{ path: string; search: string; method: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
      seen.push({ path: url.pathname, search: url.search, method: req.method, body });
      return handler(url.pathname, body);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => server.stop(true),
  };
}

const noSleep = async (): Promise<void> => {};

describe('engine model catalogue', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test('listModels reads current + available from GET /v1/llm/models', async () => {
    const server = engineServer(() =>
      Response.json({
        current: 'yooz-quality-v3',
        available: [
          {
            id: 'yooz-quality-v3',
            displayName: 'Yooz-Quality',
            sizeBytes: 2_400_000_000,
            loaded: true,
          },
          { id: 'yooz-light-v3', displayName: 'Yooz-Light', loaded: false },
        ],
      }),
    );
    stop = server.stop;

    const catalog = await listModels(server.url);

    expect(server.seen[0]?.path).toBe('/v1/llm/models');
    expect(catalog.current).toBe('yooz-quality-v3');
    expect(catalog.available).toHaveLength(2);
    expect(catalog.available[0]?.loaded).toBe(true);
    expect(catalog.available[1]?.sizeBytes).toBeUndefined(); // optional on the wire
  });

  test('listModels tolerates an older engine that omits the fields entirely', async () => {
    const server = engineServer(() => Response.json({}));
    stop = server.stop;

    const catalog = await listModels(server.url);

    expect(catalog).toEqual({ current: '', available: [] });
  });

  test('a non-2xx names the endpoint in the error (CLI surfaces this verbatim)', async () => {
    const server = engineServer(() => new Response('boom', { status: 500 }));
    stop = server.stop;

    await expect(getStatus(server.url)).rejects.toThrow(/\/v1\/llm\/status failed 500/);
  });
});

describe('probeEngine', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test('reports reachable + status when an engine answers', async () => {
    const server = engineServer(() => Response.json({ loaded: true, modelId: 'yooz-quality-v3' }));
    stop = server.stop;

    const probe = await probeEngine(server.url);

    expect(probe.reachable).toBe(true);
    if (probe.reachable) expect(probe.status.modelId).toBe('yooz-quality-v3');
  });

  test('NEVER throws when nothing is listening: an unreachable engine is a value', async () => {
    // Port 1 with a short timeout: nothing is there. This is the case that
    // otherwise degrades auto-approve to a silent always-escalate (#818).
    const probe = await probeEngine('http://127.0.0.1:1', 250);

    expect(probe.reachable).toBe(false);
    if (!probe.reachable) expect(probe.reason.length).toBeGreaterThan(0);
  });
});

describe('pullModel', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  const managed = (over: Record<string, unknown> = {}) => ({
    id: 'yooz-quality-v3',
    module: 'llm',
    displayName: 'Yooz-Quality',
    sizeBytes: 3_400_000_000,
    cached: false,
    loaded: false,
    isActive: false,
    deletable: false,
    ...over,
  });

  test('uses the explicit DOWNLOAD endpoint, not preload, and never ?wait=true', async () => {
    // Fetching weights and making a model resident are different acts; the
    // download endpoint is the one that leaves the active model alone.
    let polls = 0;
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/state') {
        return Response.json({
          modules: [
            {
              module: 'touchup',
              models: [{ id: 'yooz-quality-v3', loadState: 'available', downloadProgress: 0.006 }],
            },
          ],
        });
      }
      // Not cached on the first look, cached once the download "finishes".
      return Response.json({ models: [managed({ cached: polls++ >= 1 })] });
    });
    stop = server.stop;

    await pullModel(server.url, 'yooz-quality-v3', { sleep: noSleep });

    const download = server.seen.find((s) => s.path === '/v1/touchup/download');
    expect(download).toBeDefined();
    expect(download?.body).toEqual({ id: 'yooz-quality-v3' });
    expect(download?.search).toBe('');
    expect(server.seen.some((s) => s.path === '/v1/llm/preload')).toBe(false);
  });

  test('completes even when the fraction never advances, and says so (engine#292/#293)', async () => {
    // For a single-big-file repo the engine's fraction steps ~0.6% and sits
    // there. A pull that waited on progress would hang forever on a download
    // that actually succeeded, and a percentage would read as wedged.
    let polls = 0;
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/state') {
        return Response.json({
          modules: [
            {
              module: 'touchup',
              models: [
                {
                  id: 'yooz-quality-v3',
                  loadState: 'available',
                  downloadProgress: 0.0058,
                  sizeBytes: 3_400_000_000,
                },
              ],
            },
          ],
        });
      }
      return Response.json({ models: [managed({ cached: polls++ >= 2 })] });
    });
    stop = server.stop;

    const seen: Array<{ advancing: boolean; size?: number | undefined }> = [];
    await pullModel(server.url, 'yooz-quality-v3', {
      sleep: noSleep,
      onProgress: (p) => seen.push({ advancing: p.advancing, size: p.sizeBytes }),
    });

    // Never claims to be advancing, and carries the size so a renderer has
    // something honest to show instead of a frozen percentage.
    expect(seen.every((p) => p.advancing === false)).toBe(true);
    expect(seen.every((p) => p.size === 3_400_000_000)).toBe(true);
  });

  test('is idempotent: an already-cached model downloads nothing', async () => {
    const server = engineServer((path) => {
      if (path === '/v1/models') return Response.json({ models: [managed({ cached: true })] });
      return Response.json({});
    });
    stop = server.stop;

    await pullModel(server.url, 'yooz-quality-v3', { sleep: noSleep });

    expect(server.seen.some((s) => s.path === '/v1/touchup/download')).toBe(false);
  });

  test('a download that STOPS mid-flight is reported, not waited out', async () => {
    // The real failure shape: the engine reverts the row to `available` and
    // drops `downloadProgress`, with no `failed` state and no reason field
    // anywhere on this endpoint (yooz-engine#298). "Was fetching, now is not,
    // still not on disk" is the only signal a polling client gets.
    let polls = 0;
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/state') {
        const row =
          polls++ === 0
            ? { id: 'yooz-quality-v3', loadState: 'available', downloadProgress: 0.006 }
            : { id: 'yooz-quality-v3', loadState: 'available' }; // fetch gone
        return Response.json({ modules: [{ module: 'touchup', models: [row] }] });
      }
      return Response.json({ models: [managed()] });
    });
    stop = server.stop;

    await expect(
      pullModel(server.url, 'yooz-quality-v3', { sleep: noSleep, timeoutMs: 5_000 }),
    ).rejects.toThrow(/stopped without the model becoming available/);
  });

  test('a download that never reports progress still ends at the timeout, never spins forever', async () => {
    // Progress can be absent entirely (engine#292's first sample is late or
    // missing). Without a bound this loop would poll until the 30-minute
    // default -- a hot loop with no sleep.
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/state') {
        return Response.json({
          modules: [
            { module: 'touchup', models: [{ id: 'yooz-quality-v3', loadState: 'available' }] },
          ],
        });
      }
      return Response.json({ models: [managed()] });
    });
    stop = server.stop;

    let clock = 0;
    await expect(
      pullModel(server.url, 'yooz-quality-v3', {
        sleep: noSleep,
        now: () => {
          clock += 1_000;
          return clock;
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/timed out/);
  });

  test('a wedged download times out and points at the cancel command', async () => {
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/state') {
        return Response.json({
          modules: [
            {
              module: 'touchup',
              models: [{ id: 'yooz-quality-v3', loadState: 'available', downloadProgress: 0.006 }],
            },
          ],
        });
      }
      return Response.json({ models: [managed()] });
    });
    stop = server.stop;

    let clock = 0;
    await expect(
      pullModel(server.url, 'yooz-quality-v3', {
        sleep: noSleep,
        now: () => {
          clock += 10_000;
          return clock;
        },
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow(/remi model cancel/);
  });
});

describe('disk inventory', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test('listManagedModels reads the real on-disk footprint and delete eligibility', async () => {
    const server = engineServer(() =>
      Response.json({
        models: [
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
        ],
      }),
    );
    stop = server.stop;

    const models = await listManagedModels(server.url);

    expect(server.seen[0]?.path).toBe('/v1/models');
    expect(models[0]?.deletable).toBe(false); // active model is never deletable
    expect(models[0]?.sizeBytes).toBe(3_400_000_000);
  });

  test('deleteModel issues a DELETE and reports the bytes reclaimed', async () => {
    const server = engineServer(() =>
      Response.json({ id: 'yooz-light-v3', reclaimedBytes: 800_000_000 }),
    );
    stop = server.stop;

    const result = await deleteModel(server.url, 'yooz-light-v3');

    expect(server.seen[0]?.method).toBe('DELETE');
    expect(server.seen[0]?.path).toBe('/v1/models/yooz-light-v3');
    expect(result.reclaimedBytes).toBe(800_000_000);
  });

  test('deleteModel url-encodes an id with a slash (hub directory names)', async () => {
    const server = engineServer(() => Response.json({ id: 'x', reclaimedBytes: 0 }));
    stop = server.stop;

    await deleteModel(server.url, 'models--YoozLabs--Qwen3.5-4B');

    expect(server.seen[0]?.path).toBe('/v1/models/models--YoozLabs--Qwen3.5-4B');
  });

  test('cleanupModels reports the total reclaimed', async () => {
    const server = engineServer(() =>
      Response.json({ totalReclaimedBytes: 1_200_000_000, perRepo: { 'models--a--b': 1.2e9 } }),
    );
    stop = server.stop;

    const result = await cleanupModels(server.url);

    expect(server.seen[0]?.path).toBe('/v1/models/cleanup');
    expect(result.totalReclaimedBytes).toBe(1_200_000_000);
  });
});

describe('unloadModel', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test('posts the model to /v1/llm/unload', async () => {
    const server = engineServer(() => Response.json({}));
    stop = server.stop;

    await unloadModel(server.url, 'yooz-quality-v3');

    expect(server.seen[0]?.path).toBe('/v1/llm/unload');
    expect(server.seen[0]?.body).toEqual({ model: 'yooz-quality-v3' });
  });
});

describe('clearModelCache (#820 stage 1)', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test('posts to /v1/llm/clear-cache with the model when one is given', async () => {
    const server = engineServer(() => Response.json({ cleared: ['yooz-quality-v3'] }));
    stop = server.stop;

    const cleared = await clearModelCache(server.url, 'yooz-quality-v3');

    expect(server.seen[0]?.path).toBe('/v1/llm/clear-cache');
    expect(server.seen[0]?.body).toEqual({ model: 'yooz-quality-v3' });
    expect(cleared).toEqual(['yooz-quality-v3']);
  });

  test('omits the model to clear every loaded tier', async () => {
    const server = engineServer(() =>
      Response.json({ cleared: ['yooz-quality-v3', 'yooz-heavy'] }),
    );
    stop = server.stop;

    const cleared = await clearModelCache(server.url);

    expect(server.seen[0]?.body).toEqual({});
    expect(cleared).toEqual(['yooz-quality-v3', 'yooz-heavy']);
  });

  test('tolerates a response with no cleared field', async () => {
    const server = engineServer(() => Response.json({}));
    stop = server.stop;

    expect(await clearModelCache(server.url)).toEqual([]);
  });

  test('a 404 (engine predates this endpoint) throws ClearCacheUnsupportedError', async () => {
    const server = engineServer(() => new Response('not found', { status: 404 }));
    stop = server.stop;

    await expect(clearModelCache(server.url, 'm')).rejects.toBeInstanceOf(
      ClearCacheUnsupportedError,
    );
  });

  test('a 501 (engine recognizes but declines the route) also throws ClearCacheUnsupportedError', async () => {
    const server = engineServer(() => new Response('not implemented', { status: 501 }));
    stop = server.stop;

    await expect(clearModelCache(server.url, 'm')).rejects.toBeInstanceOf(
      ClearCacheUnsupportedError,
    );
  });

  test('a real failure (e.g. 500) is NOT reclassified as unsupported', async () => {
    const server = engineServer(() => new Response('boom', { status: 500 }));
    stop = server.stop;

    const err = await clearModelCache(server.url, 'm').catch((e) => e);
    expect(err).not.toBeInstanceOf(ClearCacheUnsupportedError);
    expect(String(err)).toContain('/v1/llm/clear-cache failed 500');
  });
});

describe('getModelState (per-model, not active-tier)', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test("reads THIS model's row from /v1/state, whichever module owns it", async () => {
    // /v1/llm/status reports only the ACTIVE tier, so pulling a non-active
    // model must not read it: you would get another model's state, including
    // another model's `failed`.
    const server = engineServer(() =>
      Response.json({
        modules: [
          { module: 'stt', models: [{ id: 'parakeet', loadState: 'ready' }] },
          {
            module: 'touchup',
            models: [
              { id: 'yooz-quality-v3', loadState: 'ready', isActive: true },
              { id: 'yooz-light-v3', loadState: 'available', downloadProgress: 0.0058 },
            ],
          },
        ],
      }),
    );
    stop = server.stop;

    const row = await getModelState(server.url, 'yooz-light-v3');

    expect(server.seen[0]?.path).toBe('/v1/state');
    expect(row?.loadState).toBe('available'); // the NON-active model's own state
    expect(row?.downloadProgress).toBeCloseTo(0.0058);
  });

  test('returns undefined for a model no module lists', async () => {
    const server = engineServer(() => Response.json({ modules: [] }));
    stop = server.stop;

    expect(await getModelState(server.url, 'nope')).toBeUndefined();
  });
});

describe('broken responses are never silently "empty"', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test('a 200 with an unparsable body THROWS rather than decoding to {}', async () => {
    // Swallowing this to {} would report a malfunctioning engine as healthy,
    // and an engine full of models as "no models on disk".
    const server = engineServer(() => new Response('<html>proxy error</html>', { status: 200 }));
    stop = server.stop;

    await expect(listManagedModels(server.url)).rejects.toThrow(/unparsable body/);
  });

  test('a genuinely EMPTY body (202 dispatched work) is still tolerated', async () => {
    const server = engineServer(() => new Response(null, { status: 202 }));
    stop = server.stop;

    await expect(preloadAsync(server.url, 'm')).resolves.toBeUndefined();
  });

  test('probeEngine reports a broken engine as UNREACHABLE, not healthy', async () => {
    const server = engineServer(() => new Response('not json', { status: 200 }));
    stop = server.stop;

    const probe = await probeEngine(server.url);

    expect(probe.reachable).toBe(false);
  });
});

describe('pullModel — engine death mid-download', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test('a dead engine is reported promptly, not as a 30-minute timeout', async () => {
    // The old behavior printed nothing at all for the whole window and then
    // blamed a "wedged" download, suggesting a cancel that would also fail.
    let started = false;
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') {
        started = true;
        return new Response(null, { status: 202 });
      }
      // Everything after the download starts fails, as if the engine died.
      return started ? new Response('gone', { status: 503 }) : Response.json({ models: [] });
    });
    stop = server.stop;

    await expect(pullModel(server.url, 'm', { sleep: noSleep })).rejects.toThrow(
      /stopped answering|unparsable|503/,
    );
  });
});
