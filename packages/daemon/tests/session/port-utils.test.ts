import { afterEach, describe, expect, test } from 'bun:test';
import * as net from 'node:net';
import { findAvailableTcpPort, isPortAvailable } from '../../src/session/port-utils.ts';

/**
 * Port selection for these tests (#823).
 *
 * The previous approach picked one random base in 45000-50000 and bound
 * `base + N` outright. Nothing checked the port was free and nothing retried,
 * so any collision failed the test in its own SETUP -- the code under test was
 * never reached. That range overlaps Linux's ephemeral port range, so any other
 * test in the suite that opens a server (several now do) can occupy it, which
 * is exactly how this started failing on CI.
 *
 * Now: never guess. `occupyEphemeral` lets the OS assign a port and reports
 * which one it got, and `reserveRange` finds a genuinely free CONTIGUOUS run
 * for the cases that need one, retrying on a different base if the run is
 * contended mid-reservation.
 */

/** Bind to an OS-assigned port and report which one. Never collides. */
function occupyEphemeral(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // biome-ignore lint/suspicious/noExplicitAny: Bun's net.Server type is incomplete
    (srv as any).on('error', reject);
    srv.listen({ port: 0, host: '0.0.0.0', exclusive: true }, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no address assigned'));
        return;
      }
      resolve({ server: srv, port: addr.port });
    });
  });
}

/** Bind one specific port; rejects if it is taken (callers must have checked). */
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // biome-ignore lint/suspicious/noExplicitAny: Bun's net.Server type is incomplete
    (srv as any).on('error', reject);
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => resolve(srv));
  });
}

/**
 * Find a base such that `[base, base + count)` are ALL free right now, by
 * probing each. Retries on a fresh random base when the run is contended.
 * Throws only if the machine is so busy that no run of `count` ports is free
 * across `attempts` tries, which is a genuine environment problem worth
 * failing loudly on rather than papering over.
 */
async function reserveRange(count: number, attempts = 50): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const base = 45000 + Math.floor(Math.random() * 5000);
    let allFree = true;
    for (let i = 0; i < count; i++) {
      if (!(await isPortAvailable(base + i))) {
        allFree = false;
        break;
      }
    }
    if (allFree) return base;
  }
  throw new Error(`no free run of ${count} ports found after ${attempts} attempts`);
}

describe('isPortAvailable', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  test('returns true for an unused port', async () => {
    // A port the OS just handed us and we immediately released is free.
    const { server, port } = await occupyEphemeral();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortAvailable(port)).toBe(true);
  });

  test('returns false for an occupied port', async () => {
    const { server, port } = await occupyEphemeral();
    servers.push(server);
    expect(await isPortAvailable(port)).toBe(false);
  });

  test('returns true after server is stopped', async () => {
    const { server, port } = await occupyEphemeral();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortAvailable(port)).toBe(true);
  });
});

describe('findAvailableTcpPort', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  test('returns first port when all free', async () => {
    const base = await reserveRange(5);
    expect(await findAvailableTcpPort(base, 5)).toBe(base);
  });

  test('skips known-used ports without probing', async () => {
    const base = await reserveRange(5);
    const used = new Set([base, base + 1]);
    expect(await findAvailableTcpPort(base, 5, used)).toBe(base + 2);
  });

  test('skips actually occupied ports via TCP probe', async () => {
    const base = await reserveRange(2);
    servers.push(await occupyPort(base));
    expect(await findAvailableTcpPort(base, 5)).toBe(base + 1);
  });

  test('returns null when all ports occupied', async () => {
    const base = await reserveRange(3);
    for (let i = 0; i < 3; i++) servers.push(await occupyPort(base + i));
    expect(await findAvailableTcpPort(base, 3)).toBeNull();
  });

  test('returns null when all in known-used set', async () => {
    const base = await reserveRange(3);
    const used = new Set([base, base + 1, base + 2]);
    expect(await findAvailableTcpPort(base, 3, used)).toBeNull();
  });

  test('combines known-used and TCP probe', async () => {
    const base = await reserveRange(3);
    const used = new Set([base]);
    servers.push(await occupyPort(base + 1));
    expect(await findAvailableTcpPort(base, 5, used)).toBe(base + 2);
  });
});
