/**
 * IdentityStore - Persistent storage for daemon identity and authorized keys.
 *
 * Stores:
 * - ~/.remi/identity.json - Daemon's Ed25519 keypair (private key encrypted)
 * - ~/.remi/authorized_keys.json - Client public keys allowed to connect
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AuthorizedKey,
  AuthorizedKeysFile,
  Fingerprint,
  RemiIdentity,
  UnlockedIdentity,
} from '@remi/shared';
import {
  createAuthorizedKey,
  createAuthorizedKeysFile,
  createIdentity,
  deserializeIdentity,
  serializeIdentity,
  unlockIdentity,
} from '@remi/shared';

const REMI_DIR = path.join(os.homedir(), '.remi');
const IDENTITY_FILE = 'identity.json';
const AUTHORIZED_KEYS_FILE = 'authorized_keys.json';

export class IdentityStore {
  private readonly dir: string;
  readonly identityPath: string;
  private readonly authorizedKeysPath: string;

  constructor(dir?: string) {
    this.dir = dir ?? REMI_DIR;
    this.identityPath = path.join(this.dir, IDENTITY_FILE);
    this.authorizedKeysPath = path.join(this.dir, AUTHORIZED_KEYS_FILE);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  // -- Identity --

  /** Check if an identity file exists. */
  exists(): boolean {
    return fs.existsSync(this.identityPath);
  }

  /** Load the stored identity. Returns null if file does not exist. Throws on corrupt file. */
  load(): RemiIdentity | null {
    if (!fs.existsSync(this.identityPath)) return null;
    try {
      const raw = fs.readFileSync(this.identityPath, 'utf-8');
      return deserializeIdentity(raw);
    } catch (err) {
      throw new Error(
        `Identity file exists at ${this.identityPath} but is corrupt or unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Save an identity to disk with restricted permissions. */
  save(identity: RemiIdentity): void {
    this.ensureDir();
    fs.writeFileSync(this.identityPath, serializeIdentity(identity), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  /** Generate a new identity and save it. Returns the identity. */
  async generate(passphrase: string): Promise<RemiIdentity> {
    const identity = await createIdentity(passphrase);
    this.save(identity);
    return identity;
  }

  /** Unlock the stored identity with a passphrase. */
  async unlock(passphrase: string): Promise<UnlockedIdentity> {
    const identity = this.load();
    if (!identity) {
      throw new Error('No identity found. Run `remi keygen` first.');
    }
    return unlockIdentity(identity, passphrase);
  }

  // -- Authorized Keys --

  /** Load authorized keys. Returns empty file if not found. Throws on corrupt file. */
  loadAuthorizedKeys(): AuthorizedKeysFile {
    if (!fs.existsSync(this.authorizedKeysPath)) return createAuthorizedKeysFile();
    const raw = fs.readFileSync(this.authorizedKeysPath, 'utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Authorized keys file is corrupt (${this.authorizedKeysPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (parsed['version'] !== 1 || !Array.isArray(parsed['keys'])) {
      throw new Error(
        `Authorized keys file has unsupported format (version: ${parsed['version']})`,
      );
    }
    return parsed as unknown as AuthorizedKeysFile;
  }

  /** Save authorized keys to disk. */
  saveAuthorizedKeys(file: AuthorizedKeysFile): void {
    this.ensureDir();
    fs.writeFileSync(this.authorizedKeysPath, JSON.stringify(file, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  /** Add a client public key to authorized keys. */
  async addAuthorizedKey(publicKeyBase64: string, label: string): Promise<AuthorizedKey> {
    const file = this.loadAuthorizedKeys();
    const key = await createAuthorizedKey(publicKeyBase64, label);

    // Check for duplicate
    const existing = file.keys.find((k) => k.fingerprint === key.fingerprint);
    if (existing) {
      throw new Error(`Key with fingerprint ${key.fingerprint} already authorized`);
    }

    file.keys.push(key);
    this.saveAuthorizedKeys(file);
    return key;
  }

  /** Remove an authorized key by fingerprint. */
  removeAuthorizedKey(fp: Fingerprint): boolean {
    const file = this.loadAuthorizedKeys();
    const before = file.keys.length;
    const filtered = file.keys.filter((k) => k.fingerprint !== fp);

    if (filtered.length === before) return false;

    this.saveAuthorizedKeys({ ...file, keys: filtered });
    return true;
  }

  /** Check if a public key is authorized. */
  isAuthorized(publicKeyBase64: string, fp: Fingerprint): boolean {
    const file = this.loadAuthorizedKeys();
    return file.keys.some((k) => k.fingerprint === fp && k.publicKey === publicKeyBase64);
  }

  /** Update lastUsedAt for an authorized key. */
  touchAuthorizedKey(fp: Fingerprint): void {
    const file = this.loadAuthorizedKeys();
    const key = file.keys.find((k) => k.fingerprint === fp);
    if (key) {
      (key as { lastUsedAt: string | null }).lastUsedAt = new Date().toISOString();
      this.saveAuthorizedKeys(file);
    }
  }

  /** List all authorized keys. */
  listAuthorizedKeys(): readonly AuthorizedKey[] {
    return this.loadAuthorizedKeys().keys;
  }
}
