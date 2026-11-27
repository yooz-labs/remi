import { expect, test } from 'bun:test';
import { startSessionPort } from '../../src/cli/session-port-start.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

test('concurrent bind after the same probe retries the losing session', async () => {
  const host = '127.0.0.1';
  const base = await reserveRange(5, 50, host);
  const listeners: ReturnType<typeof Bun.serve>[] = [];
  let arrivals = 0;
  let release!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = () =>
    startSessionPort(
      base + 1,
      4,
      base,
      host,
      () => new Set(),
      async (port) => {
        if (port === base + 1) {
          arrivals++;
          if (arrivals === 2) release();
          await bothReady;
        }
        listeners.push(Bun.serve({ port, hostname: host, fetch: () => new Response('ok') }));
      },
    );
  try {
    const ports = await Promise.all([start(), start()]);
    expect(new Set(ports).size).toBe(2);
    expect(ports.sort()).toEqual([base + 1, base + 2]);
  } finally {
    for (const listener of listeners) listener.stop(true);
  }
}, 5000);

test('other startup errors are not retried', async () => {
  let attempts = 0;
  await expect(
    startSessionPort(
      45001,
      4,
      45000,
      '127.0.0.1',
      () => new Set(),
      async () => {
        attempts++;
        throw new Error('other failure');
      },
    ),
  ).rejects.toThrow('other failure');
  expect(attempts).toBe(1);
});
