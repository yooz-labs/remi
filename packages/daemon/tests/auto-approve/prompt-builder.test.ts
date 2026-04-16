import { describe, expect, test } from 'bun:test';
import { buildPrompt } from '../../src/auto-approve/prompt-builder.ts';

describe('buildPrompt', () => {
  test('returns system and user messages', () => {
    const messages = buildPrompt('Bash', { command: 'git status' });
    expect(messages).toHaveLength(2);
    const [system, user] = messages;
    expect(system?.role).toBe('system');
    expect(user?.role).toBe('user');
  });

  test('user message contains tool name and input', () => {
    const [, user] = buildPrompt('Bash', { command: 'ls -la' });
    expect(user?.content).toContain('Tool: Bash');
    expect(user?.content).toContain('ls -la');
  });

  test('system prompt mentions approve, deny, escalate', () => {
    const [system] = buildPrompt('Read', { file_path: '/tmp/test.ts' });
    expect(system?.content).toContain('approve');
    expect(system?.content).toContain('deny');
    expect(system?.content).toContain('escalate');
  });

  test('truncates very large tool input', () => {
    const largeInput = { content: 'x'.repeat(5000) };
    const [, user] = buildPrompt('Write', largeInput);
    // JSON.stringify of the input should be truncated to ~2000 chars
    expect(user?.content.length).toBeLessThan(3000);
    expect(user?.content).toContain('...');
  });

  test('handles empty tool input', () => {
    const [, user] = buildPrompt('Glob', {});
    expect(user?.content).toContain('Tool: Glob');
    expect(user?.content).toContain('{}');
  });
});
