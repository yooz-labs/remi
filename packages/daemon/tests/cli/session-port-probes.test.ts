import { expect, test } from 'bun:test';
import {
  probeDaemonSessionPort,
  probeWrapperSessionPort,
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
