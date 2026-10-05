/** Durable daemon identity, authorized keys and bounded first-connect candidates (#873). */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
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
  errorToString,
  fromBase64,
  importPublicKey,
  isEncrypted,
  isSmallOrderPublicKey,
  serializeIdentity,
  toBase64,
  unlockIdentity,
} from '@remi/shared';
import { remiHome } from '../config/remi-home.ts';
import { isAuthorityEpoch, newAuthorityEpoch } from '../storage/authority-epoch.ts';
import { withInterprocessFileLock } from '../storage/interprocess-file-lock.ts';

export class DuplicateKeyError extends Error {
  constructor(fingerprint: string) {
    super(`Key with fingerprint ${fingerprint} already authorized`);
    this.name = 'DuplicateKeyError';
  }
}
export class PendingQueueFullError extends Error {
  constructor() {
    super('PENDING_QUEUE_FULL: approve or wait for expiry of existing requests');
  }
}
export interface PendingKey {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly firstSeenAt: string;
  readonly expiresAt: string;
}
const PENDING_TTL_MS = 600_000;
const MAX_PENDING_KEYS = 32;
type StoredAuthorizedKey = AuthorizedKey & { readonly authorizationEpoch?: string };

/** Strict raw Ed25519 representation; alternate Base64 encodings are not identities. */
function publicKeyBytes(publicKey: string): ArrayBuffer {
  const raw = fromBase64(publicKey);
  if (raw.byteLength !== 32 || toBase64(raw) !== publicKey) {
    throw new Error('Expected canonical Base64 32-byte Ed25519 public key');
  }
  return raw;
}
function derivedFingerprint(publicKey: string): string {
  return createHash('sha256')
    .update(new Uint8Array(publicKeyBytes(publicKey)))
    .digest('hex')
    .slice(0, 16);
}
/** Import and derive before a transaction lock; never await while holding the lock. */
export async function validatePublicKey(publicKey: string): Promise<string> {
  const raw = publicKeyBytes(publicKey);
  if (isSmallOrderPublicKey(new Uint8Array(raw)))
    throw new DOMException('Ed25519 small-order public key refused', 'DataError');
  await importPublicKey(raw);
  return derivedFingerprint(publicKey);
}
/** Sensitive JSON parser tokens and arbitrary exception messages never enter logs or wire. */
function safeAuthReadError(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid JSON';
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code)
    ? `filesystem error ${code}`
    : 'invalid or unreadable auth data';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export class IdentityStore {
  private readonly dir: string;
  readonly identityPath: string;
  private readonly authorizedKeysPath: string;
  private readonly pendingKeysPath: string;
  constructor(dir?: string) {
    this.dir = dir ?? remiHome();
    this.identityPath = path.join(this.dir, 'identity.json');
    this.authorizedKeysPath = path.join(this.dir, 'authorized_keys.json');
    this.pendingKeysPath = path.join(this.dir, 'pending_keys.json');
  }
  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }
  private transaction<T>(operation: () => T): T {
    this.ensureDir();
    // BOTH files use one lock, so approval, touch, revoke and queue writes serialize.
    return withInterprocessFileLock(this.authorizedKeysPath, operation);
  }
  private atomicWrite(filePath: string, raw: string): void {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, raw);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, filePath);
      const directory = fs.openSync(this.dir, 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  exists(): boolean {
    return fs.existsSync(this.identityPath);
  }
  load(): RemiIdentity | null {
    if (!this.exists()) return null;
    try {
      return deserializeIdentity(fs.readFileSync(this.identityPath, 'utf-8'));
    } catch (err) {
      throw new Error(
        `Identity file exists at ${this.identityPath} but is corrupt or unreadable: ${safeAuthReadError(err)}`,
      );
    }
  }
  save(identity: RemiIdentity): void {
    this.transaction(() => {
      this.load();
      this.atomicWrite(this.identityPath, serializeIdentity(identity));
    });
  }
  async generate(passphrase?: string, replace = true): Promise<RemiIdentity> {
    const identity = await createIdentity(passphrase);
    // A second startup must not replace the first startup's identity.
    return this.transaction(() => {
      const existing = this.load();
      if (existing && !replace) return existing;
      this.atomicWrite(this.identityPath, serializeIdentity(identity));
      return identity;
    });
  }
  async unlock(passphrase?: string): Promise<UnlockedIdentity> {
    const identity = this.load();
    if (!identity) throw new Error('No identity found. Run `remi keygen` first.');
    return unlockIdentity(identity, passphrase);
  }
  isEncrypted(): boolean {
    const identity = this.load();
    return identity ? isEncrypted(identity) : false;
  }
  private readJson(filePath: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        `Auth store is corrupt or unreadable (${filePath}): ${safeAuthReadError(err)}`,
      );
    }
  }
  loadAuthorizedKeys(): AuthorizedKeysFile {
    const parsed = this.readJson(this.authorizedKeysPath);
    if (parsed === undefined) return createAuthorizedKeysFile();
    if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['keys']))
      throw new Error('Authorized keys file has unsupported format');
    const seen = new Set<string>();
    for (const key of parsed['keys']) {
      if (
        !isRecord(key) ||
        typeof key['publicKey'] !== 'string' ||
        key['fingerprint'] !== derivedFingerprint(key['publicKey']) ||
        typeof key['label'] !== 'string' ||
        !validDate(key['addedAt']) ||
        (key['lastUsedAt'] !== null && !validDate(key['lastUsedAt'])) ||
        ('authorizationEpoch' in key && !isAuthorityEpoch(key['authorizationEpoch'])) ||
        seen.has(key['fingerprint'] as string)
      )
        throw new Error('Authorized keys file has invalid records');
      seen.add(key['fingerprint'] as string);
    }
    return parsed as unknown as AuthorizedKeysFile;
  }
  private writeAuthorizedKeys(file: AuthorizedKeysFile): void {
    this.atomicWrite(this.authorizedKeysPath, JSON.stringify(file, null, 2));
  }

  /** Capture a durable generation only for a currently present grant, migrating old records lazily. */
  captureAuthorizationEpoch(publicKey: string): string | null {
    return this.withAuthorizationEpoch(publicKey, (epoch) => epoch, true);
  }

  /**
   * Read the current grant generation and invoke one synchronous decision in
   * the authorization lock. A network invocation may return its promise, but
   * all preparation/awaits belong outside this callback; the lock then releases.
   * Callers must compare their captured generation before performing an effect.
   */
  withAuthorizationEpoch<T>(
    publicKey: string,
    operation: (current: string | null) => T,
    migrate = false,
  ): T {
    return this.transaction(() => {
      const file = this.loadAuthorizedKeys();
      const key = file.keys.find((candidate) => candidate.publicKey === publicKey) as
        | StoredAuthorizedKey
        | undefined;
      let epoch = key?.authorizationEpoch;
      if (key && epoch === undefined && migrate) {
        epoch = newAuthorityEpoch();
        const updated: StoredAuthorizedKey = { ...key, authorizationEpoch: epoch };
        this.writeAuthorizedKeys({
          ...file,
          keys: file.keys.map((candidate) => (candidate === key ? updated : candidate)),
        });
      }
      return operation(epoch ?? null);
    });
  }
  private readPendingKeys(): PendingKey[] {
    const parsed = this.readJson(this.pendingKeysPath);
    if (parsed === undefined) return [];
    if (
      !isRecord(parsed) ||
      parsed['version'] !== 1 ||
      !Array.isArray(parsed['keys']) ||
      parsed['keys'].length > MAX_PENDING_KEYS
    )
      throw new Error('Pending keys file has unsupported format');
    const seen = new Set<string>();
    for (const key of parsed['keys']) {
      if (
        !isRecord(key) ||
        Object.keys(key).sort().join(',') !== 'expiresAt,fingerprint,firstSeenAt,publicKey' ||
        typeof key['publicKey'] !== 'string' ||
        key['fingerprint'] !== derivedFingerprint(key['publicKey']) ||
        !validDate(key['firstSeenAt']) ||
        !validDate(key['expiresAt']) ||
        Date.parse(key['expiresAt']) - Date.parse(key['firstSeenAt']) !== PENDING_TTL_MS ||
        seen.has(key['fingerprint'] as string)
      )
        throw new Error('Pending keys file has invalid records');
      seen.add(key['fingerprint'] as string);
    }
    return parsed['keys'] as PendingKey[];
  }
  private pendingInsideTransaction(): PendingKey[] {
    const authorized = this.loadAuthorizedKeys().keys;
    const all = this.readPendingKeys();
    const live = all.filter(
      (key) =>
        Date.parse(key.expiresAt) > Date.now() &&
        !authorized.some((trusted) => trusted.publicKey === key.publicKey),
    );
    if (all.length !== live.length) this.writePendingKeys(live);
    return live;
  }
  private writePendingKeys(keys: readonly PendingKey[]): void {
    this.atomicWrite(this.pendingKeysPath, JSON.stringify({ version: 1, keys }, null, 2));
  }
  async registerPendingKey(publicKey: string): Promise<PendingKey> {
    const fingerprint = await validatePublicKey(publicKey);
    return this.transaction(() => {
      const keys = this.pendingInsideTransaction();
      const existing = keys.find((key) => key.publicKey === publicKey);
      if (existing) return existing;
      if (this.isAuthorized(publicKey, fingerprint)) throw new DuplicateKeyError(fingerprint);
      if (keys.length >= MAX_PENDING_KEYS) throw new PendingQueueFullError();
      const now = Date.now();
      const key = {
        publicKey,
        fingerprint,
        firstSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
      };
      this.writePendingKeys([...keys, key]);
      return key;
    });
  }
  listPendingKeys(): readonly PendingKey[] {
    return this.transaction(() => this.pendingInsideTransaction());
  }
  async authorizePendingKey(fingerprint: string, label: string): Promise<AuthorizedKey> {
    // Validate crypto before locking, then resolve this exact key again inside the lock.
    const snapshot = this.listPendingKeys().find(
      (key) => key.fingerprint === fingerprint && Date.parse(key.expiresAt) > Date.now(),
    );
    if (!snapshot)
      throw new Error(`No unexpired pending key with exact fingerprint ${fingerprint}`);
    await validatePublicKey(snapshot.publicKey);
    const grant = await createAuthorizedKey(snapshot.publicKey, label);
    return this.transaction(() => {
      const keys = this.pendingInsideTransaction();
      if (!keys.some((key) => key.fingerprint === fingerprint && key.publicKey === grant.publicKey))
        throw new Error(`No unexpired pending key with exact fingerprint ${fingerprint}`);
      const file = this.loadAuthorizedKeys();
      if (file.keys.some((key) => key.fingerprint === fingerprint))
        throw new DuplicateKeyError(fingerprint);
      const stored: StoredAuthorizedKey = { ...grant, authorizationEpoch: newAuthorityEpoch() };
      this.writeAuthorizedKeys({ ...file, keys: [...file.keys, stored] });
      // Grant is durable FIRST. A crash leaves only an ignored stale candidate.
      this.writePendingKeys(keys.filter((key) => key.fingerprint !== fingerprint));
      return grant;
    });
  }
  async addAuthorizedKey(
    publicKey: string,
    label: string,
    mayCommit: () => boolean = () => true,
  ): Promise<AuthorizedKey> {
    await validatePublicKey(publicKey);
    const key = await createAuthorizedKey(publicKey, label);
    return this.transaction(() => {
      // Relay approval can be cancelled while async crypto prepares the key.
      // The final authority decision and write share this synchronous lock.
      if (!mayCommit()) throw new Error('AUTHORIZATION_CANCELLED');
      const file = this.loadAuthorizedKeys();
      if (file.keys.some((existing) => existing.fingerprint === key.fingerprint))
        throw new DuplicateKeyError(key.fingerprint);
      const stored: StoredAuthorizedKey = { ...key, authorizationEpoch: newAuthorityEpoch() };
      this.writeAuthorizedKeys({ ...file, keys: [...file.keys, stored] });
      return key;
    });
  }
  removeAuthorizedKey(fp: Fingerprint): boolean {
    return this.transaction(() => {
      const file = this.loadAuthorizedKeys();
      const keys = file.keys.filter((key) => key.fingerprint !== fp);
      if (keys.length === file.keys.length) return false;
      // Purge stale candidates while this key is still authorized, so revoke cannot resurrect one.
      this.pendingInsideTransaction();
      this.writeAuthorizedKeys({ ...file, keys });
      return true;
    });
  }
  isAuthorized(publicKey: string, fp: Fingerprint): boolean {
    return this.loadAuthorizedKeys().keys.some(
      (key) => key.fingerprint === fp && key.publicKey === publicKey,
    );
  }
  touchAuthorizedKey(fp: Fingerprint): void {
    try {
      this.transaction(() => {
        const file = this.loadAuthorizedKeys();
        this.writeAuthorizedKeys({
          ...file,
          keys: file.keys.map((key) =>
            key.fingerprint === fp ? { ...key, lastUsedAt: new Date().toISOString() } : key,
          ),
        });
      });
    } catch (err) {
      console.warn(`Failed to update lastUsedAt for key ${fp}: ${errorToString(err)}`);
    }
  }
  listAuthorizedKeys(): readonly AuthorizedKey[] {
    return this.loadAuthorizedKeys().keys;
  }
}
