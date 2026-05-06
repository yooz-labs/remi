/**
 * Tests for AutoApproveService.cancel() and the hard-kill timeout race.
 * Uses a local Bun.serve hanging endpoint so we don't depend on Ollama.
 *
 * Issue #387: a slow LLM eval (cold model load, contended GPU) outliving
 * the user's terminal answer would inject a stale "1" or escalate a
 * phantom question. cancel() lets the bridge abort the in-flight call
 * when Claude advances past the prompt.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

interface HangingServer {
  url: string;
  stop: () => void;
}

function startHangingServer(): HangingServer {
  const server = Bun.serve({
    port: 0,
    fetch: (_req): Promise<Response> => {
      return new Promise(() => {
        // Never resolve. Caller must abort.
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  };
}

let hanging: HangingServer;

beforeAll(() => {
  hanging = startHangingServer();
});

afterAll(() => {
  hanging.stop();
});

function makeConfig(timeoutSeconds: number): AutoApproveConfig {
  return {
    enabled: true,
    provider: hanging.url,
    model: 'test-model',
    api_key: '',
    base_url: hanging.url,
    timeout: timeoutSeconds,
    log_decisions: false,
    allow: [],
    deny: [],
    instructions: '',
  };
}

const noLog = (_msg: string): void => {};

describe('AutoApproveService.cancel()', () => {
  test('aborts in-flight eval and returns "cancelled"', async () => {
    const svc = new AutoApproveService(makeConfig(60), noLog);
    const evalPromise = svc.evaluate('Bash', { command: 'ls' });
    // Let the fetch start before we cancel.
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.cancel('test')).toBe(true);
    const result = await evalPromise;
    expect(result.decision).toBe('cancelled');
    expect(result.reasoning).toContain('test');
  });

  test('cancel() returns false when no eval is in flight', () => {
    const svc = new AutoApproveService(makeConfig(60), noLog);
    expect(svc.cancel('idle')).toBe(false);
  });

  test('subsequent eval works normally after a cancel', async () => {
    const svc = new AutoApproveService(makeConfig(60), noLog);
    const first = svc.evaluate('Bash', { command: 'ls' });
    await new Promise((r) => setTimeout(r, 30));
    svc.cancel('first');
    const firstResult = await first;
    expect(firstResult.decision).toBe('cancelled');

    // Second eval should be evaluatable: cancellation must clear the
    // `evaluating` lock and any state the previous attempt left behind.
    const second = svc.evaluate('Bash', { command: 'ls' });
    await new Promise((r) => setTimeout(r, 30));
    svc.cancel('second');
    const secondResult = await second;
    expect(secondResult.decision).toBe('cancelled');
    expect(secondResult.reasoning).toContain('second');
  });

  test('hard kill: eval returns escalate within timeoutMs even if fetch hangs', async () => {
    // 1s timeout against a hanging server; the hard-kill race must enforce it.
    const svc = new AutoApproveService(makeConfig(1), noLog);
    const start = Date.now();
    const result = await svc.evaluate('Bash', { command: 'ls' });
    const elapsed = Date.now() - start;
    expect(result.decision).toBe('escalate');
    expect(result.reasoning).toMatch(/timeout|kill/i);
    // Allow generous slack for slow CI; the key assertion is "doesn't hang
    // past timeout by orders of magnitude".
    expect(elapsed).toBeLessThan(3000);
  });

  test('cancel beats timeout: cancel reasoning takes precedence', async () => {
    // 5s timeout, but we cancel after 30ms. Result must be 'cancelled', not
    // 'escalate', so the bridge skips inject AND escalate.
    const svc = new AutoApproveService(makeConfig(5), noLog);
    const evalPromise = svc.evaluate('Bash', { command: 'ls' });
    await new Promise((r) => setTimeout(r, 30));
    svc.cancel('user-answered');
    const result = await evalPromise;
    expect(result.decision).toBe('cancelled');
    expect(result.reasoning).toContain('user-answered');
  });

  test('concurrent eval: second call escalates while first is in flight', async () => {
    const svc = new AutoApproveService(makeConfig(60), noLog);
    const first = svc.evaluate('Bash', { command: 'ls' });
    await new Promise((r) => setTimeout(r, 30));

    const second = await svc.evaluate('Bash', { command: 'pwd' });
    expect(second.decision).toBe('escalate');
    expect(second.reasoning).toMatch(/concurrent/i);

    svc.cancel('cleanup');
    const firstResult = await first;
    expect(firstResult.decision).toBe('cancelled');
  });
});
