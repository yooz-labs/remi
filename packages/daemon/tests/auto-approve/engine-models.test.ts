import { afterEach, describe, expect, test } from 'bun:test';
import {
  getStatus,
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
  seen: Array<{ path: string; search: string; body: unknown }>;
  stop: () => void;
} {
  const seen: Array<{ path: string; search: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
      seen.push({ path: url.pathname, search: url.search, body });
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

  test('dispatches the ASYNC preload (never ?wait=true) and polls status to completion', async () => {
    // A first-run pull must not hold one HTTP request open for a multi-GB
    // download -- see the module doc. Progress arrives via /v1/llm/status.
    const statuses = [
      { loaded: false, progress: 0.1, state: 'downloading' },
      { loaded: false, progress: 0.8, state: 'downloading' },
      { loaded: true, modelId: 'yooz-quality-v3', state: 'ready' },
    ];
    let poll = 0;
    const server = engineServer((path) => {
      if (path === '/v1/llm/preload') return new Response(null, { status: 202 });
      return Response.json(statuses[Math.min(poll++, statuses.length - 1)]);
    });
    stop = server.stop;

    const progress: Array<number | undefined> = [];
    await pullModel(server.url, 'yooz-quality-v3', {
      onProgress: (p) => progress.push(p.fraction),
      sleep: noSleep,
    });

    const preload = server.seen.find((s) => s.path === '/v1/llm/preload');
    expect(preload).toBeDefined();
    expect(preload?.search).toBe(''); // NOT ?wait=true
    expect(preload?.body).toEqual({ model: 'yooz-quality-v3' });
    expect(progress).toEqual([0.1, 0.8, undefined]);
  });

  test('a failed load throws with the engine reason, never silently "succeeds"', async () => {
    const server = engineServer((path) => {
      if (path === '/v1/llm/preload') return new Response(null, { status: 202 });
      return Response.json({ loaded: false, state: 'failed', lastError: 'disk full' });
    });
    stop = server.stop;

    await expect(pullModel(server.url, 'm', { sleep: noSleep })).rejects.toThrow(/disk full/);
  });

  test('a stalled download times out and reports where it stalled', async () => {
    const server = engineServer((path) => {
      if (path === '/v1/llm/preload') return new Response(null, { status: 202 });
      return Response.json({ loaded: false, progress: 0.42, state: 'downloading' });
    });
    stop = server.stop;

    let clock = 0;
    await expect(
      pullModel(server.url, 'm', {
        sleep: noSleep,
        now: () => {
          clock += 10_000;
          return clock;
        },
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow(/stalled at 42%/);
  });

  test('completes against an older engine that reports no `state` field', async () => {
    const server = engineServer((path) => {
      if (path === '/v1/llm/preload') return new Response(null, { status: 202 });
      return Response.json({ loaded: true }); // no state, no modelId
    });
    stop = server.stop;

    await expect(pullModel(server.url, 'm', { sleep: noSleep })).resolves.toBeUndefined();
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
