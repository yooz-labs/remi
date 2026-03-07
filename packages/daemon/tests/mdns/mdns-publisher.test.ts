import { afterEach, describe, expect, test } from 'bun:test';
import { MdnsPublisher } from '../../src/mdns/mdns-publisher.ts';

describe('MdnsPublisher', () => {
  let publisher: MdnsPublisher | null = null;

  afterEach(async () => {
    if (publisher) {
      await publisher.stop();
      publisher = null;
    }
  });

  test('starts and reports running', async () => {
    publisher = new MdnsPublisher({
      port: 19999,
      version: '0.2.3',
      authEnabled: false,
      name: 'remi-test-start',
      probe: false,
    });
    await publisher.start();
    expect(publisher.isRunning).toBe(true);
  });

  test('stops cleanly', async () => {
    publisher = new MdnsPublisher({
      port: 19998,
      version: '0.2.3',
      authEnabled: false,
      name: 'remi-test-stop',
      probe: false,
    });
    await publisher.start();
    await publisher.stop();
    expect(publisher.isRunning).toBe(false);
    publisher = null;
  });

  test('double start is idempotent', async () => {
    publisher = new MdnsPublisher({
      port: 19997,
      version: '0.2.3',
      authEnabled: false,
      name: 'remi-test-double',
      probe: false,
    });
    await publisher.start();
    await publisher.start();
    expect(publisher.isRunning).toBe(true);
  });

  test('stop without start is safe', async () => {
    publisher = new MdnsPublisher({
      port: 19996,
      version: '0.2.3',
      authEnabled: false,
      name: 'remi-test-nostop',
      probe: false,
    });
    await publisher.stop();
    expect(publisher.isRunning).toBe(false);
    publisher = null;
  });

  test('starts with auth and fingerprint', async () => {
    publisher = new MdnsPublisher({
      port: 19995,
      version: '0.2.3',
      authEnabled: true,
      fingerprint: 'SHA256:testfingerprint',
      name: 'remi-test-auth',
      probe: false,
    });
    await publisher.start();
    expect(publisher.isRunning).toBe(true);
  });
});
