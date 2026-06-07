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

  test('system prompt states the reversibility rule', () => {
    // Locks the rule the user asked for: reversible side effects can
    // approve; irreversible side effects escalate. Without this, the
    // model has no principled way to decide on routine compound commands.
    const [system] = buildPrompt('Bash', { command: 'cd /tmp && ls' });
    expect(system?.content.toLowerCase()).toContain('reversib');
  });

  test('system prompt states the design/direction/steering rule', () => {
    // Design/scope/steering questions must always escalate — the model
    // cannot infer user intent for these.
    const [system] = buildPrompt('Bash', { command: 'ls' });
    const lower = system?.content.toLowerCase() ?? '';
    expect(lower).toContain('design');
    expect(lower).toContain('direction');
  });

  test('system prompt evaluates compound commands as a whole', () => {
    // Compound commands (&&, ||, ;, |) must be evaluated as one
    // unit; one risky part escalates the whole chain.
    const [system] = buildPrompt('Bash', { command: 'ls && cat foo' });
    expect(system?.content).toContain('Compound commands');
  });

  test('system prompt approves read-only gh queries and escalates gh mutations (#482)', () => {
    // PR review (/review-pr) leans on read-only gh; without this clause the
    // catch-all "talks to a remote -> escalate" rule made the LLM escalate
    // every gh command. Read-only fetches approve; remote mutations escalate.
    const [system] = buildPrompt('Bash', { command: 'gh pr view 123' });
    const content = system?.content ?? '';
    expect(content).toContain('gh pr view');
    expect(content).toContain('gh api'); // GET approvable, mutating verbs escalate
    expect(content).toContain('gh pr merge'); // named as an escalation
    // The approve clause must mention fetching read-only data without mutation.
    expect(content.toLowerCase()).toContain('fetch data');
  });
});
