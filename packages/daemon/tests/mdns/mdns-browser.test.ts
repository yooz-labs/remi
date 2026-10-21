import { afterEach, describe, expect, test } from 'bun:test';
import { discoverDaemons } from '../../src/mdns/mdns-browser.ts';
import { MdnsPublisher } from '../../src/mdns/mdns-publisher.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

describe('discoverDaemons', () => {
  let publisher: MdnsPublisher | null = null;

  afterEach(async () => {
    if (publisher) {
      await publisher.stop();
      publisher = null;
    }
  });

  test('discovers a published service', async () => {
    publisher = new MdnsPublisher({
      port: 19990,
      version: '0.2.3',
      authEnabled: false,
      name: 'remi-browser-test-1',
      probe: false,
    });
    await publisher.start();

    const daemons = await discoverDaemons({ timeoutMs: 2000 });
    const found = daemons.find((d) => d.port === 19990);
    expect(found).toBeDefined();
    expect(found?.version).toBe('0.2.3');
    expect(found?.authEnabled).toBe(false);
    expect(found?.role).toBeUndefined();
  });

  test('returns empty array gracefully on short timeout', async () => {
    const daemons = await discoverDaemons({ timeoutMs: 100 });
    expect(Array.isArray(daemons)).toBe(true);
  });

  test('includes auth and fingerprint in discovered data', async () => {
    publisher = new MdnsPublisher({
      port: 19989,
      version: '0.2.4',
      authEnabled: true,
      fingerprint: 'SHA256:abc123',
      name: 'remi-browser-test-2',
      probe: false,
    });
    await publisher.start();

    const daemons = await discoverDaemons({ timeoutMs: 2000 });
    const found = daemons.find((d) => d.port === 19989);
    expect(found).toBeDefined();
    expect(found?.authEnabled).toBe(true);
    expect(found?.fingerprint).toBe('SHA256:abc123');
    expect(found?.version).toBe('0.2.4');
  });

  test('discovered daemon has hostname', async () => {
    publisher = new MdnsPublisher({
      port: 19988,
      version: '0.2.3',
      authEnabled: false,
      name: 'remi-browser-test-3',
      probe: false,
    });
    await publisher.start();

    const daemons = await discoverDaemons({ timeoutMs: 2000 });
    const found = daemons.find((d) => d.port === 19988);
    expect(found).toBeDefined();
    expect(found?.hostname).toBeTruthy();
    expect(found?.name).toContain('remi-');
  });

  test.each(['hub', 'session'] as const)('discovers the public %s role hint', async (role) => {
    const name = `remi-route-role-${crypto.randomUUID()}`;
    publisher = new MdnsPublisher({
      port: 19987,
      version: 'test',
      authEnabled: true,
      fingerprint: '0123456789abcdef',
      role,
      name,
      probe: false,
    });
    await publisher.start();
    const found = (await discoverDaemons({ timeoutMs: 2000 })).find(
      (daemon) => daemon.name === name,
    );
    expect(found).toBeDefined();
    expect(found?.role).toBe(role);
  });

  test('default hub and session instance names coexist', async () => {
    const port = await reserveRange(2);
    publisher = new MdnsPublisher({ port, version: 'test', authEnabled: true, role: 'hub' });
    const child = new MdnsPublisher({
      port: port + 1,
      version: 'test',
      authEnabled: true,
      role: 'session',
    });
    try {
      await publisher.start();
      await child.start();
      const daemons = await discoverDaemons({ timeoutMs: 2500 });
      const hub = daemons.find((daemon) => daemon.port === port);
      const session = daemons.find((daemon) => daemon.port === port + 1);
      expect(hub?.role).toBe('hub');
      expect(session?.role).toBe('session');
      expect(hub?.name).toEndWith(`-hub-${port}`);
      expect(session?.name).toEndWith(`-session-${port + 1}`);
      expect(hub?.name).not.toBe(session?.name);
    } finally {
      await child.stop();
    }
  });
});
