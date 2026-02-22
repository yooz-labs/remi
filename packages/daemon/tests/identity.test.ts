import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeviceIdentity } from '../src/remote/identity.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-identity-test-'));
}

describe('DeviceIdentity', () => {
  let tmpDir: string;
  let identityPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    identityPath = path.join(tmpDir, 'identity.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  test('auto-creates identity on first load', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();
    const data = identity.get();

    expect(data.version).toBe(1);
    expect(data.deviceId).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(data.deviceSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(data.pairedClients).toEqual([]);
    expect(data.createdAt).toBeTruthy();
    expect(fs.existsSync(identityPath)).toBe(true);
  });

  test('persists and reloads identity', () => {
    const identity1 = new DeviceIdentity(identityPath);
    identity1.load();
    const data1 = identity1.get();

    const identity2 = new DeviceIdentity(identityPath);
    identity2.load();
    const data2 = identity2.get();

    expect(data2.deviceId).toBe(data1.deviceId);
    expect(data2.deviceSecret).toBe(data1.deviceSecret);
    expect(data2.createdAt).toBe(data1.createdAt);
  });

  test('addPairedClient stores a new client', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const clientId = 'test-client-1';
    const token = identity.addPairedClient(clientId, 'Test Phone');

    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const client = identity.findClient(clientId);
    expect(client).toBeTruthy();
    expect(client?.clientId).toBe(clientId);
    expect(client?.clientName).toBe('Test Phone');
    expect(client?.pairingToken).toBe(token);
  });

  test('addPairedClient persists to disk', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const clientId = 'test-client-persist';
    const token = identity.addPairedClient(clientId, 'Phone');

    // Reload from disk
    const identity2 = new DeviceIdentity(identityPath);
    identity2.load();

    const client = identity2.findClient(clientId);
    expect(client).toBeTruthy();
    expect(client?.pairingToken).toBe(token);
  });

  test('removePairedClient deletes a client', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const clientId = 'client-to-remove';
    identity.addPairedClient(clientId, 'Phone');
    expect(identity.findClient(clientId)).toBeTruthy();

    identity.removePairedClient(clientId);
    expect(identity.findClient(clientId)).toBeNull();
  });

  test('removePairedClient persists to disk', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    identity.addPairedClient('c1', 'Phone 1');
    identity.addPairedClient('c2', 'Phone 2');
    identity.removePairedClient('c1');

    const identity2 = new DeviceIdentity(identityPath);
    identity2.load();
    expect(identity2.findClient('c1')).toBeNull();
    expect(identity2.findClient('c2')).toBeTruthy();
  });

  test('touchClient updates lastSeenAt', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const clientId = 'touch-test';
    identity.addPairedClient(clientId, 'Phone');
    const before = identity.findClient(clientId)?.lastSeenAt ?? '';

    identity.touchClient(clientId);
    const after = identity.findClient(clientId)?.lastSeenAt ?? '';

    expect(after >= before).toBe(true);
  });

  test('verifyChallenge succeeds with correct token', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const clientId = 'verify-test';
    const token = identity.addPairedClient(clientId, 'Phone');
    const nonce = crypto.randomUUID();

    // Compute HMAC using hex-decoded key bytes (matching both daemon and web client)
    const nodeCrypto = require('node:crypto');
    const keyBytes = Buffer.from(token, 'hex');
    const hmac = nodeCrypto.createHmac('sha256', keyBytes).update(nonce).digest('hex');

    const result = identity.verifyChallenge(clientId, nonce, hmac);
    expect(result).toBe(true);
  });

  test('verifyChallenge fails with wrong HMAC', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const clientId = 'verify-fail-test';
    identity.addPairedClient(clientId, 'Phone');

    const result = identity.verifyChallenge(clientId, 'some-nonce', 'deadbeef'.repeat(8));
    expect(result).toBe(false);
  });

  test('verifyChallenge fails for unknown client', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const result = identity.verifyChallenge('nonexistent', 'nonce', 'hmac');
    expect(result).toBe(false);
  });

  test('listClients returns all paired clients', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    identity.addPairedClient('c1', 'Phone 1');
    identity.addPairedClient('c2', 'Tablet');
    identity.addPairedClient('c3', 'Desktop');

    const clients = identity.listClients();
    expect(clients).toHaveLength(3);
    expect(clients.map((c) => c.clientId).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  test('generatePairingToken returns 64-char hex string', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const token = identity.generatePairingToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token.length).toBe(64);
  });

  test('each pairing token is unique', () => {
    const identity = new DeviceIdentity(identityPath);
    identity.load();

    const tokens = new Set<string>();
    for (let i = 0; i < 20; i++) {
      tokens.add(identity.generatePairingToken());
    }
    expect(tokens.size).toBe(20);
  });
});
