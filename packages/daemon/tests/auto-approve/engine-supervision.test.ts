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
}) {
  const logs: string[] = [];
  const spawns: string[] = [];
  let probeIndex = 0;
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
      probe: async () => opts.probes[Math.min(probeIndex++, opts.probes.length - 1)] ?? UNREACHABLE,
      sleep: async () => undefined,
      pidStore: pidStore(),
    },
  );
  const service = new AutoApproveService(config(), (m) => logs.push(m), host);
  return { service, logs, spawns };
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
    const h = serviceWith({ probes: [UNREACHABLE, REACHABLE] });
    const results = await Promise.all([
      h.service.evaluate('Bash', { command: 'echo 1' }),
      h.service.evaluate('Bash', { command: 'echo 2' }),
      h.service.evaluate('Bash', { command: 'echo 3' }),
    ]);

    // Every one escalates: a dead engine must never approve anything.
    for (const r of results) expect(r.decision).toBe('escalate');
    // Let the fire-and-forget repair settle.
    await new Promise((r) => setTimeout(r, 50));
    // Exactly one: >1 means the single-flight guard is gone, 0 means the repair
    // never fired and the daemon would stay broken until restart.
    expect(h.spawns).toEqual(['/bin/sleep']);
  });
});
