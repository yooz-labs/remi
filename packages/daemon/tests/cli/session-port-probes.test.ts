import { expect, test } from 'bun:test';
import {
  probeDaemonSessionPort,
  probeWrapperSessionPort,
  sessionPortWindowEnd,
} from '../../src/cli/session-port-probes.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

test('daemon phase-two probe reserves configured base for sessions, not the hub', async () => {
  const host = '127.0.0.1';
  const base = await reserveRange(3, 50, host);
  expect(await probeDaemonSessionPort(base, 3, new Set(), host, base, false)).toBe(base + 1);
  expect(await probeDaemonSessionPort(base, 3, new Set(), host, base, true)).toBe(base);
});

test('wrapper phase-two probe reserves configured base', async () => {
  const host = '127.0.0.1';
  const base = await reserveRange(3, 50, host);
  expect(await probeWrapperSessionPort(base, 3, new Set(), host, base)).toBe(base + 1);
});

test('a session starting inside the hub window never searches past base + range (#1823)', async () => {
  expect(sessionPortWindowEnd(1001, 20, 1000)).toBe(1020);
  expect(sessionPortWindowEnd(1000, 20, 1000)).toBe(1020);
  expect(sessionPortWindowEnd(1019, 20, 1000)).toBe(1020);
  expect(sessionPortWindowEnd(2000, 20, 1000)).toBe(2020);
  const host = '127.0.0.1';
  const base = await reserveRange(4, 50, host);
  // Window [base, base + 3): base is reserved, base + 1 and base + 2 are in use, so the
  // second probe from base + 1 must find nothing rather than spill to base + 3.
  const used = new Set([base + 1, base + 2]);
  expect(await probeWrapperSessionPort(base + 1, 3, new Set(used), host, base)).toBeNull();
  expect(await probeDaemonSessionPort(base + 1, 3, new Set(used), host, base, false)).toBeNull();
});
