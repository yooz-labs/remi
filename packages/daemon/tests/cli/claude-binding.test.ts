import { describe, expect, test } from 'bun:test';

import { resolveClaudeBinding } from '../../src/cli/claude-binding.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('resolveClaudeBinding', () => {
  test('fresh spawn: mints a UUID and injects --session-id', () => {
    const { claudeSessionId, args, source } = resolveClaudeBinding([]);
    expect(source).toBe('fresh');
    expect(UUID_RE.test(claudeSessionId)).toBe(true);
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(claudeSessionId);
  });

  test('two fresh spawns get distinct ids', () => {
    const a = resolveClaudeBinding([]);
    const b = resolveClaudeBinding([]);
    expect(a.claudeSessionId).not.toBe(b.claudeSessionId);
  });

  test('user-provided --session-id is respected (no fresh mint)', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { claudeSessionId, args, source } = resolveClaudeBinding(['--session-id', id]);
    expect(source).toBe('user-session-id');
    expect(claudeSessionId).toBe(id);
    // Should NOT have duplicated the flag.
    const occurrences = args.filter((a) => a === '--session-id').length;
    expect(occurrences).toBe(1);
  });

  test('user-provided --session-id= (equals form) is respected', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { claudeSessionId, source } = resolveClaudeBinding([`--session-id=${id}`]);
    expect(source).toBe('user-session-id');
    expect(claudeSessionId).toBe(id);
  });

  test('user-provided --resume=<uuid> (equals form) is respected', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const { claudeSessionId, args, source } = resolveClaudeBinding([`--resume=${id}`]);
    expect(source).toBe('user-resume');
    expect(claudeSessionId).toBe(id);
    expect(args).not.toContain('--session-id');
  });

  test('malformed --session-id=uuid=foo (second = in value) falls back to fresh', () => {
    // Documents safe-degradation behavior: isUuidLike rejects the trailing
    // garbage, so we mint a fresh id and inject our own --session-id rather
    // than trusting a malformed value.
    const malformed = '--session-id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee=foo';
    const { source, claudeSessionId, args } = resolveClaudeBinding([malformed]);
    expect(source).toBe('fresh');
    expect(UUID_RE.test(claudeSessionId)).toBe(true);
    // The user's malformed arg is preserved verbatim AND our fresh --session-id
    // is injected; Claude will reject one of them or honor the last.
    expect(args[0]).toBe(malformed);
    expect(args).toContain('--session-id');
  });

  test('--resume alone: binding equals the resumed id', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const { claudeSessionId, args, source } = resolveClaudeBinding(['--resume', id]);
    expect(source).toBe('user-resume');
    expect(claudeSessionId).toBe(id);
    // No injected --session-id because claude --resume preserves the id.
    expect(args).not.toContain('--session-id');
  });

  test('--resume -r short form', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const { claudeSessionId, source } = resolveClaudeBinding(['-r', id]);
    expect(source).toBe('user-resume');
    expect(claudeSessionId).toBe(id);
  });

  test('--resume with --fork-session: mints a fresh id and injects --session-id', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const { claudeSessionId, args, source } = resolveClaudeBinding([
      '--resume',
      id,
      '--fork-session',
    ]);
    expect(source).toBe('user-resume-fork');
    expect(claudeSessionId).not.toBe(id);
    expect(args).toContain('--session-id');
    // Resume is still passed through so claude knows what to fork from.
    expect(args).toContain('--resume');
    expect(args).toContain('--fork-session');
  });

  test('appends -n displayName when not already present', () => {
    const { args } = resolveClaudeBinding([], { displayName: 'remi:19920' });
    expect(args).toContain('-n');
    expect(args[args.indexOf('-n') + 1]).toBe('remi:19920');
  });

  test('respects user-provided -n / --name (no override)', () => {
    const a = resolveClaudeBinding(['-n', 'my-session'], { displayName: 'remi:19920' });
    expect(a.args.filter((x) => x === '-n').length).toBe(1);
    expect(a.args[a.args.indexOf('-n') + 1]).toBe('my-session');

    const b = resolveClaudeBinding(['--name', 'my-session'], { displayName: 'remi:19920' });
    expect(b.args).not.toContain('-n');
    expect(b.args.filter((x) => x === '--name').length).toBe(1);
  });

  test('ignores non-UUID values in --session-id and falls back to fresh', () => {
    const { source, claudeSessionId } = resolveClaudeBinding(['--session-id', 'not-a-uuid']);
    expect(source).toBe('fresh');
    expect(UUID_RE.test(claudeSessionId)).toBe(true);
  });

  test('preserves the original arg order plus appended injections', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const input = ['--model', 'sonnet', '--session-id', id, '--add-dir', '/tmp'];
    const { args } = resolveClaudeBinding(input);
    // First five args must match input verbatim (no rewriting of user flags).
    for (let i = 0; i < input.length; i++) {
      expect(args[i]).toBe(input[i] as string);
    }
  });

  test('does not mutate the input array', () => {
    const input: string[] = [];
    resolveClaudeBinding(input, { displayName: 'remi:19920' });
    expect(input.length).toBe(0);
  });
});
