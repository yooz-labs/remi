import { describe, expect, test } from 'bun:test';
import {
  EngineHost,
  type EngineHostConfig,
  type PidStore,
} from '../../src/auto-approve/engine-host.ts';
import type { EngineProbe } from '../../src/auto-approve/engine-models.ts';

const UNREACHABLE: EngineProbe = { reachable: false, reason: 'ECONNREFUSED' };
const REACHABLE: EngineProbe = { reachable: true, status: { loaded: true } };

/** A real in-memory PidStore with the production semantics: a live record
 *  blocks a claim, an absent one does not. */
function pidStore(initial: number | null = null): PidStore & { current: number | null } {
  const store = {
    current: initial,
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

function host(
  over: Partial<EngineHostConfig>,
  opts: {
    probes?: EngineProbe[];
    pids?: PidStore;
    spawnPid?: number;
    spawnThrows?: string;
  } = {},
) {
  const logs: string[] = [];
  const killed: number[] = [];
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
        return opts.spawnPid ?? 4242;
      },
      kill: (pid) => killed.push(pid),
      ...(opts.pids ? { pidStore: opts.pids } : {}),
    },
  );
  return { h, logs, spawnCalls, killed };
}

describe('EngineHost — attach first, whoever started it', () => {
  test('attaches to a running engine and starts nothing', async () => {
    // "If the engine is up it does not matter where" — a hub, another
    // session, or the user by hand.
    const { h, spawnCalls } = host({}, { probes: [REACHABLE] });

    const state = await h.ensureRunning();

    expect(state).toEqual({ kind: 'attached', ownership: 'owned' });
    expect(spawnCalls).toHaveLength(0);
    expect(h.startedByUs).toBeNull();
  });

  test('attaching in shared mode reports the guest ownership', async () => {
    const { h } = host({ ownership: 'shared' }, { probes: [REACHABLE] });

    expect(await h.ensureRunning()).toEqual({ kind: 'attached', ownership: 'shared' });
  });
});

describe('EngineHost — ownership boundary', () => {
  test('a SHARED host never starts one, and says whose job it is', async () => {
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

describe('EngineHost — starting a detached engine', () => {
  test('starts headless on remi dedicated port and records the pid', async () => {
    const pids = pidStore();
    const { h, spawnCalls } = host({}, { probes: [UNREACHABLE, REACHABLE], pids });

    const state = await h.ensureRunning();

    expect(state).toEqual({ kind: 'spawned', pid: 4242 });
    expect(spawnCalls[0]?.env).toEqual({
      YOOZ_ENGINE_HEADLESS: '1',
      YOOZ_ENGINE_PORT: '19924',
    });
    expect(pids.current).toBe(4242);
    expect(h.startedByUs).toBe(4242);
  });

  test('an engine that never answers is KILLED and its record released', async () => {
    const pids = pidStore();
    const { h, killed } = host({}, { probes: [UNREACHABLE], pids });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('never answered');
    expect(pids.current).toBeNull(); // no corpse blocking the next attempt
    expect(h.startedByUs).toBeNull();
    expect(killed).toEqual([4242]); // and no wedged headless process left behind
  });

  test('a start failure is reported, never silent', async () => {
    const { h } = host({}, { probes: [UNREACHABLE], spawnThrows: 'ENOENT' });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('ENOENT');
  });

  test('no helper path: reports the gap instead of failing silently', async () => {
    const { h } = host({ helperPath: undefined }, { probes: [UNREACHABLE] });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('no helper');
  });
});

describe('EngineHost — the start race', () => {
  test('a live pid record means someone else is starting: wait and attach, never start a second', async () => {
    // Two daemons booting together must not each load a multi-GB copy.
    const pids = pidStore(999); // another remi already claimed it
    const { h, spawnCalls } = host({}, { probes: [UNREACHABLE, REACHABLE], pids });

    const state = await h.ensureRunning();

    expect(state).toEqual({ kind: 'attached', ownership: 'owned' });
    expect(spawnCalls).toHaveLength(0);
  });

  test('a recorded engine that never comes up is reported, not waited on forever', async () => {
    const pids = pidStore(999);
    const { h } = host({}, { probes: [UNREACHABLE], pids });

    const state = await h.ensureRunning();

    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') expect(state.reason).toContain('999');
  });

  test('the claim is taken BEFORE spawning, so a loser never starts a second engine', async () => {
    // Claiming after spawning would leave a window where two multi-GB
    // processes exist and one has to be killed.
    const pids: PidStore = {
      read: () => 999,
      claim: () => false,
      release: () => {},
    };
    const { h, spawnCalls } = host({}, { probes: [UNREACHABLE, REACHABLE], pids });

    expect(await h.ensureRunning()).toEqual({ kind: 'attached', ownership: 'owned' });
    expect(spawnCalls).toHaveLength(0); // nothing was ever started
  });

  test('losing the reclaim STOPS our redundant engine instead of leaking it', async () => {
    // The claim is released and retaken under the child's pid once we have it.
    // A third process can take the record inside that window -- and then our
    // helper is redundant: the pidfile names THEIR engine while ours keeps
    // running, untracked, holding multi-GB of weights nothing will ever free.
    let claims = 0;
    const pids: PidStore = {
      read: () => 999,
      // First claim (under our own pid, before spawning) succeeds; the reclaim
      // under the child's pid loses to a third process.
      claim: () => ++claims === 1,
      release: () => {},
    };
    const { h, spawnCalls, killed, logs } = host(
      {},
      { probes: [UNREACHABLE, REACHABLE], pids, spawnPid: 777 },
    );

    // We attach to the winner's engine rather than reporting our own.
    expect(await h.ensureRunning()).toEqual({ kind: 'attached', ownership: 'owned' });
    expect(spawnCalls).toHaveLength(1);
    expect(killed).toEqual([777]); // ours was stopped, not left running
    expect(h.startedByUs).toBeNull();
    expect(logs.join('\n')).toContain('stopping ours');
  });
});

describe('EngineHost — lifetime independence', () => {
  test('the engine is NOT tied to this process: no stop on ordinary teardown', async () => {
    // A session daemon that started the engine and then quit must not take
    // auto-approve down for every other session. There is deliberately no
    // stop-on-shutdown path; the explicit teardown is opt-in.
    const pids = pidStore();
    const { h } = host({}, { probes: [UNREACHABLE, REACHABLE], pids });
    await h.ensureRunning();

    expect(h.startedByUs).toBe(4242);
    expect(pids.current).toBe(4242); // still recorded, still running
  });

  test('the explicit teardown kills only an engine THIS process started', async () => {
    const pids = pidStore();
    const { h, killed } = host({}, { probes: [UNREACHABLE, REACHABLE], pids });
    await h.ensureRunning();

    h.stopStartedEngine();

    expect(killed).toEqual([4242]);
    expect(pids.current).toBeNull();
    expect(h.startedByUs).toBeNull();
  });

  test('the explicit teardown is a no-op when we merely ATTACHED', async () => {
    const { h, killed } = host({}, { probes: [REACHABLE] });
    await h.ensureRunning();

    h.stopStartedEngine();

    expect(killed).toEqual([]); // that engine belongs to a hub, a host, or the user
  });

  test('the OPERATOR teardown works from a process that never started it', async () => {
    // `remi engine stop` runs in a fresh CLI process, where startedByUs is
    // null -- the pidfile is the only handle it has.
    const pids = pidStore(7777);
    const killed: number[] = [];

    const pid = EngineHost.stopRecordedEngine(pids, (p) => killed.push(p));

    expect(pid).toBe(7777);
    expect(killed).toEqual([7777]);
    expect(pids.current).toBeNull();
  });

  test('the operator teardown reports when there is nothing recorded', () => {
    expect(EngineHost.stopRecordedEngine(pidStore(null), () => {})).toBeNull();
  });
});

describe('EngineHost — teardown reporting', () => {
  test('a failed kill is NOT reported as a successful stop', async () => {
    // Otherwise an operator sees "could not stop pid N" immediately followed
    // by "stopped pid N" for the same pid.
    const pids = pidStore();
    const logs: string[] = [];
    const probes = [UNREACHABLE, REACHABLE];
    let i = 0;
    const h = new EngineHost(
      {
        baseUrl: 'http://127.0.0.1:19924',
        ownership: 'owned',
        helperPath: '/some/helper',
        startupTimeoutMs: 1000,
        probeIntervalMs: 100,
      },
      {
        log: (m) => logs.push(m),
        sleep: async () => {},
        probe: async () => probes[Math.min(i++, probes.length - 1)] as EngineProbe,
        spawn: () => 4242,
        kill: () => {
          throw new Error('EPERM');
        },
        pidStore: pids,
      },
    );
    await h.ensureRunning();

    h.stopStartedEngine();

    const text = logs.join('\n');
    expect(text).toContain('Could not stop engine pid 4242');
    expect(text).not.toContain('Stopped engine pid 4242');
  });
});
