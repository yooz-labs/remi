import { afterEach, describe, expect, test } from 'bun:test';
import { discoverDaemons } from '../../src/mdns/mdns-browser.ts';
import { MdnsPublisher } from '../../src/mdns/mdns-publisher.ts';

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

    const daemons = await discoverDaemons({ timeout: 2000 });
    const found = daemons.find((d) => d.port === 19990);
    expect(found).toBeDefined();
    expect(found?.version).toBe('0.2.3');
    expect(found?.authEnabled).toBe(false);
  });

  test('returns empty array gracefully on short timeout', async () => {
    const daemons = await discoverDaemons({ timeout: 100 });
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

    const daemons = await discoverDaemons({ timeout: 2000 });
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

    const daemons = await discoverDaemons({ timeout: 2000 });
    const found = daemons.find((d) => d.port === 19988);
    expect(found).toBeDefined();
    expect(found?.hostname).toBeTruthy();
    expect(found?.name).toContain('remi-');
  });
});
