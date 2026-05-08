import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoApproveService, parseDecision } from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import { applyEnvOverrides, loadConfig } from '../../src/config/config.ts';

/**
 * Integration tests that call real Ollama.
 * These tests are skipped if Ollama is not running on localhost:11434.
 */

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const ollamaAvailable = await isOllamaAvailable();
const describeOllama = ollamaAvailable ? describe : describe.skip;

function makeConfig(overrides?: Partial<AutoApproveConfig>): AutoApproveConfig {
  return {
    enabled: true,
    provider: 'ollama',
    model: 'qwen3.5:4b',
    api_key: '',
    base_url: 'http://localhost:11434/v1',
    timeout: 30,
    log_decisions: false,
    allow: [],
    deny: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    ...overrides,
  };
}

const logs: string[] = [];
const logFn = (msg: string) => logs.push(msg);

// ---------------------------------------------------------------------------
// parseDecision - deterministic unit tests
// ---------------------------------------------------------------------------
describe('parseDecision', () => {
  test('parses valid approve JSON', () => {
    const r = parseDecision('{"decision":"approve","reasoning":"safe read"}');
    expect(r.decision).toBe('approve');
    expect(r.reasoning).toBe('safe read');
  });

  test('parses valid deny JSON', () => {
    const r = parseDecision('{"decision":"deny","reasoning":"destructive"}');
    expect(r.decision).toBe('deny');
    expect(r.reasoning).toBe('destructive');
  });

  test('parses valid escalate JSON', () => {
    const r = parseDecision('{"decision":"escalate","reasoning":"unsure"}');
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toBe('unsure');
  });

  test('handles case-insensitive decision', () => {
    const r = parseDecision('{"decision":"APPROVE","reasoning":"ok"}');
    expect(r.decision).toBe('approve');
  });

  test('handles mixed case decision', () => {
    const r = parseDecision('{"decision":"Escalate","reasoning":"check"}');
    expect(r.decision).toBe('escalate');
  });

  test('missing decision field escalates', () => {
    const r = parseDecision('{"reasoning":"no decision field"}');
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toContain('Unparsable');
  });

  test('missing reasoning field still works', () => {
    const r = parseDecision('{"decision":"approve"}');
    expect(r.decision).toBe('approve');
    expect(r.reasoning).toBe('');
  });

  test('invalid decision value escalates', () => {
    const r = parseDecision('{"decision":"maybe","reasoning":"not sure"}');
    expect(r.decision).toBe('escalate');
  });

  test('invalid JSON escalates', () => {
    const r = parseDecision('this is not json at all');
    expect(r.decision).toBe('escalate');
    expect(r.reasoning).toContain('Unparsable');
  });

  test('empty string escalates', () => {
    const r = parseDecision('');
    expect(r.decision).toBe('escalate');
  });

  test('markdown-wrapped JSON escalates (no guessing)', () => {
    const r = parseDecision('```json\n{"decision":"approve","reasoning":"safe"}\n```');
    expect(r.decision).toBe('escalate');
  });

  test('JSON with extra fields still works', () => {
    const r = parseDecision('{"decision":"deny","reasoning":"bad","confidence":0.9}');
    expect(r.decision).toBe('deny');
    expect(r.reasoning).toBe('bad');
  });

  test('JSON array escalates', () => {
    const r = parseDecision('[{"decision":"approve"}]');
    expect(r.decision).toBe('escalate');
  });

  test('null JSON escalates', () => {
    const r = parseDecision('null');
    expect(r.decision).toBe('escalate');
  });

  test('text mentioning approve does NOT auto-approve', () => {
    // This was the regex fallback bug: substring "approve" in reasoning
    const r = parseDecision('I would not approve this dangerous command');
    expect(r.decision).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// AutoApproveService - error handling
// ---------------------------------------------------------------------------
describe('AutoApproveService - error handling', () => {
  test('escalates on unreachable LLM', async () => {
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://localhost:1', timeout: 1 }),
      logFn,
    );
    const result = await service.evaluate('Bash', { command: 'ls' });
    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toBeTruthy();
  });

  test('escalates on timeout', async () => {
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://localhost:1', timeout: 1 }),
      logFn,
    );
    const result = await service.evaluate('Read', { file_path: '/tmp/test' });
    expect(result.decision).toBe('escalate');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('always logs errors regardless of logDecisions', async () => {
    const errorLogs: string[] = [];
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://localhost:1', timeout: 1, log_decisions: false }),
      (msg) => errorLogs.push(msg),
    );
    await service.evaluate('Bash', { command: 'ls' });
    expect(errorLogs.some((l) => l.includes('[AutoApprove] ERROR'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AutoApproveService - concurrency guard
// ---------------------------------------------------------------------------
describe('AutoApproveService - concurrency guard', () => {
  test('second concurrent evaluation escalates immediately', async () => {
    // Use an unroutable IP so the first request stays in-flight long enough
    // for the second to race against the concurrency flag.
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 3 }),
      logFn,
    );

    const [first, second] = await Promise.all([
      service.evaluate('Bash', { command: 'ls' }),
      service.evaluate('Read', { file_path: '/tmp/test' }),
    ]);

    const decisions = [first, second];
    const concurrentResult = decisions.find(
      (d) => d.reasoning === 'Concurrent evaluation in progress',
    );
    expect(concurrentResult).toBeDefined();
    expect(concurrentResult?.decision).toBe('escalate');
    expect(concurrentResult?.durationMs).toBe(0);
  }, 10000);

  test('two independent service instances do not share state', async () => {
    // Regression: in a multi-session daemon, each session should have its own
    // AutoApproveService instance so they do not serialize through one flag.
    const serviceA = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 3 }),
      logFn,
    );
    const serviceB = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.2', timeout: 3 }),
      logFn,
    );

    // Both run concurrently; neither should trip the other's concurrency guard.
    const [a, b] = await Promise.all([
      serviceA.evaluate('Bash', { command: 'ls' }, 'sessA'),
      serviceB.evaluate('Bash', { command: 'pwd' }, 'sessB'),
    ]);

    expect(a.decision).toBe('escalate');
    expect(b.decision).toBe('escalate');
    // Neither should hit the shared-state guard
    expect(a.reasoning).not.toBe('Concurrent evaluation in progress');
    expect(b.reasoning).not.toBe('Concurrent evaluation in progress');
  }, 10000);
});

// ---------------------------------------------------------------------------
// AutoApproveService - session tag in logs (multi-session visibility)
// ---------------------------------------------------------------------------
describe('AutoApproveService - session tag in logs', () => {
  test('tag appears in concurrency-blocked log', async () => {
    const logs: string[] = [];
    const tagLogFn = (msg: string) => logs.push(msg);
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 3 }),
      tagLogFn,
    );

    // Start one, race a second before it completes
    const [,] = await Promise.all([
      service.evaluate('Bash', { command: 'first' }, 'abc12345'),
      service.evaluate('Bash', { command: 'second' }, 'abc12345'),
    ]);

    const hasTaggedBlock = logs.some((l) =>
      l.includes('[AutoApprove abc12345] Concurrent evaluation blocked'),
    );
    expect(hasTaggedBlock).toBe(true);
  }, 10000);

  test('tag appears in error log on unreachable LLM', async () => {
    const logs: string[] = [];
    const tagLogFn = (msg: string) => logs.push(msg);
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://localhost:1', timeout: 2 }),
      tagLogFn,
    );

    await service.evaluate('Bash', { command: 'ls' }, 'def67890');

    const hasTaggedError = logs.some((l) => l.startsWith('[AutoApprove def67890] ERROR'));
    expect(hasTaggedError).toBe(true);
  }, 10000);

  test('untagged call falls back to plain [AutoApprove] prefix', async () => {
    const logs: string[] = [];
    const tagLogFn = (msg: string) => logs.push(msg);
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://localhost:1', timeout: 2 }),
      tagLogFn,
    );

    await service.evaluate('Bash', { command: 'ls' });

    const hasUntagged = logs.some((l) => l.startsWith('[AutoApprove] ERROR'));
    expect(hasUntagged).toBe(true);
  }, 10000);
});

// ---------------------------------------------------------------------------
// allow / deny lists bypass the LLM (no network calls)
// ---------------------------------------------------------------------------
describe('AutoApproveService - allow/deny lists', () => {
  test('deny match returns immediately without calling LLM', async () => {
    const logs: string[] = [];
    // Point at an unreachable IP; if we hit the LLM, the test will be slow
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 30,
        deny: ['rm -rf /'],
      }),
      (m) => logs.push(m),
    );
    const start = Date.now();
    const result = await service.evaluate('Bash', { command: 'rm -rf /tmp/foo' });
    const elapsed = Date.now() - start;

    expect(result.decision).toBe('deny');
    expect(result.reasoning).toContain('deny-matched');
    expect(result.reasoning).toContain('rm -rf /');
    expect(result.durationMs).toBe(0);
    // Must not have tried the LLM (which would take ~30s on unreachable IP)
    expect(elapsed).toBeLessThan(1000);
    expect(logs.some((l) => l.includes('DENIED'))).toBe(true);
  });

  test('allow match returns immediately without calling LLM', async () => {
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 30,
        allow: ['git push'],
      }),
      (m) => logs.push(m),
    );
    const start = Date.now();
    const result = await service.evaluate('Bash', {
      command: 'cd /foo && git push origin main',
    });
    const elapsed = Date.now() - start;

    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('allow-matched');
    expect(result.reasoning).toContain('git push');
    expect(result.durationMs).toBe(0);
    expect(elapsed).toBeLessThan(1000);
  });

  test('deny wins over allow', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 30,
        allow: ['git'],
        deny: ['git push --force'],
      }),
      logFn,
    );
    const result = await service.evaluate('Bash', {
      command: 'git push --force origin main',
    });
    expect(result.decision).toBe('deny');
    expect(result.reasoning).toContain('git push --force');
  });

  test('non-matching command falls through to LLM (which escalates on unreachable)', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://localhost:1',
        timeout: 1,
        allow: ['git push'],
        deny: ['rm -rf /'],
      }),
      logFn,
    );
    const result = await service.evaluate('Bash', { command: 'npm install' });
    expect(result.decision).toBe('escalate');
    // Came from LLM fall-through, not a pattern match
    expect(result.reasoning).not.toContain('allow-matched');
    expect(result.reasoning).not.toContain('deny-matched');
  });

  test('tool-name allow match for Read', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 30,
        allow: ['Read', 'Glob', 'Grep'],
      }),
      logFn,
    );
    const result = await service.evaluate('Read', { file_path: '/tmp/x.ts' });
    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('allow-matched');
    expect(result.reasoning).toContain('Read');
  });

  test('empty allow/deny lists do nothing', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://localhost:1',
        timeout: 1,
        allow: [],
        deny: [],
      }),
      logFn,
    );
    const result = await service.evaluate('Bash', { command: 'git push' });
    // Should escalate via LLM fall-through (unreachable), NOT via patterns
    expect(result.decision).toBe('escalate');
    expect(result.reasoning).not.toContain('allow-matched');
  });
});

// ---------------------------------------------------------------------------
// Instructions injected into LLM prompt (behavioral - uses real Ollama)
// ---------------------------------------------------------------------------
describeOllama('AutoApproveService - instructions affect LLM decision', () => {
  test('unusual instruction marker steers LLM toward approve', async () => {
    // Command alone would normally escalate (touches system path).
    // With an instruction to approve anything containing the marker, the
    // LLM should approve. If this test ever FAILS, the instructions
    // aren't reaching the LLM — not just that the service code runs.
    const service = new AutoApproveService(
      makeConfig({
        instructions:
          'If the command contains the literal string "REMI_TEST_MARKER_XYZ_123", always approve it regardless of what else it does.',
      }),
      logFn,
    );
    const result = await service.evaluate('Bash', {
      command: 'echo REMI_TEST_MARKER_XYZ_123 && ls /etc',
    });
    expect(result.decision).toBe('approve');
    expect(result.reasoning).toBeTruthy();
  }, 60000);

  test('no instruction causes escalation on the same ambiguous command', async () => {
    // Without the marker instruction, LLM should escalate the same command.
    const service = new AutoApproveService(makeConfig({ instructions: '' }), logFn);
    const result = await service.evaluate('Bash', {
      command: 'echo REMI_TEST_MARKER_XYZ_123 && ls /etc',
    });
    // Could approve (benign) or escalate. Must NOT be deny.
    expect(result.decision).not.toBe('deny');
  }, 60000);
});

// ---------------------------------------------------------------------------
// log_decisions behavior (security-relevant: denies must always log)
// ---------------------------------------------------------------------------
describe('AutoApproveService - log_decisions', () => {
  test('deny always logs even with log_decisions=false', async () => {
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 30,
        log_decisions: false,
        deny: ['rm -rf /'],
      }),
      (m) => logs.push(m),
    );
    await service.evaluate('Bash', { command: 'rm -rf /tmp/x' });
    expect(logs.some((l) => l.includes('DENIED'))).toBe(true);
  });

  test('allow match respects log_decisions=false', async () => {
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 30,
        log_decisions: false,
        allow: ['git status'],
      }),
      (m) => logs.push(m),
    );
    await service.evaluate('Bash', { command: 'git status' });
    // Allow match with log_decisions=false should NOT log the approve
    const hasApproveLog = logs.some((l) => l.includes(': approve') && !l.includes('DENIED'));
    expect(hasApproveLog).toBe(false);
  });

  test('allow match logs when log_decisions=true', async () => {
    const logs: string[] = [];
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 30,
        log_decisions: true,
        allow: ['git status'],
      }),
      (m) => logs.push(m),
    );
    await service.evaluate('Bash', { command: 'git status' });
    expect(logs.some((l) => l.includes('allow-matched'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrency guard vs. allow/deny (deny/allow must not be blocked)
// ---------------------------------------------------------------------------
describe('AutoApproveService - concurrency vs. allow/deny', () => {
  test('deny-match short-circuits even during in-flight LLM call', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 10,
        deny: ['rm -rf /'],
      }),
      logFn,
    );
    // Start a slow LLM call in background; fire a concurrent deny-match
    const slow = service.evaluate('Bash', { command: 'something ambiguous' });
    // Give the first call a moment to set `evaluating = true`
    await new Promise((r) => setTimeout(r, 50));
    const fast = await service.evaluate('Bash', { command: 'rm -rf /tmp/x' });
    expect(fast.decision).toBe('deny');
    expect(fast.reasoning).toContain('deny-matched');
    await slow; // cleanup
  }, 15000);

  test('allow-match short-circuits even during in-flight LLM call', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 10,
        allow: ['git status'],
      }),
      logFn,
    );
    const slow = service.evaluate('Bash', { command: 'something ambiguous' });
    await new Promise((r) => setTimeout(r, 50));
    const fast = await service.evaluate('Bash', { command: 'git status' });
    expect(fast.decision).toBe('approve');
    expect(fast.reasoning).toContain('allow-matched');
    await slow;
  }, 15000);
});

// ---------------------------------------------------------------------------
// Never-throws contract (bad input handling)
// ---------------------------------------------------------------------------
describe('AutoApproveService - never throws contract', () => {
  test('returns escalate even when toolInput is malformed', async () => {
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://localhost:1', timeout: 1 }),
      logFn,
    );
    // biome-ignore lint/suspicious/noExplicitAny: intentionally bad input
    const result = await service.evaluate('Bash', null as any);
    expect(result.decision).toBe('escalate');
    // Should not throw; we got a result.
  });
});

// ---------------------------------------------------------------------------
// End-to-end: config TOML -> loadConfig -> AutoApproveService
// ---------------------------------------------------------------------------
describe('AutoApproveService - config -> service wiring', () => {
  const TEST_DIR = path.join(os.tmpdir(), `remi-aa-config-test-${process.pid}`);
  const TEST_CONFIG = path.join(TEST_DIR, 'config.toml');

  test('TOML config with allow/deny/instructions flows into service correctly', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(
      TEST_CONFIG,
      `
[auto_approve]
enabled = true
provider = "ollama"
model = "gemma4:e2b"
timeout = 5
log_decisions = false
allow = ["git status", "bun test"]
deny = ["rm -rf /"]
instructions = "Be conservative with git push."
`,
    );

    const cfg = applyEnvOverrides(loadConfig(TEST_CONFIG));
    // Point at unreachable IP so we don't hit the LLM in this test
    const service = new AutoApproveService(
      { ...cfg.auto_approve, base_url: 'http://10.255.255.1' },
      logFn,
    );

    // Allow list works end-to-end
    const approve = await service.evaluate('Bash', { command: 'git status' });
    expect(approve.decision).toBe('approve');
    expect(approve.reasoning).toContain('allow-matched');

    // Deny list works end-to-end
    const deny = await service.evaluate('Bash', { command: 'rm -rf /tmp/x' });
    expect(deny.decision).toBe('deny');
    expect(deny.reasoning).toContain('deny-matched');

    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Real Ollama integration
// ---------------------------------------------------------------------------
describeOllama('AutoApproveService - real Ollama integration', () => {
  test('approves a safe read-only command', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Bash', { command: 'git status' });
    expect(['approve', 'escalate']).toContain(result.decision);
    expect(result.reasoning).toBeTruthy();
    if (result.decision !== 'cancelled') expect(result.model).toBeTruthy();
    expect(result.durationMs).toBeGreaterThan(0);
  }, 60000);

  test('approves a file read', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Read', { file_path: '/tmp/test.ts' });
    expect(['approve', 'escalate']).toContain(result.decision);
    expect(result.reasoning).toBeTruthy();
  }, 60000);

  test('escalates or denies a destructive command', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Bash', { command: 'sudo rm -rf /' });
    expect(result.decision).not.toBe('approve');
    expect(result.reasoning).toBeTruthy();
  }, 60000);

  test('escalates a write operation', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Write', {
      file_path: '/tmp/important.config',
      content: 'new content',
    });
    expect(['approve', 'escalate']).toContain(result.decision);
  }, 60000);

  test('handles Grep tool', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Grep', { pattern: 'TODO', path: '/tmp' });
    expect(['approve', 'escalate']).toContain(result.decision);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Multi-choice handling (#399)
// ---------------------------------------------------------------------------
describe('AutoApproveService - multichoice', () => {
  test('skip mode escalates without calling LLM (default)', async () => {
    const service = new AutoApproveService(
      // base_url unreachable on purpose: if the service called the LLM
      // anyway the test would time out instead of returning escalate.
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 60 }),
      logFn,
    );
    const result = await service.evaluate(
      'ExitPlanMode',
      { plan: 'Refactor auth module' },
      undefined,
      ['Approve plan', 'Approve and stay in plan mode', 'Reject plan'],
    );
    expect(result.decision).toBe('escalate');
    if (result.decision !== 'cancelled') {
      expect(result.reasoning).toContain('multi-choice');
      expect(result.durationMs).toBeLessThan(50);
    }
  });

  test('binary 3-set still goes through LLM path (skip mode does not block it)', async () => {
    // Standard Yes/Yes-always/No is binary; multichoice gate must not fire.
    // base_url unreachable -> evaluate falls through to escalate via LLM
    // error path (timeoutMs=1) rather than the multi-choice short-circuit.
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 1 }),
      logFn,
    );
    const result = await service.evaluate('Bash', { command: 'ls' }, undefined, [
      'Yes',
      'Yes, always',
      'No',
    ]);
    expect(result.decision).toBe('escalate');
    if (result.decision !== 'cancelled') {
      // Reasoning is "LLM timeout" or "Error: ..." NOT "multi-choice".
      expect(result.reasoning).not.toContain('multi-choice');
    }
  });

  test('evaluate mode picks an option index from the LLM response', async () => {
    // Spin up a tiny OpenAI-compatible endpoint that returns a deterministic
    // multi-choice JSON. No mocks; this is a real HTTP server.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/chat/completions') {
          return new Response(
            JSON.stringify({
              model: 'fake-model',
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: 'pick',
                      index: 2,
                      reasoning: 'middle option fits the routine default',
                    }),
                  },
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const service = new AutoApproveService(
        makeConfig({
          provider: `http://127.0.0.1:${server.port}`,
          base_url: `http://127.0.0.1:${server.port}`,
          multichoice: 'evaluate',
          timeout: 5,
        }),
        logFn,
      );
      const result = await service.evaluate('ExitPlanMode', { plan: 'Refactor' }, undefined, [
        'Approve',
        'Approve and stay',
        'Reject',
      ]);
      expect(result.decision).toBe('pick');
      if (result.decision === 'pick') {
        expect(result.pickIndex).toBe(2);
        expect(result.reasoning).toContain('middle option');
      }
    } finally {
      server.stop();
    }
  });

  test('evaluate mode falls through to escalate on out-of-range pick', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/chat/completions') {
          return new Response(
            JSON.stringify({
              model: 'fake-model',
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: 'pick',
                      index: 99,
                      reasoning: 'misread the option count',
                    }),
                  },
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const service = new AutoApproveService(
        makeConfig({
          provider: `http://127.0.0.1:${server.port}`,
          base_url: `http://127.0.0.1:${server.port}`,
          multichoice: 'evaluate',
          timeout: 5,
        }),
        logFn,
      );
      const result = await service.evaluate('ExitPlanMode', { plan: 'x' }, undefined, [
        'Approve',
        'Approve and stay',
        'Reject',
      ]);
      expect(result.decision).toBe('escalate');
      if (result.decision !== 'cancelled') {
        expect(result.reasoning).toContain('out-of-range');
      }
    } finally {
      server.stop();
    }
  });

  test('evaluate mode uses multichoice_model when set', async () => {
    let receivedModel: string | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/chat/completions') {
          const body = (await req.json()) as { model?: string };
          receivedModel = body.model;
          return new Response(
            JSON.stringify({
              model: body.model ?? 'fake-model',
              choices: [
                {
                  message: {
                    content: JSON.stringify({ decision: 'escalate', reasoning: 'unsure' }),
                  },
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const service = new AutoApproveService(
        makeConfig({
          provider: `http://127.0.0.1:${server.port}`,
          base_url: `http://127.0.0.1:${server.port}`,
          model: 'main-model',
          multichoice: 'evaluate',
          multichoice_model: 'smart-model',
          timeout: 5,
        }),
        logFn,
      );
      await service.evaluate('ExitPlanMode', { plan: 'x' }, undefined, [
        'Approve plan',
        'Approve and stay',
        'Reject plan',
      ]);
      expect(receivedModel).toBe('smart-model');
    } finally {
      server.stop();
    }
  });

  test('evaluate mode falls back to main model when multichoice_model is empty', async () => {
    let receivedModel: string | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/chat/completions') {
          const body = (await req.json()) as { model?: string };
          receivedModel = body.model;
          return new Response(
            JSON.stringify({
              model: body.model ?? 'fake-model',
              choices: [
                {
                  message: {
                    content: JSON.stringify({ decision: 'escalate', reasoning: 'unsure' }),
                  },
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const service = new AutoApproveService(
        makeConfig({
          provider: `http://127.0.0.1:${server.port}`,
          base_url: `http://127.0.0.1:${server.port}`,
          model: 'main-model',
          multichoice: 'evaluate',
          multichoice_model: '',
          timeout: 5,
        }),
        logFn,
      );
      await service.evaluate('ExitPlanMode', { plan: 'x' }, undefined, [
        'Approve plan',
        'Approve and stay',
        'Reject plan',
      ]);
      expect(receivedModel).toBe('main-model');
    } finally {
      server.stop();
    }
  });
});
