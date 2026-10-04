/**
 * Keeps the committed engine check (`scripts/relay-v2-engine-check/`) from rotting and proves it
 * can fail: the same `run()` the runners print, executed under Bun against the committed vectors,
 * and against vectors with one recorded value corrupted.
 */

import { describe, expect, test } from 'bun:test';
import { run, summarize } from '../../../../scripts/relay-v2-engine-check/check.ts';
import vectors from '../fixtures/relay-v2/vectors.json';

const clone = (): typeof vectors => structuredClone(vectors);
const flipHex = (h: string): string => `${h[0] === '0' ? '1' : '0'}${h.slice(1)}`;

describe('the committed engine check', () => {
  test('passes under Bun: every base and jwk check, with all three groups populated', async () => {
    const report = await run(vectors);
    const summary = summarize(report);
    expect(summary.failures.filter((f) => f.group !== 'scalar')).toEqual([]);
    expect(summary.pass).toBe(true);
    expect(summary.groups.base.total).toBeGreaterThanOrEqual(15);
    expect(summary.groups.jwk.total).toBeGreaterThanOrEqual(24);
    expect(summary.groups.scalar.total).toBeGreaterThanOrEqual(24);
    // Bun signs deterministically and rejects a non-canonical S: the measurements say so.
    expect(report.measurements['Ed25519: a non-canonical S (S + L) verifies']).toBe('false');
  });

  test('fails when a recorded signature is corrupted', async () => {
    const bad = clone();
    bad.sessions.pair.hostSignature = flipHex(bad.sessions.pair.hostSignature);
    const summary = summarize(await run(bad));
    expect(summary.pass).toBe(false);
    expect(summary.failures.some((f) => f.group === 'jwk')).toBe(true);
  });

  test('fails when a recorded frame, a negative case code or a data frame is corrupted', async () => {
    for (const corrupt of [
      (v: typeof vectors) => {
        v.sessions.resume.ready = v.sessions.resume.ready.replace('"c":"', '"c":"A');
      },
      (v: typeof vectors) => {
        const first = v.negative.find((n) => n.expect === 'reject');
        if (first) first.code = 'NOT A REAL CODE';
      },
      (v: typeof vectors) => {
        v.sessions.pair.data.c2h[3] = {
          ...v.sessions.pair.data.c2h[3],
          frame: flipHex(v.sessions.pair.data.c2h[3]?.frame ?? '00'),
        } as never;
      },
    ]) {
      const bad = clone();
      corrupt(bad);
      expect(summarize(await run(bad)).pass).toBe(false);
    }
  });
});
