/**
 * Tests for IdentityStore - persistent identity and authorized keys management.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIdentity } from '@remi/shared';
import { IdentityStore } from '../src/auth/identity-store.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-auth-test-'));
}

describe('IdentityStore', () => {
  let tmpDir: string;
  let store: IdentityStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new IdentityStore(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe('identity', () => {
    test('exists returns false when no identity', () => {
      expect(store.exists()).toBe(false);
    });

    test('load returns null when no identity', () => {
      expect(store.load()).toBeNull();
    });

    test('generate creates and saves identity', async () => {
      const identity = await store.generate('testpass');
      expect(identity.version).toBe(1);
      expect(identity.fingerprint).toMatch(/^[0-9a-f]+$/);
      expect(store.exists()).toBe(true);
    });

    test('save and load round-trips identity', async () => {
      const identity = await createIdentity('pass');
      store.save(identity);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.publicKey).toBe(identity.publicKey);
      expect(loaded?.fingerprint).toBe(identity.fingerprint);
      expect(loaded?.encryptedPrivateKey).toBe(identity.encryptedPrivateKey);
    });

    test('unlock succeeds with correct passphrase', async () => {
      await store.generate('mypass');
      const unlocked = await store.unlock('mypass');
      expect(unlocked.publicKey.type).toBe('public');
      expect(unlocked.privateKey.type).toBe('private');
    });

    test('unlock fails with wrong passphrase', async () => {
      await store.generate('correct');
      await expect(store.unlock('wrong')).rejects.toThrow();
    });

    test('unlock throws when no identity exists', async () => {
      await expect(store.unlock('any')).rejects.toThrow('No identity found');
    });

    test('identity file has restricted permissions', async () => {
      await store.generate('pass');
      const identityPath = path.join(tmpDir, 'identity.json');
      const stats = fs.statSync(identityPath);
      // Check owner-only read/write (0600 = 0o600 = 384)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('authorized keys', () => {
    test('loadAuthorizedKeys returns empty file when none exists', () => {
      const file = store.loadAuthorizedKeys();
      expect(file.version).toBe(1);
      expect(file.keys).toEqual([]);
    });

    test('addAuthorizedKey adds a key', async () => {
      const identity = await createIdentity('pass');
      const key = await store.addAuthorizedKey(identity.publicKey, 'Test Device');

      expect(key.publicKey).toBe(identity.publicKey);
      expect(key.label).toBe('Test Device');
      expect(key.fingerprint).toBe(identity.fingerprint);

      const keys = store.listAuthorizedKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0]?.fingerprint).toBe(identity.fingerprint);
    });

    test('addAuthorizedKey rejects duplicate fingerprint', async () => {
      const identity = await createIdentity('pass');
      await store.addAuthorizedKey(identity.publicKey, 'First');
      await expect(store.addAuthorizedKey(identity.publicKey, 'Duplicate')).rejects.toThrow(
        'already authorized',
      );
    });

    test('removeAuthorizedKey removes a key', async () => {
      const identity = await createIdentity('pass');
      await store.addAuthorizedKey(identity.publicKey, 'Device');
      const removed = store.removeAuthorizedKey(identity.fingerprint);
      expect(removed).toBe(true);
      expect(store.listAuthorizedKeys()).toHaveLength(0);
    });

    test('removeAuthorizedKey returns false for unknown fingerprint', () => {
      const removed = store.removeAuthorizedKey('nonexistent');
      expect(removed).toBe(false);
    });

    test('isAuthorized returns true for known key', async () => {
      const identity = await createIdentity('pass');
      await store.addAuthorizedKey(identity.publicKey, 'Device');
      expect(store.isAuthorized(identity.publicKey, identity.fingerprint)).toBe(true);
    });

    test('isAuthorized returns false for unknown key', async () => {
      const identity = await createIdentity('pass');
      expect(store.isAuthorized(identity.publicKey, identity.fingerprint)).toBe(false);
    });

    test('touchAuthorizedKey updates lastUsedAt', async () => {
      const identity = await createIdentity('pass');
      await store.addAuthorizedKey(identity.publicKey, 'Device');

      const before = store.listAuthorizedKeys();
      expect(before[0]?.lastUsedAt).toBeNull();

      store.touchAuthorizedKey(identity.fingerprint);

      const after = store.listAuthorizedKeys();
      expect(after[0]?.lastUsedAt).not.toBeNull();
    });

    test('multiple keys can be added', async () => {
      const id1 = await createIdentity('pass1');
      const id2 = await createIdentity('pass2');
      await store.addAuthorizedKey(id1.publicKey, 'Device 1');
      await store.addAuthorizedKey(id2.publicKey, 'Device 2');
      expect(store.listAuthorizedKeys()).toHaveLength(2);
    });
  });
});
