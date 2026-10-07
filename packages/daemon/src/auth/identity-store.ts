/**
 * Durable daemon identity, authorized keys, bounded first-connect candidates (#873) and the
 * pairing records `remi pair` makes (#1275, ADR 0037).
 */
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
  generatePairingNonce,
  importPublicKey,
  isEncrypted,
  isSmallOrderPublicKey,
  serializeIdentity,
  toBase64,
  unlockIdentity,
} from '@remi/shared';
import { remiHome } from '../config/remi-home.ts';
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
/**
 * Pending slots only a pairing claim may take (#1275 review): a flood of unknown keys cannot keep a
 * phone the person is pairing out of the queue. Ordinary first connections get the other 28.
 */
const PAIRING_RESERVED_SLOTS = 4;

export class PairingLimitError extends Error {
  constructor() {
    super('PAIRING_LIMIT: finish or cancel a pairing that is already open');
    this.name = 'PairingLimitError';
  }
}
/** Where a pairing code is (#1275): shown, claimed by one key, decided, or cancelled. */
export type PairingState = 'open' | 'claimed' | 'approved' | 'rejected' | 'cancelled';
export interface PairingClaim {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly label: string;
  readonly claimedAt: string;
}
/** A pairing record: the nonce's SHA-256, never the nonce. */
export interface PairingRecord {
  readonly nonceHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: PairingState;
  readonly claim: PairingClaim | null;
  /** Other keys that presented this code while it waited for the person's decision. */
  readonly contested: number;
  /** The fingerprint of the last of them, shown at the terminal; null when none. */
  readonly lastContender: string | null;
  /** Claims refused while the code was open because the pending queue was full. */
  readonly queueFull: number;
}
/** What a claim came to: the key is pending on this code, or why not. */
export type PairingClaimOutcome =
  | 'CLAIMED'
  | 'PAIRING_UNKNOWN'
  | 'PAIRING_EXPIRED'
  | 'PAIRING_USED'
  | 'PAIRING_REJECTED'
  | 'PAIRING_CANCELLED'
  | 'PENDING_QUEUE_FULL';
/** A code can be claimed for five minutes (`PAIRING_TTL_SECONDS` in `@remi/shared`). */
const PAIRING_TTL_MS = 300_000;
/** Codes shown and not yet expired or decided, at once. */
const MAX_OPEN_PAIRINGS = 4;
/** Records of any state in the file. */
const MAX_PAIRING_RECORDS = 16;
/** Where the contest and full-queue counts stop, so a flood of attempts stops writing the file. */
const PAIRING_COUNT_CAP = 999;
/** Kept this long after the code expires: a claim stays approvable while its pending key lives. */
const PAIRING_RETAIN_MS = PENDING_TTL_MS;
const PAIRING_STATES: readonly string[] = ['open', 'claimed', 'approved', 'rejected', 'cancelled'];

/** An open code has no claim; a claimed, approved or rejected one has one; a cancelled one either. */
function claimMatchesState(state: string, claim: unknown): boolean {
  if (state === 'open') return claim === null;
  if (state === 'cancelled') return true;
  return claim !== null;
}

function isCount(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= PAIRING_COUNT_CAP
  );
}

/** Decided, cancelled, or never claimed before it expired: nothing will happen to it any more. */
function isFinished(record: PairingRecord, now: number): boolean {
  if (record.state === 'claimed') return false;
  if (record.state === 'open') return Date.parse(record.expiresAt) <= now;
  return true;
}

function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

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
  private readonly pairingsPath: string;
  private readonly now: () => number;
  constructor(dir?: string, options: { now?: () => number } = {}) {
    this.dir = dir ?? remiHome();
    this.identityPath = path.join(this.dir, 'identity.json');
    this.authorizedKeysPath = path.join(this.dir, 'authorized_keys.json');
    this.pendingKeysPath = path.join(this.dir, 'pending_keys.json');
    this.pairingsPath = path.join(this.dir, 'pairings.json');
    this.now = options.now ?? Date.now;
  }
  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }
  private transaction<T>(operation: () => T): T {
    this.ensureDir();
    // EVERY file uses one lock, so approval, touch, revoke, queue and pairing writes serialize.
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
        Date.parse(key.expiresAt) > this.now() &&
        !authorized.some((trusted) => trusted.publicKey === key.publicKey),
    );
    if (all.length !== live.length) this.writePendingKeys(live);
    return live;
  }
  private writePendingKeys(keys: readonly PendingKey[]): void {
    this.atomicWrite(this.pendingKeysPath, JSON.stringify({ version: 1, keys }, null, 2));
  }
  /**
   * Registers a verified, unknown key as pending. `forPairing` lets it take one of the slots kept for
   * pairing claims; only a claim (and a test filling the queue) passes it.
   */
  async registerPendingKey(
    publicKey: string,
    options: { readonly forPairing?: boolean } = {},
  ): Promise<PendingKey> {
    const fingerprint = await validatePublicKey(publicKey);
    return this.transaction(() =>
      this.registerPendingInsideTransaction(publicKey, fingerprint, options.forPairing === true),
    );
  }
  /** The pending registration, for a caller that already holds the lock (a pairing claim). */
  private registerPendingInsideTransaction(
    publicKey: string,
    fingerprint: string,
    forPairing: boolean,
  ): PendingKey {
    const keys = this.pendingInsideTransaction();
    const existing = keys.find((key) => key.publicKey === publicKey);
    if (existing) return existing;
    if (this.isAuthorized(publicKey, fingerprint)) throw new DuplicateKeyError(fingerprint);
    const limit = forPairing ? MAX_PENDING_KEYS : MAX_PENDING_KEYS - PAIRING_RESERVED_SLOTS;
    if (keys.length >= limit) throw new PendingQueueFullError();
    const now = this.now();
    const key = {
      publicKey,
      fingerprint,
      firstSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
    };
    this.writePendingKeys([...keys, key]);
    return key;
  }
  listPendingKeys(): readonly PendingKey[] {
    return this.transaction(() => this.pendingInsideTransaction());
  }
  async authorizePendingKey(fingerprint: string, label: string): Promise<AuthorizedKey> {
    const grant = await this.prepareAuthorization(fingerprint, label);
    return this.transaction(() => this.commitAuthorizationInsideTransaction(fingerprint, grant));
  }
  /** Validate crypto before locking: the grant a pending key with this exact fingerprint would get. */
  private async prepareAuthorization(fingerprint: string, label: string): Promise<AuthorizedKey> {
    const snapshot = this.listPendingKeys().find(
      (key) => key.fingerprint === fingerprint && Date.parse(key.expiresAt) > this.now(),
    );
    if (!snapshot)
      throw new Error(`No unexpired pending key with exact fingerprint ${fingerprint}`);
    await validatePublicKey(snapshot.publicKey);
    return createAuthorizedKey(snapshot.publicKey, label);
  }
  /**
   * The one approval mutation (`remi authorize` and a pairing approval both end here): resolve this
   * exact pending key again inside the lock, make the grant durable, then drop the candidate.
   */
  private commitAuthorizationInsideTransaction(
    fingerprint: string,
    grant: AuthorizedKey,
  ): AuthorizedKey {
    const keys = this.pendingInsideTransaction();
    if (!keys.some((key) => key.fingerprint === fingerprint && key.publicKey === grant.publicKey))
      throw new Error(`No unexpired pending key with exact fingerprint ${fingerprint}`);
    const file = this.loadAuthorizedKeys();
    if (file.keys.some((key) => key.fingerprint === fingerprint))
      throw new DuplicateKeyError(fingerprint);
    this.writeAuthorizedKeys({ ...file, keys: [...file.keys, grant] });
    // Grant is durable FIRST. A crash leaves only an ignored stale candidate.
    this.writePendingKeys(keys.filter((key) => key.fingerprint !== fingerprint));
    return grant;
  }
  async addAuthorizedKey(publicKey: string, label: string): Promise<AuthorizedKey> {
    await validatePublicKey(publicKey);
    const key = await createAuthorizedKey(publicKey, label);
    return this.transaction(() => {
      const file = this.loadAuthorizedKeys();
      if (file.keys.some((existing) => existing.fingerprint === key.fingerprint))
        throw new DuplicateKeyError(key.fingerprint);
      this.writeAuthorizedKeys({ ...file, keys: [...file.keys, key] });
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

  // -- Pairing records (#1275, ADR 0037) --

  /** Where pairing records live, for a message that tells the person what to do with the file. */
  get pairingsFile(): string {
    return this.pairingsPath;
  }

  private readPairingsFile(): PairingRecord[] {
    const parsed = this.readJson(this.pairingsPath);
    if (parsed === undefined) return [];
    if (
      !isRecord(parsed) ||
      parsed['version'] !== 1 ||
      !Array.isArray(parsed['pairings']) ||
      parsed['pairings'].length > MAX_PAIRING_RECORDS
    )
      throw new Error('Pairings file has unsupported format');
    const seen = new Set<string>();
    for (const record of parsed['pairings']) {
      const claim = isRecord(record) ? record['claim'] : undefined;
      if (
        !isRecord(record) ||
        Object.keys(record).sort().join(',') !==
          'claim,contested,createdAt,expiresAt,lastContender,nonceHash,queueFull,state' ||
        typeof record['nonceHash'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record['nonceHash']) ||
        !validDate(record['createdAt']) ||
        !validDate(record['expiresAt']) ||
        Date.parse(record['expiresAt']) - Date.parse(record['createdAt']) !== PAIRING_TTL_MS ||
        !PAIRING_STATES.includes(record['state'] as string) ||
        !isCount(record['contested']) ||
        !isCount(record['queueFull']) ||
        !(
          record['lastContender'] === null ||
          (typeof record['lastContender'] === 'string' &&
            /^[0-9a-f]{16}$/.test(record['lastContender']))
        ) ||
        seen.has(record['nonceHash']) ||
        !(
          claim === null ||
          (isRecord(claim) &&
            Object.keys(claim).sort().join(',') === 'claimedAt,fingerprint,label,publicKey' &&
            typeof claim['publicKey'] === 'string' &&
            claim['fingerprint'] === derivedFingerprint(claim['publicKey']) &&
            typeof claim['label'] === 'string' &&
            validDate(claim['claimedAt']))
        ) ||
        !claimMatchesState(record['state'] as string, claim)
      )
        throw new Error('Pairings file has invalid records');
      seen.add(record['nonceHash']);
    }
    return parsed['pairings'] as PairingRecord[];
  }
  /** The records still worth keeping, written back when some were dropped. Holds the lock. */
  private pairingsInsideTransaction(): PairingRecord[] {
    const all = this.readPairingsFile();
    const kept = all.filter((r) => Date.parse(r.expiresAt) + PAIRING_RETAIN_MS > this.now());
    if (kept.length !== all.length) this.writePairings(kept);
    return kept;
  }
  private writePairings(records: readonly PairingRecord[]): void {
    this.atomicWrite(this.pairingsPath, JSON.stringify({ version: 1, pairings: records }, null, 2));
  }
  /** Changes one record by its nonce, under the lock; returns what the change function returns. */
  private withPairing<T>(
    nonce: string,
    change: (record: PairingRecord | undefined, save: (next: PairingRecord) => void) => T,
  ): T {
    const hash = nonceHash(nonce);
    return this.transaction(() => {
      const records = this.pairingsInsideTransaction();
      const index = records.findIndex((r) => r.nonceHash === hash);
      return change(records[index], (next) => {
        const updated = [...records];
        updated[index] = next;
        this.writePairings(updated);
      });
    });
  }
  /**
   * A new code: the nonce goes to the caller to show, the record keeps only its hash. At the record
   * cap, finished records (decided, cancelled, or expired unclaimed) make room, oldest first.
   */
  createPairing(): { nonce: string; record: PairingRecord } {
    const nonce = generatePairingNonce();
    const now = this.now();
    const record: PairingRecord = {
      nonceHash: nonceHash(nonce),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      state: 'open',
      claim: null,
      contested: 0,
      lastContender: null,
      queueFull: 0,
    };
    this.transaction(() => {
      let records = this.pairingsInsideTransaction();
      const open = records.filter(
        (r) => (r.state === 'open' || r.state === 'claimed') && Date.parse(r.expiresAt) > now,
      );
      if (open.length >= MAX_OPEN_PAIRINGS) throw new PairingLimitError();
      if (records.length >= MAX_PAIRING_RECORDS) {
        const surplus = records.length - MAX_PAIRING_RECORDS + 1;
        const evicted = new Set(
          records
            .filter((r) => isFinished(r, now))
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
            .slice(0, surplus)
            .map((r) => r.nonceHash),
        );
        records = records.filter((r) => !evicted.has(r.nonceHash));
        if (records.length >= MAX_PAIRING_RECORDS) throw new PairingLimitError();
      }
      this.writePairings([...records, record]);
    });
    return { nonce, record };
  }
  readPairing(nonce: string): PairingRecord | null {
    return this.withPairing(nonce, (record) => record ?? null);
  }
  /**
   * The record as the file holds it, read without the lock (every write is an atomic rename, so a
   * read sees one whole version). For a caller that only watches, such as a claim waiting for the
   * person's decision, which must not stall or fail while another process holds the lock.
   */
  peekPairing(nonce: string): PairingRecord | null {
    const hash = nonceHash(nonce);
    return this.readPairingsFile().find((r) => r.nonceHash === hash) ?? null;
  }
  /**
   * A verified key presenting a code (the authenticator calls this only after the signature
   * verifies). The first key claims an open, unexpired code and is registered as pending in the same
   * transaction, in a slot kept for pairing if the ordinary ones are full; the same key again is the
   * same claim; anything else is refused by its own outcome and registers nothing. Another key
   * presenting a code that waits for the decision is counted for the terminal, and so is a claim the
   * full queue refused.
   */
  async claimPairing(
    nonce: string,
    publicKey: string,
    label: string,
  ): Promise<PairingClaimOutcome> {
    const fingerprint = await validatePublicKey(publicKey);
    return this.withPairing(nonce, (record, save): PairingClaimOutcome => {
      if (record === undefined) return 'PAIRING_UNKNOWN';
      if (record.state === 'cancelled') return 'PAIRING_CANCELLED';
      if (record.claim !== null && record.claim.publicKey !== publicKey) {
        // At the cap, only a different contender is worth a write (it is the one named).
        if (record.contested < PAIRING_COUNT_CAP || record.lastContender !== fingerprint) {
          const contested = Math.min(record.contested + 1, PAIRING_COUNT_CAP);
          save({ ...record, contested, lastContender: fingerprint });
        }
        return 'PAIRING_USED';
      }
      if (record.state === 'rejected') return 'PAIRING_REJECTED';
      if (record.state === 'approved') return 'PAIRING_USED';
      if (record.claim === null && Date.parse(record.expiresAt) <= this.now())
        return 'PAIRING_EXPIRED';
      // Open, or claimed by this key (its candidate may have expired meanwhile): pending again.
      try {
        this.registerPendingInsideTransaction(publicKey, fingerprint, true);
      } catch (err) {
        if (err instanceof PendingQueueFullError) {
          if (record.claim === null && record.queueFull < PAIRING_COUNT_CAP) {
            save({ ...record, queueFull: record.queueFull + 1 });
          }
          return 'PENDING_QUEUE_FULL';
        }
        if (err instanceof DuplicateKeyError) return 'PAIRING_USED';
        throw err;
      }
      if (record.claim === null) {
        const claim = {
          publicKey,
          fingerprint,
          label,
          claimedAt: new Date(this.now()).toISOString(),
        };
        save({ ...record, state: 'claimed', claim });
      }
      return 'CLAIMED';
    });
  }
  /**
   * The person said yes to the fingerprint they were shown: that key is authorized with the label the
   * phone sent, through the one approval mutation, and the record marked approved in the same
   * transaction. A claim stays approvable after its code expires, while its pending key lives.
   */
  async approvePairing(nonce: string, expectedFingerprint: string): Promise<AuthorizedKey> {
    const snapshot = this.readPairing(nonce);
    if (snapshot === null || snapshot.state !== 'claimed' || snapshot.claim === null)
      throw new Error('No claimed pairing to approve');
    if (snapshot.claim.fingerprint !== expectedFingerprint)
      throw new Error('The pairing was claimed by a different key than the one shown');
    const grant = await this.prepareAuthorization(expectedFingerprint, snapshot.claim.label);
    // The pending key behind that fingerprint is the claiming key, not one that merely shares it.
    if (grant.publicKey !== snapshot.claim.publicKey)
      throw new Error('The pending key is not the key that claimed the pairing');
    // A claim never changes once made, so only the state can have moved since the snapshot.
    return this.withPairing(nonce, (record, save) => {
      if (record?.state !== 'claimed')
        throw new Error('The pairing changed before it was approved');
      const committed = this.commitAuthorizationInsideTransaction(expectedFingerprint, grant);
      save({ ...record, state: 'approved' });
      return committed;
    });
  }
  /** The person said no: the claim is rejected and its pending key removed. */
  rejectPairing(nonce: string): boolean {
    return this.withPairing(nonce, (record, save) => {
      if (record?.state !== 'claimed' || record.claim === null) return false;
      const fingerprint = record.claim.fingerprint;
      this.writePendingKeys(
        this.pendingInsideTransaction().filter((k) => k.fingerprint !== fingerprint),
      );
      save({ ...record, state: 'rejected' });
      return true;
    });
  }
  /** `remi pair` stopped (Ctrl-C, expiry): the code is dead; a key that claimed it stays pending. */
  cancelPairing(nonce: string): boolean {
    return this.withPairing(nonce, (record, save) => {
      if (record === undefined || (record.state !== 'open' && record.state !== 'claimed'))
        return false;
      save({ ...record, state: 'cancelled' });
      return true;
    });
  }
}
