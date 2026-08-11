import { afterEach, describe, expect, test } from 'bun:test';
import type * as net from 'node:net';
import { findAvailableTcpPort, isPortAvailable } from '../../src/session/port-utils.ts';
import { TEST_BIND_HOST, occupyEphemeral, occupyPort, reserveRange } from './port-test-helpers.ts';

const H = TEST_BIND_HOST;

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
    expect(await isPortAvailable(port, H)).toBe(true);
  });

  test('returns false for an occupied port', async () => {
    const { server, port } = await occupyEphemeral();
    servers.push(server);
    expect(await isPortAvailable(port, H)).toBe(false);
  });

  test('returns true after server is stopped', async () => {
    const { server, port } = await occupyEphemeral();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortAvailable(port, H)).toBe(true);
  });
});

/**
 * #880. The probe used to default `bindHost` to `'0.0.0.0'` while every caller
 * went on to listen on `daemon.bind`; the two agreed only because that config
 * default was also `'0.0.0.0'`. Setting `bind = "127.0.0.1"` broke the pairing
 * and the daemon handed itself a port it could not bind.
 *
 * The property below is the one that must hold on EVERY platform, and it is
 * deliberately not "a wildcard probe disagrees with a loopback probe". Whether
 * `0.0.0.0:P` and `127.0.0.1:P` can coexist is BSD-vs-Linux specific (they can
 * on darwin, which is how the bug produced a false "free"); asserting that
 * divergence would pass locally and go red on the ubuntu CI runner. What is
 * true everywhere is that a probe answers for the host it was given -- so a
 * port already held on the host you are about to bind must read as taken.
 */
describe('#880 the probe answers for the host it is given', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  for (const host of ['127.0.0.1', '0.0.0.0']) {
    test(`a port held on ${host} is reported taken by a probe on ${host}`, async () => {
      const { server, port } = await occupyEphemeral(host);
      servers.push(server);
      expect(await isPortAvailable(port, host)).toBe(false);
    });

    test(`findAvailableTcpPort skips a port held on ${host} when probing ${host}`, async () => {
      const base = await reserveRange(2);
      servers.push(await occupyPort(base, host));
      expect(await findAvailableTcpPort(base, 5, new Set(), host)).toBe(base + 1);
    });
  }
});

describe('findAvailableTcpPort', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  test('returns first port when all free', async () => {
    const base = await reserveRange(5);
    expect(await findAvailableTcpPort(base, 5, new Set(), H)).toBe(base);
  });

  test('skips known-used ports without probing', async () => {
    const base = await reserveRange(5);
    const used = new Set([base, base + 1]);
    expect(await findAvailableTcpPort(base, 5, used, H)).toBe(base + 2);
  });

  test('skips actually occupied ports via TCP probe', async () => {
    const base = await reserveRange(2);
    servers.push(await occupyPort(base));
    expect(await findAvailableTcpPort(base, 5, new Set(), H)).toBe(base + 1);
  });

  test('returns null when all ports occupied', async () => {
    const base = await reserveRange(3);
    for (let i = 0; i < 3; i++) servers.push(await occupyPort(base + i));
    expect(await findAvailableTcpPort(base, 3, new Set(), H)).toBeNull();
  });

  test('returns null when all in known-used set', async () => {
    const base = await reserveRange(3);
    const used = new Set([base, base + 1, base + 2]);
    expect(await findAvailableTcpPort(base, 3, used, H)).toBeNull();
  });

  test('combines known-used and TCP probe', async () => {
    const base = await reserveRange(3);
    const used = new Set([base]);
    servers.push(await occupyPort(base + 1));
    expect(await findAvailableTcpPort(base, 5, used, H)).toBe(base + 2);
  });
});
