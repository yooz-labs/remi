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

  test('instructions appended to system prompt when provided', () => {
    const [system] = buildPrompt('Bash', { command: 'bun test' }, 'Approve bun test runs.');
    expect(system?.content).toContain('USER-SPECIFIC GUIDANCE');
    expect(system?.content).toContain('Approve bun test runs.');
  });

  test('empty instructions omit the USER-SPECIFIC GUIDANCE section', () => {
    const [system] = buildPrompt('Bash', { command: 'ls' }, '');
    expect(system?.content).not.toContain('USER-SPECIFIC GUIDANCE');
  });

  test('whitespace-only instructions treated as empty', () => {
    const [system] = buildPrompt('Bash', { command: 'ls' }, '   \n  \n ');
    expect(system?.content).not.toContain('USER-SPECIFIC GUIDANCE');
  });

  test('undefined instructions use default prompt', () => {
    const [system] = buildPrompt('Bash', { command: 'ls' });
    expect(system?.content).not.toContain('USER-SPECIFIC GUIDANCE');
  });

  test('instructions appear after default guidelines (user refines defaults)', () => {
    const [system] = buildPrompt('Bash', { command: 'bun test' }, 'Approve bun test.');
    const defaultIdx = system?.content.indexOf('DEFAULT GUIDELINES') ?? -1;
    const userIdx = system?.content.indexOf('USER-SPECIFIC GUIDANCE') ?? -1;
    expect(defaultIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(defaultIdx);
  });
});
