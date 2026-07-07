import { describe, expect, it } from 'bun:test';
import {
  clearAuqRunActive,
  isAuqRunActive,
  markAuqRunActive,
} from '../../src/hooks/auq-active-runs.ts';

describe('auq-active-runs', () => {
  it('is false before any mark', () => {
    expect(isAuqRunActive('sess-a', 'q-never-marked')).toBe(false);
  });

  it('mark -> true, clear -> false', () => {
    markAuqRunActive('sess-b', 'q-1');
    expect(isAuqRunActive('sess-b', 'q-1')).toBe(true);
    clearAuqRunActive('sess-b', 'q-1');
    expect(isAuqRunActive('sess-b', 'q-1')).toBe(false);
  });

  it('is keyed by session+question — a different session or question does not match', () => {
    markAuqRunActive('sess-c', 'q-2');
    expect(isAuqRunActive('sess-other', 'q-2')).toBe(false);
    expect(isAuqRunActive('sess-c', 'q-other')).toBe(false);
    clearAuqRunActive('sess-c', 'q-2');
  });

  it('clearing an id that was never marked is a safe no-op', () => {
    expect(() => clearAuqRunActive('sess-d', 'q-never-marked')).not.toThrow();
    expect(isAuqRunActive('sess-d', 'q-never-marked')).toBe(false);
  });

  it('two concurrent questions in the same session are tracked independently', () => {
    markAuqRunActive('sess-e', 'q-main');
    markAuqRunActive('sess-e', 'q-subagent');
    expect(isAuqRunActive('sess-e', 'q-main')).toBe(true);
    expect(isAuqRunActive('sess-e', 'q-subagent')).toBe(true);
    clearAuqRunActive('sess-e', 'q-main');
    expect(isAuqRunActive('sess-e', 'q-main')).toBe(false);
    expect(isAuqRunActive('sess-e', 'q-subagent')).toBe(true);
    clearAuqRunActive('sess-e', 'q-subagent');
  });
});
