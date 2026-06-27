import { afterEach, describe, expect, it } from 'bun:test';
import {
  appendPtyOutput,
  clearPtyOutput,
  readPtyOutput,
  resetPtyOutput,
} from '../../src/pty/output-buffer.ts';

const SID = 'buf-test-session';

describe('output-buffer (#627)', () => {
  afterEach(() => clearPtyOutput(SID));

  it('append -> read accumulates; reset empties; read after reset is ""', () => {
    appendPtyOutput(SID, 'abc');
    appendPtyOutput(SID, 'def');
    expect(readPtyOutput(SID)).toBe('abcdef');
    resetPtyOutput(SID);
    expect(readPtyOutput(SID)).toBe('');
  });

  it('caps at 16KB and keeps the TAIL (the latest output the runner needs)', () => {
    const big = 'x'.repeat(20_000);
    appendPtyOutput(SID, big);
    const out = readPtyOutput(SID);
    expect(out.length).toBe(16_384);
    // Append a distinctive marker; it must survive (tail-anchored, not prefix).
    appendPtyOutput(SID, "User answered Claude's questions");
    const out2 = readPtyOutput(SID);
    expect(out2.length).toBe(16_384);
    expect(out2.endsWith("User answered Claude's questions")).toBe(true);
  });

  it('clear removes the session entry entirely (no leak)', () => {
    appendPtyOutput(SID, 'data');
    clearPtyOutput(SID);
    expect(readPtyOutput(SID)).toBe('');
  });

  it('read for an unknown session is ""', () => {
    expect(readPtyOutput('never-seen')).toBe('');
  });
});
