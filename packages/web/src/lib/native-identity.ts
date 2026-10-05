import { Preferences } from '@capacitor/preferences';
import { fingerprint, fromBase64, isEncrypted, relayV2, toBase64 } from '@remi/shared';
import type { RemiIdentity } from '@remi/shared';
import type { Base64, Fingerprint } from '@remi/shared';
import type { NativeSigningIdentity } from './client-signer';
import {
  getIdentityRevision,
  loadIdentity,
  removeIdentity,
  unlockStoredIdentity,
} from './identity-client';
import { isIOS, isNative } from './platform';

interface Reply {
  readonly exists: true;
  readonly publicKey: Base64;
  readonly fingerprint: Fingerprint;
  readonly revision: string;
  readonly requiresAppUnlock: boolean;
  readonly locked: boolean;
  readonly requiresRestart?: boolean;
}

export type NativeIdentityState =
  | { readonly kind: 'ready'; readonly identity: NativeSigningIdentity }
  | {
      readonly kind: 'migration';
      readonly native: Reply | null;
      readonly legacy: RemiIdentity;
      readonly legacyFingerprint: string;
    }
  | { readonly kind: 'locked' | 'restart'; readonly native: Reply };

type Ingress = { postMessage(request: Readonly<Record<string, unknown>>): Promise<unknown> };
let ready: NativeSigningIdentity | null = null;
let restartRequired = false;

/** iOS/macOS must fail closed when their native ingress is absent. Android has no R4 target. */
export function usesNativeIdentity(): boolean {
  return typeof window !== 'undefined' && (window.location.protocol === 'remi-app:' || isIOS());
}

function ingress(): Ingress {
  const value = (window as unknown as { webkit?: { messageHandlers?: { remiIdentity?: Ingress } } })
    .webkit?.messageHandlers?.remiIdentity;
  if (!usesNativeIdentity() || !value)
    throw new Error('The durable native signer is unavailable. Restart Remi.');
  return value;
}

async function request(
  value: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Native identity request timed out.')), 30_000);
  });
  try {
    const result = await Promise.race([ingress().postMessage(value), timeout]);
    signal?.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function publicReply(value: unknown, extra: readonly string[] = []): Promise<Reply | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native identity reply.');
  const record = value as Record<string, unknown>;
  if (record['exists'] === false && Object.keys(record).length === 1) return null;
  const allowed = new Set([
    'exists',
    'publicKey',
    'fingerprint',
    'revision',
    'requiresAppUnlock',
    'locked',
    ...extra,
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record['exists'] !== true ||
    typeof record['publicKey'] !== 'string' ||
    typeof record['fingerprint'] !== 'string' ||
    typeof record['revision'] !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record['revision']) ||
    typeof record['requiresAppUnlock'] !== 'boolean' ||
    typeof record['locked'] !== 'boolean' ||
    ('requiresRestart' in record && typeof record['requiresRestart'] !== 'boolean')
  ) {
    throw new Error('Invalid public native identity reply.');
  }
  const raw = fromBase64(record['publicKey']);
  if (
    raw.byteLength !== 32 ||
    toBase64(raw) !== record['publicKey'] ||
    relayV2.isSmallOrderPublicKey(new Uint8Array(raw)) ||
    (await fingerprint(raw)) !== record['fingerprint']
  )
    throw new Error('Invalid native public key.');
  return record as unknown as Reply;
}

async function read(signal?: AbortSignal): Promise<Reply | null> {
  const value = await publicReply(await request({ op: 'public' }, signal));
  signal?.throwIfAborted();
  return value;
}

function signer(record: Reply): NativeSigningIdentity {
  return Object.freeze({
    kind: 'native',
    publicKeyRaw: record.publicKey,
    fingerprint: record.fingerprint,
    revision: record.revision,
    requiresAppUnlock: record.requiresAppUnlock,
    async sign(message: Uint8Array): Promise<Base64> {
      if (restartRequired || message.byteLength < 1 || message.byteLength > 4096)
        throw new Error('Native signing refused.');
      const result = await request({
        op: 'sign',
        revision: record.revision,
        publicKey: record.publicKey,
        message: toBase64(message.slice().buffer as ArrayBuffer),
      });
      const verified = await publicReply(result, ['signature']);
      const signature = (result as Record<string, unknown>)['signature'];
      if (
        !verified ||
        verified.revision !== record.revision ||
        verified.publicKey !== record.publicKey ||
        verified.locked ||
        typeof signature !== 'string' ||
        !(await relayV2.verifySignature(
          new Uint8Array(fromBase64(record.publicKey)),
          message,
          new Uint8Array(fromBase64(signature)),
        ))
      )
        throw new Error('Native identity changed while signing.');
      const current = await read();
      if (
        restartRequired ||
        !current ||
        current.revision !== record.revision ||
        current.publicKey !== record.publicKey ||
        current.locked
      ) {
        throw new Error('Native identity changed while signing.');
      }
      return signature as Base64;
    },
  });
}

function selected(record: Reply): NativeIdentityState {
  ready = null;
  if (restartRequired || record.requiresRestart) {
    restartRequired = true;
    return { kind: 'restart', native: record };
  }
  if (record.locked) return { kind: 'locked', native: record };
  ready = signer(record);
  return { kind: 'ready', identity: ready };
}

export function currentNativeIdentity(): NativeSigningIdentity | null {
  return ready;
}

/** Legacy records remain untouched until a human chooses and durable readback succeeds. */
export async function inspectNativeIdentity(signal?: AbortSignal): Promise<NativeIdentityState> {
  signal?.throwIfAborted();
  const revision = getIdentityRevision();
  const legacy = loadIdentity();
  let native = await read(signal);
  if (revision !== getIdentityRevision()) throw new Error('Identity changed during setup.');
  if (legacy) {
    ready = null;
    const legacyFingerprint = await fingerprint(fromBase64(legacy.publicKey));
    if (revision !== getIdentityRevision())
      throw new Error('Legacy identity changed during setup.');
    return { kind: 'migration', native, legacy, legacyFingerprint };
  }
  if (!native) native = await publicReply(await request({ op: 'create' }, signal));
  if (signal?.aborted || !native || revision !== getIdentityRevision() || loadIdentity())
    throw new Error('Identity changed during setup.');
  return selected(native);
}

/** One-way JS-owned legacy PKCS8 import; native private bytes never return to JS. */
export async function chooseNativeIdentity(
  state: Extract<NativeIdentityState, { kind: 'migration' }>,
  choice: 'native' | 'legacy',
  passphrase?: string,
  signal?: AbortSignal,
): Promise<NativeIdentityState> {
  ready = null;
  const revision = getIdentityRevision();
  const legacy = loadIdentity();
  const context = JSON.stringify(legacy);
  if (!legacy || context !== JSON.stringify(state.legacy))
    throw new Error('Legacy identity changed.');
  const current = await read(signal);
  const valid = () =>
    !signal?.aborted &&
    revision === getIdentityRevision() &&
    JSON.stringify(loadIdentity()) === context;
  if (!valid() || current?.revision !== state.native?.revision)
    throw new Error('Identity changed during migration.');
  let chosen: Reply | null;
  if (choice === 'native') {
    if (!current) throw new Error('No existing native identity.');
    chosen =
      isEncrypted(legacy) && !current.requiresAppUnlock
        ? await publicReply(
            await request({
              op: 'protect',
              revision: current.revision,
              publicKey: current.publicKey,
            }),
            ['requiresRestart'],
          )
        : current;
  } else {
    const unlocked = await unlockStoredIdentity(passphrase);
    if (!valid()) throw new Error('Legacy identity changed during unlock.');
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', unlocked.privateKey);
    try {
      if (!valid()) throw new Error('Legacy identity changed during export.');
      chosen = await publicReply(
        await request({
          op: 'import',
          pkcs8: toBase64(pkcs8),
          publicKey: legacy.publicKey,
          revision: current?.revision ?? null,
          requiresAppUnlock: isEncrypted(legacy),
        }),
        ['requiresRestart'],
      );
    } finally {
      new Uint8Array(pkcs8).fill(0);
    }
  }
  if (!valid() || !chosen)
    throw new Error('Identity changed during migration. Legacy storage was preserved.');
  const durable = await read(signal);
  if (
    !valid() ||
    !durable ||
    durable.revision !== chosen.revision ||
    durable.publicKey !== chosen.publicKey ||
    (isEncrypted(legacy) && !durable.requiresAppUnlock)
  )
    throw new Error('Native persistence was not verified. Legacy storage was preserved.');
  // Rebind native direct answers first (RemiNativeStore); cleanup only after actual durable verification.
  if (isNative()) await Preferences.remove({ key: 'remi-native-identity' });
  const stillDurable = await read(signal);
  if (
    !valid() ||
    !stillDurable ||
    stillDurable.revision !== chosen.revision ||
    stillDurable.publicKey !== chosen.publicKey
  )
    throw new Error('Native identity changed before cleanup. Legacy storage was preserved.');
  removeIdentity();
  return selected({ ...durable, ...(chosen.requiresRestart ? { requiresRestart: true } : {}) });
}

export async function unlockNativeIdentity(
  record: Reply,
  signal?: AbortSignal,
): Promise<NativeIdentityState> {
  const result = await publicReply(
    await request({ op: 'unlock', revision: record.revision, publicKey: record.publicKey }, signal),
  );
  if (signal?.aborted || !result || result.revision !== record.revision || result.locked)
    throw new Error('Native identity unlock failed.');
  return selected(result);
}
