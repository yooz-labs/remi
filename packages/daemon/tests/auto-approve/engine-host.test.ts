import { describe, expect, test } from 'bun:test';
import {
  EngineHost,
  type EngineHostConfig,
  type SpawnedProcess,
} from '../../src/auto-approve/engine-host.ts';
import type { EngineProbe } from '../../src/auto-approve/engine-models.ts';

const UNREACHABLE: EngineProbe = { reachable: false, reason: 'ECONNREFUSED' };
const REACHABLE: EngineProbe = { reachable: true, status: { loaded: true } };

/** A real fake process object (no mocking framework): records kill(), and lets
 *  a test resolve its exit whenever it likes. */
function fakeProcess(
  pid = 4242,
): SpawnedProcess & { killed: boolean; exit: (code: number) => void } {
  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const proc = {
    pid,
    killed: false,
    kill(): void {
      proc.killed = true;
      resolveExit?.(0);
    },
    exited,
    exit: (code: number) => resolveExit?.(code),
  };
  return proc;
}

function host(
  over: Partial<EngineHostConfig>,
  opts: {
    probes?: EngineProbe[];
    spawn?: (path: string, env: Record<string, string>) => SpawnedProcess;
    spawnThrows?: string;
  } = {},
) {
  const logs: string[] = [];
  const spawnCalls: Array<{ path: string; env: Record<string, string> }> = [];
  const probes = opts.probes ?? [UNREACHABLE];
  let probeIndex = 0;
  const h = new EngineHost(
    {
      baseUrl: 'http://127.0.0.1:19924',
      ownership: 'owned',
      helperPath: '/Applications/Yooz Engine LLM.app/Contents/MacOS/YoozEngineLLM',
      startupTimeoutMs: 1000,
      probeIntervalMs: 100,
      ...over,
    },
    {
      log: (m) => logs.push(m),
      sleep: async () => {},
      probe: async () => probes[Math.min(probeIndex++, probes.length - 1)] as EngineProbe,
      spawn: (path, env) => {
        spawnCalls.push({ path, env });
        if (opts.spawnThrows) throw new Error(opts.spawnThrows);
        return opts.spawn?.(path, env) ?? fakeProcess();
      },
    },
  );
  return { h, logs, spawnCalls };
}

describe('EngineHost — attaching', () => {
  test('attaches to an engine already on the port and spawns nothing', async () => {
    // A hub may already have started the machine's helper; a second one would
    // load a second multi-GB copy of the same weights.
    const { h, spawnCalls } = host({}, { probes: [REACHABLE] });

    const state = await h.ensureRunning();

    expect(state).toEqual({ kind: 'attached', ownership: 'owned' });
    expect(spawnCalls).toHaveLength(0);
    expect(h.isSupervising).toBe(false);
  });

  test('attaching in shared mode reports the guest ownership', async () => {
    const { h } = host({ ownership: 'shared' }, { probes: [REACHABLE] });

    expect(await h.ensureRunning()).toEqual({ kind: 'attached', ownership: 'shared' });
  });
});

describe('EngineHost — ownership boundary', () => {
  test('a SHARED host never spawns, and says whose job it is', async () => {
    // The super-yooz case: the host owns the process; starting a competing one
    // would be wrong even though nothing is answering.
    const { h, spawnCalls } = host({ ownership: 'shared' }, { probes: [UNREACHABLE] });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('guest');
    expect(spawnCalls).toHaveLength(0);
  });

  test('ownsEngine gates every mutating caller', () => {
    expect(host({ ownership: 'owned' }).h.ownsEngine).toBe(true);
    expect(host({ ownership: 'shared' }).h.ownsEngine).toBe(false);
  });
});

describe('EngineHost — spawning', () => {
  test('spawns headless on remi dedicated port and reports the pid', async () => {
    const { h, spawnCalls } = host({}, { probes: [UNREACHABLE, REACHABLE] });

    const state = await h.ensureRunning();

    expect(state).toEqual({ kind: 'spawned', pid: 4242 });
    expect(spawnCalls[0]?.env).toEqual({
      YOOZ_ENGINE_HEADLESS: '1',
      YOOZ_ENGINE_PORT: '19924',
    });
    expect(h.isSupervising).toBe(true);
  });

  test('a helper that starts but never answers is cleaned up, not left running', async () => {
    const proc = fakeProcess();
    const { h } = host({}, { probes: [UNREACHABLE], spawn: () => proc });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('never answered');
    expect(proc.killed).toBe(true); // no half-supervised orphan
    expect(h.isSupervising).toBe(false);
  });

  test('a spawn failure is reported, never silent', async () => {
    const { h } = host({}, { probes: [UNREACHABLE], spawnThrows: 'ENOENT' });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('ENOENT');
  });

  test('no helper path: reports the gap instead of failing silently', async () => {
    // The state on a machine today: nothing to launch, so auto-approve will
    // escalate everything -- which must be explained, not silent (#818).
    const { h } = host({ helperPath: undefined }, { probes: [UNREACHABLE] });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('no helper');
  });
});

describe('EngineHost — lifecycle', () => {
  test('stop() kills a helper this process started', async () => {
    const proc = fakeProcess();
    const { h } = host({}, { probes: [UNREACHABLE, REACHABLE], spawn: () => proc });
    await h.ensureRunning();

    h.stop();

    expect(proc.killed).toBe(true);
    expect(h.isSupervising).toBe(false);
  });

  test('stop() never kills an engine we merely ATTACHED to', async () => {
    // That one belongs to a hub, a super-yooz host, or the user.
    const proc = fakeProcess();
    const { h } = host({}, { probes: [REACHABLE], spawn: () => proc });
    await h.ensureRunning();

    h.stop();

    expect(proc.killed).toBe(false);
  });

  test('a helper that dies is noticed, so a later ensureRunning starts a fresh one', async () => {
    const first = fakeProcess(1);
    const second = fakeProcess(2);
    let call = 0;
    const { h, spawnCalls } = host(
      {},
      {
        probes: [UNREACHABLE, REACHABLE, UNREACHABLE, REACHABLE],
        spawn: () => (call++ === 0 ? first : second),
      },
    );
    await h.ensureRunning();
    expect(h.isSupervising).toBe(true);

    first.exit(1); // crashed
    await Promise.resolve();
    await Promise.resolve();
    expect(h.isSupervising).toBe(false);

    const state = await h.ensureRunning();
    expect(state).toEqual({ kind: 'spawned', pid: 2 });
    expect(spawnCalls).toHaveLength(2);
  });
});
