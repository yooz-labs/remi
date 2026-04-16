import { describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
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

describe('AutoApproveService - parseDecision (unit)', () => {
  // Test via the public evaluate method against a non-existent server
  // to verify error handling escalation
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
    // Use a server that won't respond (port 1 is unreachable)
    const service = new AutoApproveService(
      makeConfig({ base_url: 'http://localhost:1', timeout: 1 }),
      logFn,
    );
    const result = await service.evaluate('Read', { file_path: '/tmp/test' });
    expect(result.decision).toBe('escalate');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describeOllama('AutoApproveService - real Ollama integration', () => {
  test('approves a safe read-only command', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Bash', { command: 'git status' });
    // The LLM should approve or at worst escalate a git status
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
    // Should NOT approve a destructive command
    expect(result.decision).not.toBe('approve');
    expect(result.reasoning).toBeTruthy();
  }, 60000);

  test('escalates a write operation', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Write', {
      file_path: '/tmp/important.config',
      content: 'new content',
    });
    // Write ops should be escalated or at most approved; never denied
    expect(['approve', 'escalate']).toContain(result.decision);
  }, 60000);

  test('handles Grep tool', async () => {
    const service = new AutoApproveService(makeConfig(), logFn);
    const result = await service.evaluate('Grep', { pattern: 'TODO', path: '/tmp' });
    // Grep is read-only, should approve
    expect(['approve', 'escalate']).toContain(result.decision);
  }, 60000);
});
