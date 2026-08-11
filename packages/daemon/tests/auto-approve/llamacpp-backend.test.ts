/**
 * #822 slice 1: remi supervises `llama-server` instead of making the user run
 * it under nohup.
 *
 * Everything here drives the REAL thing it names — a real HTTP server for the
 * probe, real files with real permission bits for PATH resolution. The probe
 * tests in particular would be worthless against a stubbed `fetch`: the bug
 * this module exists to avoid is requesting `/v1/health` instead of `/health`,
 * and only a server that actually 404s the wrong path can catch it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EngineHost,
  type EngineHostConfig,
  type PidStore,
} from '../../src/auto-approve/engine-host.ts';
import { spawnDetachedEngine } from '../../src/auto-approve/engine-process.ts';
import {
  healthUrl,
  llamaServerArgs,
  probeLlamaCpp,
  resolveLlamaServer,
} from '../../src/auto-approve/llamacpp-backend.ts';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-llamacpp-'));
afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('healthUrl', () => {
  test('drops the /v1 suffix the llamacpp base URL carries', () => {
    // The regression this pins: `llamacpp`'s base URL ends in /v1 (it is
    // dispatched through the openai kind), but /health is served at the ROOT.
    // Naively joining yields /v1/health -- the same /v1/v1 class of bug
    // AGENTS.md already records for warmModel.
    expect(healthUrl('http://127.0.0.1:19924/v1')).toBe('http://127.0.0.1:19924/health');
  });

  test('works on a root base URL too', () => {
    expect(healthUrl('http://127.0.0.1:19924')).toBe('http://127.0.0.1:19924/health');
  });

  test('a malformed base URL is returned as-is rather than throwing', () => {
    // The probe's contract is to REPORT unreachable, never to throw: an
    // exception escaping here becomes a silent permanent escalation (#818).
    expect(healthUrl('not a url')).toBe('not a url');
  });
});

describe('llamaServerArgs', () => {
  test('passes the model to -hf with its quant suffix intact', () => {
    const args = llamaServerArgs('YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0', 19924);
    // The suffix is load-bearing: -hf with no tag prefers Q4_K_M/Q8_0 and the
    // YoozLabs repos publish only Q4_0, so a stripped tag resolves no file.
    expect(args).toEqual([
      '-hf',
      'YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0',
      '--host',
      '127.0.0.1',
      '--port',
      '19924',
    ]);
  });

  test('binds loopback, never the daemon bind address', () => {
    // The eval backend is remi's own sidecar. Widening it would hand any host
    // that can reach the port a free LLM -- the exact class of default #880
    // spent a release closing.
    expect(llamaServerArgs('m', 19924)).toContain('127.0.0.1');
    expect(llamaServerArgs('m', 19924)).not.toContain('0.0.0.0');
  });
});

describe('resolveLlamaServer', () => {
  const binDir = path.join(TEST_DIR, 'bin');
  const emptyDir = path.join(TEST_DIR, 'empty');

  beforeAll(() => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'llama-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  test('finds an executable llama-server on PATH', () => {
    const found = resolveLlamaServer({ PATH: `${emptyDir}${path.delimiter}${binDir}` });
    expect(found).toBe(path.join(binDir, 'llama-server'));
  });

  test('returns undefined when it is not installed', () => {
    // This is what turns into the actionable "install it" reason rather than a
    // throw: remi never installs llama-server, so the user must be told.
    expect(resolveLlamaServer({ PATH: emptyDir })).toBeUndefined();
  });

  test('returns undefined when PATH is unset', () => {
    expect(resolveLlamaServer({})).toBeUndefined();
  });

  test('a non-executable file of the right name is not accepted', () => {
    const noExecDir = path.join(TEST_DIR, 'noexec');
    fs.mkdirSync(noExecDir, { recursive: true });
    fs.writeFileSync(path.join(noExecDir, 'llama-server'), 'not executable', { mode: 0o644 });
    expect(resolveLlamaServer({ PATH: noExecDir })).toBeUndefined();
  });

  test('a DIRECTORY named llama-server is not accepted', () => {
    // Directories carry the execute bit (it means "traversable"), so an
    // access(X_OK) check alone would happily return a path that cannot be
    // spawned -- and the failure would surface as a spawn error at boot.
    const dirTrap = path.join(TEST_DIR, 'dirtrap');
    fs.mkdirSync(path.join(dirTrap, 'llama-server'), { recursive: true });
    expect(resolveLlamaServer({ PATH: dirTrap })).toBeUndefined();
  });
});

describe('probeLlamaCpp against a real server', () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  /** Flipped per test to drive the two states that matter at startup. */
  let health: { status: number } = { status: 200 };
  /** Every path the probe requested, so a wrong URL is provable, not assumed. */
  let requested: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requested.push(url.pathname);
        // Only /health answers. Anything else 404s, which is what makes the
        // "/v1/health would be wrong" assertion real rather than decorative.
        if (url.pathname === '/health') return new Response('', { status: health.status });
        return new Response('not found', { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}/v1`;
  });
  afterAll(() => {
    server.stop(true);
  });

  test('200 on /health is reachable, and /health is the path actually requested', async () => {
    requested = [];
    health = { status: 200 };
    const probe = await probeLlamaCpp(base);
    expect(probe.reachable).toBe(true);
    expect(requested).toEqual(['/health']);
    expect(requested).not.toContain('/v1/health');
  });

  test('503 while the GGUF loads is NOT reachable', async () => {
    // llama-server answers 503 until the model is loaded. Treating that as
    // reachable would dispatch an eval into a server that cannot serve it and
    // burn the hook budget waiting.
    health = { status: 503 };
    const probe = await probeLlamaCpp(base);
    expect(probe.reachable).toBe(false);
    expect(probe.reason).toContain('503');
  });

  test('a closed port is unreachable with a reason, never a throw', async () => {
    // Port 1 on loopback: nothing listens, and the probe must turn that into a
    // value. An exception here is the silent-escalation failure of #818.
    const probe = await probeLlamaCpp('http://127.0.0.1:1/v1', 500);
    expect(probe.reachable).toBe(false);
    expect(probe.reason).toBeDefined();
  });
});

/** A real in-memory PidStore with production semantics. */
function pidStore(): PidStore & { current: number | null } {
  const store = {
    current: null as number | null,
    read: () => store.current,
    claim: (pid: number) => {
      if (store.current !== null) return false;
      store.current = pid;
      return true;
    },
    release: (pid: number) => {
      if (store.current === pid) store.current = null;
    },
  };
  return store;
}

function llamaHost(
  over: Partial<EngineHostConfig> = {},
  opts: { reachable?: boolean[]; installed?: string | undefined } = {},
) {
  const logs: string[] = [];
  const spawnCalls: Array<{
    path: string;
    args: readonly string[];
    env: Record<string, string>;
  }> = [];
  const reach = opts.reachable ?? [false, true];
  let i = 0;
  const h = new EngineHost(
    {
      baseUrl: 'http://127.0.0.1:19924/v1',
      backend: 'llamacpp',
      model: 'YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0',
      ownership: 'owned',
      startupTimeoutMs: 500,
      probeIntervalMs: 50,
      ...over,
    },
    {
      log: (m) => logs.push(m),
      sleep: async () => {},
      probe: async () => ({ reachable: reach[Math.min(i++, reach.length - 1)] ?? false }),
      spawn: (p, args, env) => {
        spawnCalls.push({ path: p, args, env });
        return 5150;
      },
      kill: () => {},
      // Keep the test off the developer's real PATH: whether this machine
      // happens to have llama-server installed must not decide the outcome.
      installHelper: async () => ('installed' in opts ? opts.installed : '/usr/bin/llama-server'),
      pidStore: pidStore(),
    },
  );
  return { h, logs, spawnCalls };
}

describe('EngineHost with backend = llamacpp', () => {
  test('spawns llama-server with -hf and the reserved port', async () => {
    const { h, spawnCalls } = llamaHost();
    const state = await h.ensureRunning();
    expect(state.kind).toBe('spawned');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.path).toBe('/usr/bin/llama-server');
    expect(spawnCalls[0]?.args).toEqual([
      '-hf',
      'YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0',
      '--host',
      '127.0.0.1',
      '--port',
      '19924',
    ]);
  });

  test('passes NO YOOZ_ENGINE_* environment to llama-server', async () => {
    // Those variables configure the Yooz engine and mean nothing here.
    // Setting them anyway would be a misleading description in the process
    // table and in the log.
    const { h, spawnCalls } = llamaHost();
    await h.ensureRunning();
    expect(spawnCalls[0]?.env).toEqual({});
  });

  test('a model cache goes to LLAMA_CACHE, not HF_HUB_CACHE', async () => {
    // HF_HUB_CACHE is the Python huggingface_hub variable the ENGINE reads.
    // Naming it here would silently ignore the configured cache and
    // re-download multi-GB weights into llama.cpp's default.
    const { h, spawnCalls } = llamaHost({ modelCache: '/models' });
    await h.ensureRunning();
    expect(spawnCalls[0]?.env).toEqual({ LLAMA_CACHE: '/models' });
    expect(spawnCalls[0]?.env['HF_HUB_CACHE']).toBeUndefined();
  });

  test('attaches to a llama-server already running, without spawning', async () => {
    const { h, spawnCalls } = llamaHost({}, { reachable: [true] });
    const state = await h.ensureRunning();
    expect(state.kind).toBe('attached');
    expect(spawnCalls).toHaveLength(0);
  });

  test('a missing binary reports how to install it, and never spawns', async () => {
    const { h, logs, spawnCalls } = llamaHost({}, { installed: undefined });
    const state = await h.ensureRunning();
    expect(state.kind).toBe('unavailable');
    if (state.kind !== 'unavailable') throw new Error('unreachable');
    // The generic engine wording ("no helper available") would imply a
    // download that is never coming: remi does not install llama-server.
    expect(state.reason).toContain('not on PATH');
    expect(state.reason).toContain('brew install llama.cpp');
    expect(spawnCalls).toHaveLength(0);
    expect(logs.join('\n')).toContain('not on PATH');
  });

  test('an empty model is refused before anything is spawned', async () => {
    // llama.cpp loads ONE model at process start, so an empty id is `-hf ''`,
    // which fails inside the child where the only trace is a log file nobody
    // is reading.
    const { h, spawnCalls } = llamaHost({ model: '' });
    const state = await h.ensureRunning();
    expect(state.kind).toBe('unavailable');
    if (state.kind !== 'unavailable') throw new Error('unreachable');
    expect(state.reason).toContain('auto_approve.model is empty');
    expect(spawnCalls).toHaveLength(0);
  });

  test('END TO END: really spawns a server that binds the port it was told', async () => {
    // The unit tests above inject `spawn`, so none of them exercises
    // `spawnDetachedEngine` with argv -- the very thing #822 widened. A stand-in
    // "llama-server" makes the whole chain real: EngineHost builds the argv,
    // the production detached spawn passes it, the child PARSES --port and
    // binds it, and the production /health probe finds it.
    //
    // The port is the assertion. A child that binds a port it was not told
    // about never answers, so this cannot pass on a wrong or dropped argv --
    // which an `expect(args).toEqual([...])` against a fake spawn can.
    const port = 18000 + (Math.floor(process.uptime() * 1000) % 900);
    const argvLog = path.join(TEST_DIR, 'argv.json');
    const serverTs = path.join(TEST_DIR, 'fake-llama-server.ts');
    fs.writeFileSync(
      serverTs,
      `const argv = process.argv.slice(2);
require('node:fs').writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));
const port = Number(argv[argv.indexOf('--port') + 1]);
const host = argv[argv.indexOf('--host') + 1];
Bun.serve({ port, hostname: host, fetch(req) {
  return new URL(req.url).pathname === '/health'
    ? new Response('', { status: 200 })
    : new Response('no', { status: 404 });
} });
await new Promise(() => {});
`,
    );
    const binDir = path.join(TEST_DIR, 'realbin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeBin = path.join(binDir, 'llama-server');
    fs.writeFileSync(fakeBin, `#!/bin/sh\nexec ${process.execPath} ${serverTs} "$@"\n`, {
      mode: 0o755,
    });

    const logs: string[] = [];
    // The PRODUCTION spawn and the PRODUCTION probe (both defaulted), with only
    // the pidfile and log file redirected: `EngineHost.real` would otherwise
    // claim the developer's real ~/.remi/engine.pid and fight a running daemon.
    const testLog = path.join(TEST_DIR, 'llama-server.log');
    const real = new EngineHost(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        backend: 'llamacpp',
        model: 'YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0',
        ownership: 'owned',
        helperPath: fakeBin,
        startupTimeoutMs: 15_000,
        probeIntervalMs: 200,
      },
      {
        log: (m) => logs.push(m),
        pidStore: pidStore(),
        spawn: (p, args, env) => spawnDetachedEngine(p, args, env, testLog),
      },
    );

    try {
      const state = await real.ensureRunning();
      expect(state.kind).toBe('spawned');
      // It answered on /health, through the real probe, at the real port.
      expect(await real.probeOnce()).toBe(true);
      // And it was launched with the model on -hf.
      const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8')) as string[];
      expect(argv).toContain('-hf');
      expect(argv[argv.indexOf('-hf') + 1]).toBe('YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0');
    } finally {
      real.stopStartedEngine();
    }
  }, 30_000);

  test('the engine path is unchanged: no args, YOOZ_ENGINE_* env', async () => {
    // The two-sided half of this change. Widening the spawn seam must not have
    // altered what the engine is launched with.
    const spawnCalls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const h = new EngineHost(
      {
        baseUrl: 'http://127.0.0.1:19924',
        ownership: 'owned',
        helperPath: '/Applications/Yooz.app/Contents/MacOS/Yooz',
        startupTimeoutMs: 500,
        probeIntervalMs: 50,
      },
      {
        log: () => {},
        sleep: async () => {},
        probe: (() => {
          let n = 0;
          return async () => ({ reachable: n++ > 0 });
        })(),
        spawn: (_p, args, env) => {
          spawnCalls.push({ args, env });
          return 4242;
        },
        kill: () => {},
        installHelper: async () => undefined,
        pidStore: pidStore(),
      },
    );
    await h.ensureRunning();
    expect(spawnCalls[0]?.args).toEqual([]);
    expect(spawnCalls[0]?.env).toEqual({
      YOOZ_ENGINE_HEADLESS: '1',
      YOOZ_ENGINE_PORT: '19924',
    });
  });
});
