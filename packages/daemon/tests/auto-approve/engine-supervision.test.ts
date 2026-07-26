/**
 * `AutoApproveService` <-> `EngineHost` wiring (#818).
 *
 * `engine-host.test.ts` covers the host's policy in isolation and
 * `engine-process.test.ts` covers the real pidfile/spawn. What is left, and
 * what this file pins, is the part that only exists once they are connected:
 * the service reports a missing engine instead of failing silently, and a burst
 * of failed evaluations triggers ONE repair rather than one per question.
 *
 * No mocks: the service and the host are the real classes, driven through the
 * seams they already expose for exactly this (probe/spawn/pidStore).
 */

import { describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import { EngineHost, type PidStore } from '../../src/auto-approve/engine-host.ts';
import type { EngineProbe } from '../../src/auto-approve/engine-models.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

const UNREACHABLE: EngineProbe = { reachable: false, reason: 'ECONNREFUSED' };
const REACHABLE: EngineProbe = { reachable: true, status: { loaded: true } };

/** In-memory pid record with the production semantics. */
function pidStore(): PidStore {
  let current: number | null = null;
  return {
    read: () => current,
    claim: (pid) => {
      if (current !== null) return false;
      current = pid;
      return true;
    },
    release: (pid) => {
      if (current === pid) current = null;
    },
  };
}

function config(over?: Partial<AutoApproveConfig>): AutoApproveConfig {
  return {
    enabled: true,
    provider: 'yooz',
    model: 'test-model',
    api_key: '',
    // A port nothing listens on: every LLM call fails fast, which is the
    // precondition for the self-heal tests below.
    base_url: 'http://127.0.0.1:19929',
    timeout: 2,
    log_decisions: false,
    allow: [],
    deny: [],
    subagent_alert: [],
    approve_groups: [],
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    escalate_model: '',
    escalate_timeout: 0,
    queue_timeout: 240,
    cache_idle: 0,
    keep_alive: 0,
    engine: 'owned',
    engine_path: '/bin/sleep',
    model_cache: '',
    disable_thinking: true,
    always_escalate_tools: [],
    ...over,
  } as AutoApproveConfig;
}

function serviceWith(opts: {
  probes: EngineProbe[];
  ownership?: 'owned' | 'shared';
  helperPath?: string;
  /** Block every probe until the returned gate is opened, so callers can hold
   *  a repair in flight and observe what concurrent callers do. */
  gated?: boolean;
}) {
  const logs: string[] = [];
  const spawns: string[] = [];
  let probeIndex = 0;
  let probeCalls = 0;
  let openGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const host = new EngineHost(
    {
      baseUrl: 'http://127.0.0.1:19929',
      ownership: opts.ownership ?? 'owned',
      helperPath: opts.helperPath ?? '/bin/sleep',
      startupTimeoutMs: 200,
      probeIntervalMs: 20,
    },
    {
      log: (m) => logs.push(m),
      spawn: (p) => {
        spawns.push(p);
        return 4242;
      },
      kill: () => undefined,
      probe: async () => {
        probeCalls += 1;
        if (opts.gated === true) await gate;
        return opts.probes[Math.min(probeIndex++, opts.probes.length - 1)] ?? UNREACHABLE;
      },
      sleep: async () => undefined,
      pidStore: pidStore(),
    },
  );
  const service = new AutoApproveService(config(), (m) => logs.push(m), host);
  return {
    service,
    logs,
    spawns,
    /** Every `ensureRunning` begins with exactly one attach-probe, so this
     *  counts repair ATTEMPTS regardless of what each one concluded. */
    probeCount: () => probeCalls,
    openGate: () => openGate?.(),
  };
}

describe('AutoApproveService engine supervision (#818)', () => {
  test('attaches to an engine that is already answering, and does not spawn', async () => {
    // The core ownership rule: it does not matter who started the engine, only
    // that one is up. Spawning a second would load a second multi-GB copy of
    // the same weights and lose the port race anyway.
    const h = serviceWith({ probes: [REACHABLE] });
    expect(await h.service.ensureEngine()).toBe(true);
    expect(h.spawns).toEqual([]);
  });

  test('starts one when nothing is answering', async () => {
    const h = serviceWith({ probes: [UNREACHABLE, REACHABLE] });
    expect(await h.service.ensureEngine()).toBe(true);
    expect(h.spawns).toEqual(['/bin/sleep']);
  });

  test('reports the gap instead of failing silently when it cannot start one', async () => {
    // This is the whole point of #818: before it, a machine with no engine
    // degraded to escalating every permission with no explanation anywhere.
    const h = serviceWith({ probes: [UNREACHABLE], helperPath: '' });
    expect(await h.service.ensureEngine()).toBe(false);
    expect(h.logs.join('\n')).toContain('No engine available');
    expect(h.logs.join('\n')).toContain('no helper is bundled');
  });

  test('a guest (engine = "shared") never spawns, and says why', async () => {
    // A super-yooz host owns its engine; starting a second one on remi's port
    // would be remi claiming a process it has no right to supervise.
    const h = serviceWith({ probes: [UNREACHABLE], ownership: 'shared' });
    expect(await h.service.ensureEngine()).toBe(false);
    expect(h.spawns).toEqual([]);
    expect(h.logs.join('\n')).toContain('guest');
  });

  test('a service with no host reports no engine rather than throwing', async () => {
    // Non-engine providers (OpenRouter, llama.cpp) get no EngineHost at all.
    const service = new AutoApproveService(config({ provider: 'openrouter' }), () => undefined);
    expect(await service.ensureEngine()).toBe(false);
  });

  test('a burst of failed evaluations triggers ONE repair, not one per question', async () => {
    // `ensureRunning` waits for a spawned helper to bind, so an unguarded call
    // per failure would pile up overlapping waits -- and on a real machine,
    // every queued permission fails at once against the same dead engine.
    //
    // The probe is GATED so the first repair is provably still in flight when
    // the later evaluations fail. Without that, evals serialize on the single
    // eval slot, each repair finishes before the next failure, and the test
    // passes whether or not the single-flight guard exists at all.
    const h = serviceWith({ probes: [REACHABLE], gated: true });
    const results = await Promise.all([
      h.service.evaluate('Bash', { command: 'echo 1' }),
      h.service.evaluate('Bash', { command: 'echo 2' }),
      h.service.evaluate('Bash', { command: 'echo 3' }),
    ]);

    // Every one escalates: a dead engine must never approve anything.
    for (const r of results) expect(r.decision).toBe('escalate');
    // Exactly one repair attempt is outstanding for three failures. Counting
    // probes rather than spawns is deliberate: the pidfile would collapse
    // concurrent SPAWNS on its own, so a spawn count cannot distinguish the
    // guard working from the pidfile covering for its absence.
    expect(h.probeCount()).toBe(1);

    h.openGate();
    await new Promise((r) => setTimeout(r, 20));
  });

  test('a reachable engine is not "repaired" just because one eval failed', async () => {
    // `evaluate()`'s catch wraps the WHOLE evaluation, including response
    // parsing -- so an unparsable reply from a perfectly healthy engine reaches
    // the heal path exactly like a dead socket does. Repairing there would
    // clear `cacheUnsupported` against the very same process that already told
    // us its clear-cache route is missing, re-arming the doomed request and the
    // log line the degrade exists to suppress (#826).
    //
    // A real HTTP server stands in for the healthy engine, so the reachability
    // probe is a genuine round trip rather than an assumption.
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ loaded: true }),
    });
    try {
      const logs: string[] = [];
      const spawns: string[] = [];
      const base = `http://127.0.0.1:${server.port}`;
      const engineHost = new EngineHost(
        { baseUrl: base, ownership: 'owned', helperPath: '/bin/sleep' },
        {
          log: (m) => logs.push(m),
          spawn: (p) => {
            spawns.push(p);
            return 4242;
          },
          pidStore: pidStore(),
        },
      );
      // `provider` must carry the URL: `resolveProviderUrl('yooz', ...)` returns
      // the fixed loopback 19924 and IGNORES `base_url`, so overriding
      // `base_url` alone would silently point the probe at a different host
      // than the engine under test. A full URL passes through unchanged.
      //
      // The server answers every path, so the ENGINE is healthy; the eval still
      // fails because the generate response carries no `text` field. That is
      // exactly the shape of "healthy engine, unusable reply".
      const service = new AutoApproveService(
        { ...config(), provider: base, base_url: base },
        (m) => logs.push(m),
        engineHost,
      );

      const result = await service.evaluate('Bash', { command: 'echo 1' });
      expect(result.decision).toBe('escalate');
      await new Promise((r) => setTimeout(r, 60));

      // Nothing started: the engine never went anywhere.
      expect(spawns).toEqual([]);
      // And crucially, it was NOT recorded as a new engine. This is the
      // assertion that matters: both the correct and the broken version reach
      // "attached, no spawn", so only the engine-change decision distinguishes
      // them -- and it is the decision that resets `cacheUnsupported`.
      expect(service.engineChangeCount).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test('the single-flight guard clears, so a later failure can still repair', async () => {
    // A stuck `healInFlight` would silently disable self-heal for the life of
    // the daemon -- the exact failure mode #818 exists to remove.
    const h = serviceWith({ probes: [REACHABLE] });
    await h.service.evaluate('Bash', { command: 'echo 1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probeCount()).toBe(1);

    await h.service.evaluate('Bash', { command: 'echo 2' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probeCount()).toBe(2);
  });
});
