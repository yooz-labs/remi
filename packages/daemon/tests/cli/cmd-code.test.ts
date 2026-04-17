import { describe, expect, test } from 'bun:test';
import { type CodeStoreLike, runCodeCommand } from '../../src/cli/cmd-code.ts';

function makeIO() {
  const out: string[] = [];
  return { io: { out: (msg: string) => out.push(msg) }, out };
}

function makeStore(
  initial: string | null,
  refreshValue = 'NEWCODE-42',
): CodeStoreLike & {
  loadCalls: number;
  refreshCalls: number;
} {
  let stored = initial;
  const self = {
    loadCalls: 0,
    refreshCalls: 0,
    load(): string | null {
      self.loadCalls++;
      return stored;
    },
    refresh(): string {
      self.refreshCalls++;
      stored = refreshValue;
      return refreshValue;
    },
  };
  return self;
}

describe('runCodeCommand', () => {
  test('--refresh prints new code and restart hint, rotates the store', () => {
    const store = makeStore('OLD', 'ROTATED-1');
    const { io, out } = makeIO();
    const code = runCodeCommand(store, { refresh: true }, io);
    expect(code).toBe(0);
    expect(store.loadCalls).toBe(0);
    expect(store.refreshCalls).toBe(1);
    expect(out[0]).toBe('New permanent connection code: ROTATED-1');
    expect(out[1]).toBe('Restart the daemon for the new code to take effect.');
    expect(out.some((m) => m.includes('By default, codes rotate on each reconnect'))).toBe(true);
  });

  test('default (no refresh) prints existing code if present', () => {
    const store = makeStore('EXISTING-CODE');
    const { io, out } = makeIO();
    const code = runCodeCommand(store, {}, io);
    expect(code).toBe(0);
    expect(store.loadCalls).toBe(1);
    expect(store.refreshCalls).toBe(0);
    expect(out[0]).toBe('Permanent connection code: EXISTING-CODE');
    expect(out[1]).toBe('Use --permanent-code flag when starting daemon to enable this code.');
  });

  test('default generates a new code when none exists and annotates it', () => {
    const store = makeStore(null, 'NEW-AUTO');
    const { io, out } = makeIO();
    const code = runCodeCommand(store, {}, io);
    expect(code).toBe(0);
    expect(store.loadCalls).toBe(1);
    expect(store.refreshCalls).toBe(1);
    expect(out[0]).toBe('Permanent connection code: NEW-AUTO (newly generated)');
    expect(out[1]).toBe('Use --permanent-code flag when starting daemon to enable this code.');
  });

  test('always appends the exact two-line informational footer', () => {
    const store = makeStore('X');
    const { io, out } = makeIO();
    runCodeCommand(store, {}, io);
    const footer = out.slice(-2);
    // Character-for-character equivalence, including the leading \n on the
    // first line — matches the original console.log('\nNote: ...') exactly.
    expect(footer[0]).toBe(
      '\nNote: By default, codes rotate on each reconnect. Use --permanent-code to',
    );
    expect(footer[1]).toBe(
      'persist a fixed code (requires Ed25519 authentication for relay connections).',
    );
  });
});
