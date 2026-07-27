import { afterEach, describe, expect, test } from 'bun:test';
import type * as net from 'node:net';
import { findAvailableTcpPort, isPortAvailable } from '../../src/session/port-utils.ts';
import { occupyEphemeral, occupyPort, reserveRange } from './port-test-helpers.ts';

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
