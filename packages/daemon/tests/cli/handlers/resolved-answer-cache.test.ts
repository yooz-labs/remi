import { describe, expect, test } from 'bun:test';
import {
  ResolvedAnswerCache,
  answerCacheKey,
} from '../../../src/cli/handlers/resolved-answer-cache.ts';

describe('ResolvedAnswerCache (#752)', () => {
  test('a recorded answer matches the same value and rejects a different one', () => {
    const cache = new ResolvedAnswerCache();
    cache.record('q1', ['Yes']);
    expect(cache.matches('q1', 'Yes')).toBe(true);
    expect(cache.matches('q1', 'No')).toBe(false); // conflicting late answer stays stale
    expect(cache.matches('q2', 'Yes')).toBe(false); // unknown question
  });

  test('multiple keys record every spelling of one decision (value vs label)', () => {
    const cache = new ResolvedAnswerCache();
    cache.record('q1', ['Yes', '1']);
    expect(cache.matches('q1', 'Yes')).toBe(true); // push-action label
    expect(cache.matches('q1', '1')).toBe(true); // in-app value
    expect(cache.matches('q1', 'No')).toBe(false);
  });

  test('empty key lists record nothing', () => {
    const cache = new ResolvedAnswerCache();
    cache.record('q1', ['']);
    expect(cache.sizeForTest()).toBe(0);
    expect(cache.matches('q1', '')).toBe(false);
  });

  test('entries expire after the TTL', () => {
    let now = 1_000;
    const cache = new ResolvedAnswerCache({ ttlMs: 100, nowMs: () => now });
    cache.record('q1', ['Yes']);
    now += 99;
    expect(cache.matches('q1', 'Yes')).toBe(true);
    now += 2;
    expect(cache.matches('q1', 'Yes')).toBe(false);
    expect(cache.sizeForTest()).toBe(0); // expired entry dropped on read
  });

  test('the cache is bounded: the oldest entry is evicted past maxEntries', () => {
    let now = 1_000;
    const cache = new ResolvedAnswerCache({ maxEntries: 2, nowMs: () => now });
    cache.record('q1', ['a']);
    now += 1;
    cache.record('q2', ['b']);
    now += 1;
    cache.record('q3', ['c']);
    expect(cache.sizeForTest()).toBe(2);
    expect(cache.matches('q1', 'a')).toBe(false); // evicted (oldest)
    expect(cache.matches('q2', 'b')).toBe(true);
    expect(cache.matches('q3', 'c')).toBe(true);
  });

  test('record prunes expired entries so dead questions never count toward the cap', () => {
    let now = 1_000;
    const cache = new ResolvedAnswerCache({ ttlMs: 100, maxEntries: 10, nowMs: () => now });
    cache.record('q1', ['a']);
    now += 200; // q1 expired
    cache.record('q2', ['b']);
    expect(cache.sizeForTest()).toBe(1);
  });

  test('answerCacheKey: plain answers pass through, AUQ selections serialize stably', () => {
    expect(answerCacheKey('Yes')).toBe('Yes');
    // Option order inside one selection must not matter (multi-select taps
    // may enumerate in a different order per channel).
    const a = answerCacheKey('', [{ questionIndex: 0, optionIndices: [2, 0] }]);
    const b = answerCacheKey('', [{ questionIndex: 0, optionIndices: [0, 2] }]);
    expect(a).toBe(b);
    // Different picks are different keys.
    const c = answerCacheKey('', [{ questionIndex: 0, optionIndices: [1] }]);
    expect(c).not.toBe(a);
    // Selections win over the answer string (AUQ answers carry an empty/dummy answer).
    expect(answerCacheKey('ignored', [{ questionIndex: 1, optionIndices: [0] }])).toContain('auq:');
  });
});
