import { afterEach, describe, expect, test } from 'bun:test';
import {
  cleanupModels,
  deleteModel,
  getStatus,
  listManagedModels,
  listModels,
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
      if (path === '/v1/llm/status') return Response.json({ loaded: false, state: 'idle' });
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

  test('completes from BYTES ON DISK even when progress never moves (engine#292)', async () => {
    // The engine publishes one near-zero sample and then freezes. A pull that
    // waited on progress would hang forever on a download that succeeded.
    let polls = 0;
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/llm/status') {
        return Response.json({ loaded: false, progress: 0.000027, state: 'idle' });
      }
      return Response.json({ models: [managed({ cached: polls++ >= 2 })] });
    });
    stop = server.stop;

    const seen: Array<number | undefined> = [];
    await pullModel(server.url, 'yooz-quality-v3', {
      sleep: noSleep,
      onProgress: (p) => seen.push(p.fraction),
    });

    expect(seen.every((f) => f === 0.000027)).toBe(true); // frozen, as documented
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

  test('a failed fetch throws with the engine reason', async () => {
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/llm/status') {
        return Response.json({ loaded: false, state: 'failed', lastError: 'disk full' });
      }
      return Response.json({ models: [managed()] });
    });
    stop = server.stop;

    await expect(pullModel(server.url, 'yooz-quality-v3', { sleep: noSleep })).rejects.toThrow(
      /disk full/,
    );
  });

  test('a wedged download times out and points at the cancel command', async () => {
    const server = engineServer((path) => {
      if (path === '/v1/touchup/download') return new Response(null, { status: 202 });
      if (path === '/v1/llm/status') return Response.json({ loaded: false });
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
