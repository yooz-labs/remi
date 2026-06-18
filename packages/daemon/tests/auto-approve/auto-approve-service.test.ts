import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AutoApproveService,
  normalisePermissionSuggestion,
  parseDecision,
} from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import { applyEnvOverrides, loadConfig } from '../../src/config/config.ts';

/**
 * Integration tests that call real Ollama.
 * These tests are skipped if Ollama is not running on localhost:11434.
 */

async function isOllamaAvailable(): Promise<boolean> {
  // SKIP_LLM_TESTS=1 lets a developer pin GPU-heavy LLM tests off without
  // killing the local Ollama daemon (which they may want running for other
  // workflows). Honored by every Ollama-gated test in this directory.
  if (process.env['SKIP_LLM_TESTS'] === '1') return false;
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
    approve_groups: [],
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    escalate_model: '',
    escalate_timeout: 0,
    queue_timeout: 240,
    disable_thinking: false,
    always_escalate_tools: [],
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

  test('markdown-fenced JSON is parsed (qwen3.6:35b emits ```json fences)', () => {
    const r = parseDecision('```json\n{"decision":"approve","reasoning":"safe"}\n```');
    expect(r.decision).toBe('approve');
    expect(r.reasoning).toBe('safe');
  });

  test('bare ``` fence (no language tag) is parsed', () => {
    const r = parseDecision('```\n{"decision":"deny","reasoning":"destructive"}\n```');
    expect(r.decision).toBe('deny');
  });

  test('JSON with a short preamble before the object is parsed', () => {
    const r = parseDecision('Here is my verdict:\n{"decision":"escalate","reasoning":"unsure"}');
    expect(r.decision).toBe('escalate');
  });

  test('fenced object whose reasoning contains braces parses without miscounting', () => {
    const r = parseDecision('```json\n{"decision":"deny","reasoning":"matches rm -rf {a,b}"}\n```');
    expect(r.decision).toBe('deny');
    expect(r.reasoning).toContain('{a,b}');
  });

  test('free text mentioning a decision word still escalates (no keyword guessing)', () => {
    const r = parseDecision('```\nI would approve this but it is risky\n```');
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
// normalisePermissionSuggestion - converts heterogeneous entries to LLM
// labels. Strings pass through; objects are JSON-serialised so the LLM
// can read addDirectories/setMode/etc shapes.
// ---------------------------------------------------------------------------
describe('normalisePermissionSuggestion', () => {
  test('passes a plain string through', () => {
    expect(normalisePermissionSuggestion('Yes')).toBe('Yes');
  });

  test('trims surrounding whitespace on strings', () => {
    expect(normalisePermissionSuggestion('  Always  ')).toBe('Always');
  });

  test('drops empty / whitespace-only strings', () => {
    expect(normalisePermissionSuggestion('')).toBeNull();
    expect(normalisePermissionSuggestion('   ')).toBeNull();
  });

  test('JSON-serialises addDirectories object entry', () => {
    const out = normalisePermissionSuggestion({
      type: 'addDirectories',
      directories: ['/Users/foo/.claude/agents'],
      destination: 'session',
    });
    expect(out).toContain('"type":"addDirectories"');
    expect(out).toContain('/Users/foo/.claude/agents');
    expect(out).toContain('"destination":"session"');
  });

  test('JSON-serialises setMode object entry', () => {
    const out = normalisePermissionSuggestion({
      type: 'setMode',
      mode: 'bypassPermissions',
      destination: 'session',
    });
    expect(out).toContain('"type":"setMode"');
    expect(out).toContain('"mode":"bypassPermissions"');
  });

  test('truncates very long serialisations to keep the prompt small', () => {
    const giant = {
      type: 'addDirectories',
      directories: Array.from({ length: 50 }, (_, i) => `/Users/foo/dir-${i}/with-a-long-path`),
    };
    const out = normalisePermissionSuggestion(giant);
    expect(out).not.toBeNull();
    expect(out?.length).toBeLessThanOrEqual(200);
    expect(out?.endsWith('...')).toBe(true);
  });

  test('drops null / undefined / non-object primitives', () => {
    expect(normalisePermissionSuggestion(null)).toBeNull();
    expect(normalisePermissionSuggestion(undefined)).toBeNull();
    expect(normalisePermissionSuggestion(42)).toBeNull();
    expect(normalisePermissionSuggestion(true)).toBeNull();
  });

  test('drops the empty object shape (no useful payload)', () => {
    expect(normalisePermissionSuggestion({})).toBeNull();
  });

  test('returns null on a circular-reference object instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(normalisePermissionSuggestion(circular)).toBeNull();
  });

  test('drops Map and Set (both stringify to "{}")', () => {
    // The auto-approve service depends on this null return: a non-null
    // serialisation that round-trips to an empty-shape would inflate
    // normalisedSuggestions.length and confuse the index-mismatch guard.
    expect(normalisePermissionSuggestion(new Map())).toBeNull();
    expect(normalisePermissionSuggestion(new Set())).toBeNull();
  });

  test('keeps toJSON output when it produces a non-empty JSON shape', () => {
    // Documents the accepted behavior: an object with a custom toJSON
    // that returns a value gets serialised via that value. The index-
    // mismatch guard in evaluate() catches downstream issues if any.
    const obj = { toJSON: () => ({ type: 'custom', n: 1 }) };
    const out = normalisePermissionSuggestion(obj);
    expect(out).toBe('{"type":"custom","n":1}');
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

  test('evaluate-mode index-mismatch guard escalates without calling the LLM', async () => {
    // permission_suggestions = ['Save', 'Discard', {}]: 2 non-binary string
    // labels route to multi-choice (after the object-only fix, the bare
    // `{}` is not enough on its own — we need real picky labels). In
    // evaluate mode, the empty object drops in normalisation, so
    // normalisedSuggestions=['Save','Discard'] (length 2) while the raw
    // array length stays 3. The LLM's pick index would address the
    // normalised list but inject() sends it to the PTY, which interprets
    // against the original positions. Escalating before any LLM call is
    // the only safe path. `base_url` points at a black hole so a missed
    // guard would surface as a timeout instead of a fast escalate.
    const callLogs: string[] = [];
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://localhost:1',
        timeout: 5,
        multichoice: 'evaluate',
        log_decisions: true,
      }),
      (msg) => callLogs.push(msg),
    );
    const start = Date.now();
    const result = await service.evaluate('CustomTool', { x: 1 }, undefined, [
      'Save',
      'Discard',
      {} as unknown,
    ]);
    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('unreadable entries');
    expect(Date.now() - start).toBeLessThan(2000); // no LLM call attempted
    expect(callLogs.some((l) => l.includes('escalate') && l.includes('unreadable entries'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// AutoApproveService - concurrency serialization (#551)
// ---------------------------------------------------------------------------
describe('AutoApproveService - concurrency serialization', () => {
  test('concurrent evaluations serialize instead of escalate-on-busy', async () => {
    // #551: a second request that arrives while the first eval is in flight
    // must QUEUE and get its own real decision, NOT escalate-on-busy. Use an
    // unroutable IP so both calls reach the LLM path and time out; the old
    // behavior gave the second an instant (0ms) "Concurrent evaluation in
    // progress" escalate, the new behavior runs both (durationMs > 0).
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 3 }),
      logFn,
    );

    const [first, second] = await Promise.all([
      service.evaluate('Bash', { command: 'ls' }),
      service.evaluate('Read', { file_path: '/tmp/test' }),
    ]);

    // The regression guard: under the OLD single-flight gate the second result
    // carried 'Concurrent evaluation in progress' (an instant busy-bail). With
    // serialization neither ever does — both take the real decision path and
    // escalate via the failed LLM reach. (We do NOT assert durationMs: an
    // unroutable IP hangs to the timeout on some networks but fails fast on
    // others/CI. Deterministic serialization timing is covered in
    // serialize.test.ts with a gated server.)
    expect(first.reasoning).not.toBe('Concurrent evaluation in progress');
    expect(second.reasoning).not.toBe('Concurrent evaluation in progress');
    expect(first.decision).toBe('escalate');
    expect(second.decision).toBe('escalate');
  }, 15000);

  test('two independent service instances do not share a queue', async () => {
    // Regression: in a multi-session daemon, each session should have its own
    // AutoApproveService instance so they do not serialize through one queue.
    const serviceA = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 3 }),
      logFn,
    );
    const serviceB = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.2', timeout: 3 }),
      logFn,
    );

    // Both run concurrently; neither should queue behind the other's slot.
    const [a, b] = await Promise.all([
      serviceA.evaluate('Bash', { command: 'ls' }, 'sessA'),
      serviceB.evaluate('Bash', { command: 'pwd' }, 'sessB'),
    ]);

    expect(a.decision).toBe('escalate');
    expect(b.decision).toBe('escalate');
    // Neither should hit the retired shared-state busy guard
    expect(a.reasoning).not.toBe('Concurrent evaluation in progress');
    expect(b.reasoning).not.toBe('Concurrent evaluation in progress');
  }, 15000);
});

// ---------------------------------------------------------------------------
// AutoApproveService - session tag in logs (multi-session visibility)
// ---------------------------------------------------------------------------
describe('AutoApproveService - session tag in logs', () => {
  test('tag appears in logs for serialized concurrent evals', async () => {
    const logs: string[] = [];
    const tagLogFn = (msg: string) => logs.push(msg);
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 3 }),
      tagLogFn,
    );

    // Start one, queue a second behind it; both produce tagged logs.
    const [,] = await Promise.all([
      service.evaluate('Bash', { command: 'first' }, 'abc12345'),
      service.evaluate('Bash', { command: 'second' }, 'abc12345'),
    ]);

    const hasTagged = logs.some((l) => l.includes('[AutoApprove abc12345]'));
    expect(hasTagged).toBe(true);
  }, 15000);

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

describe('AutoApproveService - permission groups (#494)', () => {
  // Unreachable base_url: if any of these hit the LLM, the test is slow and the
  // group fast-path is broken.
  function groupService(over: Partial<AutoApproveConfig>): AutoApproveService {
    return new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 30, ...over }),
      logFn,
    );
  }

  test('approve_groups fast-paths a read-by-definition Bash command without the LLM', async () => {
    // The pipe spans two groups: `git show` (vcs-read) and `sed -n` (read-only).
    // Every segment must be covered, so both groups are required.
    const service = groupService({ approve_groups: ['read-only', 'vcs-read'] });
    const start = Date.now();
    const result = await service.evaluate('Bash', {
      command: "git show abc:file | sed -n '1,40p'",
    });
    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('approve-matched group');
    expect(result.reasoning).toContain('vcs-read:git show');
    expect(result.durationMs).toBe(0);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('approve_groups fast-paths a read tool', async () => {
    const service = groupService({ approve_groups: ['read-only'] });
    const result = await service.evaluate('Grep', { pattern: 'foo' });
    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('read-only:Grep');
  });

  test('deny_groups wins over approve_groups', async () => {
    const service = groupService({
      approve_groups: ['build-test'],
      deny_groups: ['build-test'],
    });
    const result = await service.evaluate('Bash', { command: 'bun test' });
    expect(result.decision).toBe('deny');
    expect(result.reasoning).toContain('deny-matched group');
  });

  test('a mutating command not covered by any group falls through to the LLM', async () => {
    const service = groupService({
      approve_groups: ['read-only', 'vcs-read', 'build-test'],
      base_url: 'http://localhost:1',
      timeout: 1,
    });
    const result = await service.evaluate('Bash', { command: 'git push origin main' });
    expect(result.decision).toBe('escalate');
    expect(result.reasoning).not.toContain('approve-matched group');
  });

  test('empty approve_groups does nothing', async () => {
    const service = groupService({
      approve_groups: [],
      base_url: 'http://localhost:1',
      timeout: 1,
    });
    const result = await service.evaluate('Bash', { command: 'git status' });
    expect(result.decision).toBe('escalate');
    expect(result.reasoning).not.toContain('approve-matched group');
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

// ---------------------------------------------------------------------------
// Multi-choice review-fix: regression guards (#400 review)
// ---------------------------------------------------------------------------
describe('AutoApproveService - multichoice regression guards', () => {
  test("Edit's real ['Yes','Always','No'] is binary, not multi-choice", async () => {
    // Without this guard, the exact-label detector misclassified Edit's
    // real shape as multi-choice and silently escalated every Edit/Write
    // permission under the default skip mode (#400 review, critical).
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/chat/completions') {
          return new Response(
            JSON.stringify({
              model: 'fake-model',
              choices: [{ message: { content: '{"decision":"approve","reasoning":"safe edit"}' } }],
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
          // multichoice = 'skip' is default; if Edit were classified as
          // multi-choice it would short-circuit to escalate without
          // hitting the LLM. We use a real LLM endpoint so the test
          // FAILS LOUDLY if the classifier regresses.
          timeout: 5,
        }),
        logFn,
      );
      const result = await service.evaluate(
        'Edit',
        { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
        undefined,
        ['Yes', 'Always', 'No'],
      );
      expect(result.decision).toBe('approve');
      if (result.decision !== 'cancelled') {
        expect(result.reasoning).not.toContain('multi-choice');
      }
    } finally {
      server.stop();
    }
  });

  test('deny pattern still wins on a multi-choice prompt', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 60,
        deny: ['ExitPlanMode'],
      }),
      logFn,
    );
    const result = await service.evaluate('ExitPlanMode', { plan: 'x' }, undefined, [
      'Approve',
      'Approve and stay',
      'Reject',
    ]);
    expect(result.decision).toBe('deny');
    expect(result.reasoning).toContain('deny-matched');
  });

  test('allow pattern still wins on a multi-choice prompt', async () => {
    const service = new AutoApproveService(
      makeConfig({
        base_url: 'http://10.255.255.1',
        timeout: 60,
        allow: ['ExitPlanMode'],
      }),
      logFn,
    );
    const result = await service.evaluate('ExitPlanMode', { plan: 'x' }, undefined, [
      'Approve',
      'Approve and stay',
      'Reject',
    ]);
    expect(result.decision).toBe('approve');
    expect(result.reasoning).toContain('allow-matched');
  });

  test('skip mode does not call the LLM when multichoice_model is set', async () => {
    // multichoice_model is consulted only in evaluate mode; skip mode
    // must short-circuit before any LLM call regardless of model config.
    let llmCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/chat/completions') {
          llmCalls++;
          return new Response(
            JSON.stringify({
              model: 'should-not-be-called',
              choices: [{ message: { content: '{"decision":"escalate","reasoning":"x"}' } }],
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
          multichoice: 'skip',
          multichoice_model: 'smart-model',
          timeout: 5,
        }),
        logFn,
      );
      const result = await service.evaluate('ExitPlanMode', { plan: 'x' }, undefined, [
        'Yes',
        'No',
      ]);
      expect(result.decision).toBe('escalate');
      expect(llmCalls).toBe(0);
    } finally {
      server.stop();
    }
  });

  test('non-string entries in permission_suggestions do not crash', async () => {
    // Garbage entries (null, raw objects) co-exist with picky labels.
    // The string subset ['Maybe', 'Yes', 'No'] has a non-binary label
    // ('Maybe') → multi-choice → skip mode short-circuits to escalate
    // before any LLM call. The test pins that the classifier ignores
    // non-string entries (rather than crashing on .toLowerCase()) AND
    // that classification reads the string subset, not the raw length.
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://10.255.255.1', timeout: 60 }),
      logFn,
    );
    const result = await service.evaluate(
      'CustomTool',
      { x: 1 },
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: defensive test
      [null, 'Maybe', 'Yes', { weird: true }, 'No'] as any,
    );
    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toContain('multi-choice prompt');
  });

  test('object-only permission_suggestions stay on the binary path (regression #424.dev3)', async () => {
    // Claude Code attaches typed `addRules` / `addDirectories` /
    // `setMode` objects to standard Bash prompts. They are
    // rule-suggestion metadata, NOT pickable UI options — the user
    // still sees Yes/Yes-always/No. Classifying as multi-choice +
    // default `multichoice = "skip"` silently escalated every Bash
    // command after PR #421. This test pins the binary route.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/chat/completions') {
          return new Response(
            JSON.stringify({
              model: 'fake-model',
              choices: [
                { message: { content: '{"decision":"approve","reasoning":"git status is safe"}' } },
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
          timeout: 5,
          // multichoice = 'skip' is default; a regression would
          // short-circuit to escalate without hitting the LLM.
        }),
        logFn,
      );
      const result = await service.evaluate('Bash', { command: 'git status' }, undefined, [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ] as readonly unknown[]);
      expect(result.decision).toBe('approve');
      if (result.decision !== 'cancelled') {
        expect(result.reasoning).not.toContain('multi-choice');
      }
    } finally {
      server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Design / plan-mode / long-form always-escalate (#572) - deterministic.
// These never call the LLM, so they run without Ollama. base_url points at a
// closed port: any regression that reached the LLM would yield durationMs > 0.
// ---------------------------------------------------------------------------
describe('design/plan-mode always-escalate (#572)', () => {
  const offline = { base_url: 'http://127.0.0.1:1/v1', provider: 'http://127.0.0.1:1/v1' };

  test('AskUserQuestion escalates structurally, with no LLM call (0ms)', async () => {
    const svc = new AutoApproveService(
      makeConfig({ ...offline, always_escalate_tools: ['AskUserQuestion', 'ExitPlanMode'] }),
      logFn,
    );
    const r = await svc.evaluate('AskUserQuestion', { questions: [{ question: 'Which DB?' }] });
    expect(r.decision).toBe('escalate');
    expect(r.durationMs).toBe(0);
    if (r.decision !== 'cancelled') expect(r.reasoning).toContain('always-escalate');
  });

  test('ExitPlanMode escalates structurally even in multichoice=evaluate mode', async () => {
    const svc = new AutoApproveService(
      makeConfig({
        ...offline,
        multichoice: 'evaluate',
        always_escalate_tools: ['AskUserQuestion', 'ExitPlanMode'],
      }),
      logFn,
    );
    const r = await svc.evaluate('ExitPlanMode', { plan: 'ship it' });
    expect(r.decision).toBe('escalate');
    expect(r.durationMs).toBe(0);
  });

  test('free-text heuristic escalates a question-posing tool not on the allowlist', async () => {
    const svc = new AutoApproveService(
      makeConfig({ ...offline, always_escalate_tools: [] }),
      logFn,
    );
    const r = await svc.evaluate('mcp__ask', { question: 'Which approach?' }, undefined, [
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    expect(r.decision).toBe('escalate');
    expect(r.durationMs).toBe(0);
  });

  test('deny list is still checked first (explicit user rule wins over the classifier)', async () => {
    const svc = new AutoApproveService(
      makeConfig({
        ...offline,
        deny: ['AskUserQuestion'],
        always_escalate_tools: ['AskUserQuestion'],
      }),
      logFn,
    );
    const r = await svc.evaluate('AskUserQuestion', { questions: [{ question: 'x' }] });
    expect(r.decision).toBe('deny');
    expect(r.durationMs).toBe(0);
  });
});
