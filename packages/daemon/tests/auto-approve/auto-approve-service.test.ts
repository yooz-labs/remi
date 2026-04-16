import { describe, expect, test } from 'bun:test';
import { AutoApproveService, parseDecision } from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

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
// Real Ollama integration
// ---------------------------------------------------------------------------
describeOllama('AutoApproveService - real Ollama integration', () => {
  test('approves a safe read-only command', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Bash', { command: 'git status' });
    expect(['approve', 'escalate']).toContain(result.decision);
    expect(result.reasoning).toBeTruthy();
    expect(result.model).toBeTruthy();
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
