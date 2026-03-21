import { afterEach, describe, expect, test } from 'bun:test';
import * as net from 'node:net';
import { findAvailableTcpPort, isPortAvailable } from '../../src/session/port-utils.ts';

// Use high random base ports to avoid conflicts with running services
const TEST_BASE = 45000 + Math.floor(Math.random() * 5000);

/** Bind a real TCP server to a port (blocks that port for net.createServer probes). */
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => resolve(srv));
  });
}

describe('isPortAvailable', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  test('returns true for an unused port', async () => {
    expect(await isPortAvailable(TEST_BASE)).toBe(true);
  });

  test('returns false for an occupied port', async () => {
    const srv = await occupyPort(TEST_BASE + 100);
    servers.push(srv);
    expect(await isPortAvailable(TEST_BASE + 100)).toBe(false);
  });

  test('returns true after server is stopped', async () => {
    const srv = await occupyPort(TEST_BASE + 200);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    expect(await isPortAvailable(TEST_BASE + 200)).toBe(true);
  });
});

describe('findAvailableTcpPort', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  test('returns first port when all free', async () => {
    const port = await findAvailableTcpPort(TEST_BASE + 300, 5);
    expect(port).toBe(TEST_BASE + 300);
  });

  test('skips known-used ports without probing', async () => {
    const used = new Set([TEST_BASE + 400, TEST_BASE + 401]);
    const port = await findAvailableTcpPort(TEST_BASE + 400, 5, used);
    expect(port).toBe(TEST_BASE + 402);
  });

  test('skips actually occupied ports via TCP probe', async () => {
    const srv = await occupyPort(TEST_BASE + 500);
    servers.push(srv);
    const port = await findAvailableTcpPort(TEST_BASE + 500, 5);
    expect(port).toBe(TEST_BASE + 501);
  });

  test('returns null when all ports occupied', async () => {
    const base = TEST_BASE + 600;
    for (let i = 0; i < 3; i++) {
      servers.push(await occupyPort(base + i));
    }
    const port = await findAvailableTcpPort(base, 3);
    expect(port).toBeNull();
  });

  test('returns null when all in known-used set', async () => {
    const base = TEST_BASE + 700;
    const used = new Set([base, base + 1, base + 2]);
    const port = await findAvailableTcpPort(base, 3, used);
    expect(port).toBeNull();
  });

  test('combines known-used and TCP probe', async () => {
    const base = TEST_BASE + 800;
    const used = new Set([base]);
    servers.push(await occupyPort(base + 1));
    const port = await findAvailableTcpPort(base, 5, used);
    expect(port).toBe(base + 2);
  });
});
