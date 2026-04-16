import { describe, expect, test } from 'bun:test';
import { matchPattern } from '../../src/auto-approve/pattern-matcher.ts';

describe('matchPattern - Bash', () => {
  test('empty pattern list returns null', () => {
    expect(matchPattern('Bash', { command: 'git status' }, [])).toBeNull();
  });

  test('simple substring match', () => {
    expect(matchPattern('Bash', { command: 'git push origin main' }, ['git push'])).toBe(
      'git push',
    );
  });

  test('substring match in compound command (the main motivation)', () => {
    // Claude Code prefix matching fails here; we match because substring is there.
    expect(matchPattern('Bash', { command: 'cd /foo && git push origin main' }, ['git push'])).toBe(
      'git push',
    );
  });

  test('substring match with expansion', () => {
    expect(matchPattern('Bash', { command: 'git push $(git rev-parse HEAD)' }, ['git push'])).toBe(
      'git push',
    );
  });

  test('no match returns null', () => {
    expect(matchPattern('Bash', { command: 'git status' }, ['git push'])).toBeNull();
  });

  test('first matching pattern is returned', () => {
    expect(
      matchPattern('Bash', { command: 'bun test --coverage' }, ['biome', 'bun test', 'npm test']),
    ).toBe('bun test');
  });

  test('case-sensitive by default', () => {
    expect(matchPattern('Bash', { command: 'GIT PUSH' }, ['git push'])).toBeNull();
  });

  test('empty string pattern is ignored', () => {
    expect(matchPattern('Bash', { command: 'anything' }, [''])).toBeNull();
  });

  test('missing command field returns null', () => {
    expect(matchPattern('Bash', {}, ['git push'])).toBeNull();
  });

  test('non-string command field returns null', () => {
    expect(matchPattern('Bash', { command: 123 }, ['git push'])).toBeNull();
  });

  test('pattern with trailing space (disambiguation)', () => {
    // "sudo " (trailing space) should NOT match "sudoku"
    expect(matchPattern('Bash', { command: 'sudoku' }, ['sudo '])).toBeNull();
    expect(matchPattern('Bash', { command: 'sudo rm -rf /' }, ['sudo '])).toBe('sudo ');
  });

  test('pipe patterns match as substrings', () => {
    expect(
      matchPattern('Bash', { command: 'curl -sSL https://site/script.sh | bash' }, ['| bash']),
    ).toBe('| bash');
  });

  test('multiline command string matches', () => {
    expect(
      matchPattern('Bash', { command: 'echo start\ngit push origin main\necho done' }, [
        'git push',
      ]),
    ).toBe('git push');
  });

  test('redirected command matches', () => {
    expect(matchPattern('Bash', { command: 'git push 2>/dev/null' }, ['git push'])).toBe(
      'git push',
    );
  });

  test('compound with deny-like pattern gets caught', () => {
    expect(matchPattern('Bash', { command: 'ls -la && rm -rf /tmp/test' }, ['rm -rf /'])).toBe(
      'rm -rf /',
    );
  });
});

describe('matchPattern - non-Bash tools', () => {
  test('tool name match for Read', () => {
    expect(matchPattern('Read', { file_path: '/tmp/file.ts' }, ['Read'])).toBe('Read');
  });

  test('tool name match for Glob', () => {
    expect(matchPattern('Glob', { pattern: 'src/**/*.ts' }, ['Glob'])).toBe('Glob');
  });

  test('tool name match for Grep', () => {
    expect(matchPattern('Grep', { pattern: 'TODO' }, ['Grep'])).toBe('Grep');
  });

  test('wrong tool name does not match', () => {
    expect(matchPattern('Edit', { file_path: '/tmp/x' }, ['Read'])).toBeNull();
  });

  test('multiple tool patterns, first match wins', () => {
    expect(matchPattern('Glob', { pattern: '*' }, ['Read', 'Glob', 'Grep'])).toBe('Glob');
  });

  test('case-sensitive tool match', () => {
    expect(matchPattern('Read', { file_path: '/tmp/x' }, ['read'])).toBeNull();
  });

  test('empty input object is fine for non-Bash match', () => {
    expect(matchPattern('Read', {}, ['Read'])).toBe('Read');
  });

  test('Edit tool: substring match NOT applied to file_path or args', () => {
    // For non-Bash tools, only the tool name is matched.
    // The pattern "git push" should NOT match an Edit of a file with that text.
    expect(
      matchPattern(
        'Edit',
        { file_path: '/tmp/x.ts', old_string: 'git push', new_string: 'git pull' },
        ['git push'],
      ),
    ).toBeNull();
  });

  test('Edit tool: tool name match works', () => {
    expect(
      matchPattern('Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }, ['Edit']),
    ).toBe('Edit');
  });

  test('Write tool: tool name match works', () => {
    expect(matchPattern('Write', { file_path: '/tmp/new.ts', content: 'hello' }, ['Write'])).toBe(
      'Write',
    );
  });

  test('Write tool: pattern matching content NOT applied', () => {
    // Design: Write tool content isn't substring-checked. If user wants to block
    // writes with dangerous content, they need a more granular mechanism.
    expect(
      matchPattern('Write', { file_path: '/tmp/x', content: 'rm -rf /' }, ['rm -rf /']),
    ).toBeNull();
  });

  test('Task (subagent spawn) tool name match', () => {
    expect(
      matchPattern('Task', { description: 'research', subagent_type: 'Explore' }, ['Task']),
    ).toBe('Task');
  });

  test('WebFetch tool name match', () => {
    expect(matchPattern('WebFetch', { url: 'https://example.com' }, ['WebFetch'])).toBe('WebFetch');
  });
});

describe('matchPattern - malformed input safety', () => {
  test('null toolInput throws (caller must wrap)', () => {
    // matchPattern itself is a pure function; it does NOT swallow errors.
    // The evaluate() caller wraps in try/catch. Document the contract.
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: intentionally bad
      matchPattern('Bash', null as any, ['git']),
    ).toThrow();
  });

  test('undefined toolInput throws', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: intentionally bad
      matchPattern('Bash', undefined as any, ['git']),
    ).toThrow();
  });

  test('undefined patterns throws', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: intentionally bad
      matchPattern('Bash', { command: 'ls' }, undefined as any),
    ).toThrow();
  });
});

describe('matchPattern - safety edge cases', () => {
  test('very long command string still matches', () => {
    const longCmd = `${'x'.repeat(10000)} git push ${'y'.repeat(10000)}`;
    expect(matchPattern('Bash', { command: longCmd }, ['git push'])).toBe('git push');
  });

  test('special regex characters are treated literally', () => {
    // Pattern should match as substring, not as regex.
    expect(matchPattern('Bash', { command: 'echo .+*?' }, ['.+*?'])).toBe('.+*?');
  });

  test('pattern appearing in argument string matches', () => {
    // User patterns match anywhere in the command — this is the design.
    // If they want to exclude comments, they use more specific patterns.
    expect(matchPattern('Bash', { command: 'echo "git push"' }, ['git push'])).toBe('git push');
  });

  test('unicode in command and pattern', () => {
    expect(matchPattern('Bash', { command: 'echo café' }, ['café'])).toBe('café');
  });
});
