import { describe, expect, test } from 'bun:test';
import { isKeysSubcommand } from '../../src/cli/cmd-keys.ts';

describe('isKeysSubcommand', () => {
  test('returns true for every supported key subcommand', () => {
    expect(isKeysSubcommand('keygen')).toBe(true);
    expect(isKeysSubcommand('export-key')).toBe(true);
    expect(isKeysSubcommand('import-key')).toBe(true);
    expect(isKeysSubcommand('authorize')).toBe(true);
    expect(isKeysSubcommand('keys')).toBe(true);
  });

  test('returns false for unrelated subcommands', () => {
    expect(isKeysSubcommand('attach')).toBe(false);
    expect(isKeysSubcommand('kill')).toBe(false);
    expect(isKeysSubcommand('config')).toBe(false);
    expect(isKeysSubcommand('ls')).toBe(false);
  });

  test('returns false for non-string inputs', () => {
    expect(isKeysSubcommand(undefined)).toBe(false);
    expect(isKeysSubcommand(null)).toBe(false);
    expect(isKeysSubcommand(42)).toBe(false);
    expect(isKeysSubcommand({})).toBe(false);
    expect(isKeysSubcommand([])).toBe(false);
  });

  test('is case-sensitive', () => {
    expect(isKeysSubcommand('Keygen')).toBe(false);
    expect(isKeysSubcommand('KEYGEN')).toBe(false);
    expect(isKeysSubcommand('Export-Key')).toBe(false);
  });

  test('narrows the type for the caller', () => {
    const x: unknown = 'keygen';
    if (isKeysSubcommand(x)) {
      // TS should accept x as KeysSubcommand here
      const sub: 'keygen' | 'export-key' | 'import-key' | 'authorize' | 'keys' = x;
      expect(sub).toBe('keygen');
    } else {
      expect.unreachable();
    }
  });
});
