import { fromBase64, relayV2, toBase64 } from '@remi/shared';
import type { NativeSigningIdentity } from './client-signer';
import { getIdentityRevision } from './identity-client';
import { currentNativeIdentity, nativeIdentityRequest } from './native-identity';
import type { RelayMachinePin } from './relay-machine-channel';

export interface NativePairingAttempt {
  readonly attempt: string;
  readonly identity: NativeSigningIdentity;
  readonly localRevision: number;
}

function current(identity: NativeSigningIdentity, revision: number): void {
  const live = currentNativeIdentity();
  if (
    !live ||
    getIdentityRevision() !== revision ||
    live.publicKeyRaw !== identity.publicKeyRaw ||
    live.revision !== identity.revision ||
    live.requiresAppUnlock !== identity.requiresAppUnlock
  )
    throw new Error('The native identity changed during pairing. Unlock it and try again.');
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('Invalid native pairing reply.');
  return value as Record<string, unknown>;
}

function context(identity: NativeSigningIdentity): { publicKey: string; revision: string } {
  return { publicKey: identity.publicKeyRaw, revision: identity.revision };
}

export async function beginNativePairingTrust(
  identity: NativeSigningIdentity,
): Promise<NativePairingAttempt> {
  const localRevision = getIdentityRevision();
  current(identity, localRevision);
  const reply = object(
    await nativeIdentityRequest({ op: 'beginPushPairing', ...context(identity) }),
    ['attempt', 'publicKey', 'revision'],
  );
  current(identity, localRevision);
  if (
    typeof reply['attempt'] !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reply['attempt']) ||
    reply['publicKey'] !== identity.publicKeyRaw ||
    reply['revision'] !== identity.revision
  )
    throw new Error('Invalid native pairing attempt.');
  return { attempt: reply['attempt'], identity, localRevision };
}

/** Called only by the actual authenticated/encrypted READY continuation, never an outer push flag. */
export async function commitNativePairingTrust(
  attempt: NativePairingAttempt,
  pin: RelayMachinePin,
): Promise<void> {
  current(attempt.identity, attempt.localRevision);
  const machine = relayV2.fromB64u(pin.machinePublicKey);
  const url = new URL(pin.relayUrl);
  if (
    machine.length !== 32 ||
    relayV2.isSmallOrderPublicKey(machine) ||
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Native secure pairing requires a secure relay endpoint.');
  const rid = await relayV2.ridOf(machine);
  current(attempt.identity, attempt.localRevision);
  const endpoint = new URL(url.href);
  endpoint.protocol = 'https:';
  let result: unknown;
  try {
    result = await nativeIdentityRequest({
      op: 'commitPushPairing',
      attempt: attempt.attempt,
      ...context(attempt.identity),
      machinePublicKey: toBase64(machine.buffer as ArrayBuffer),
      rid: toBase64(rid.buffer as ArrayBuffer),
      endpoint: endpoint.origin,
      relayUrl: url.href,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Saved machine limit reached.'))
      throw new Error('Saved machine limit reached. Forget a machine before pairing again.');
    throw new Error('The paired machine could not be saved securely. Try pairing again.');
  }
  current(attempt.identity, attempt.localRevision);
  const reply = object(result, ['saved', 'publicKey', 'revision']);
  if (
    reply['saved'] !== true ||
    reply['publicKey'] !== attempt.identity.publicKeyRaw ||
    reply['revision'] !== attempt.identity.revision
  )
    throw new Error('Invalid native pairing commit.');
}

export async function cancelNativePairingTrust(attempt: NativePairingAttempt): Promise<void> {
  const reply = object(
    await nativeIdentityRequest({ op: 'cancelPushPairing', attempt: attempt.attempt }),
    ['cancelled'],
  );
  if (reply['cancelled'] !== true) throw new Error('Native pairing cancellation refused.');
}

/** Native restore reads only complete native records; it never imports browser pins. */
export async function loadNativeRelayPins(
  identity: NativeSigningIdentity,
): Promise<readonly RelayMachinePin[]> {
  const revision = getIdentityRevision();
  current(identity, revision);
  const reply = object(
    await nativeIdentityRequest({ op: 'listPushMachines', ...context(identity) }),
    ['machines'],
  );
  current(identity, revision);
  if (!Array.isArray(reply['machines']) || reply['machines'].length > 32)
    throw new Error('Invalid native machine list.');
  const pins: RelayMachinePin[] = [];
  for (const item of reply['machines']) {
    const record = object(item, ['rid', 'machinePublicKey', 'endpoint', 'relayUrl']);
    if (
      typeof record['machinePublicKey'] !== 'string' ||
      typeof record['rid'] !== 'string' ||
      typeof record['endpoint'] !== 'string' ||
      typeof record['relayUrl'] !== 'string'
    )
      throw new Error('Invalid native machine pin.');
    const machine = new Uint8Array(fromBase64(record['machinePublicKey']));
    const rid = await relayV2.ridOf(machine);
    const url = new URL(record['relayUrl']);
    const endpoint = new URL(url.href);
    endpoint.protocol = 'https:';
    if (
      machine.length !== 32 ||
      relayV2.isSmallOrderPublicKey(machine) ||
      toBase64(machine.buffer as ArrayBuffer) !== record['machinePublicKey'] ||
      toBase64(rid.buffer as ArrayBuffer) !== record['rid'] ||
      url.protocol !== 'wss:' ||
      url.href !== record['relayUrl'] ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      endpoint.origin !== record['endpoint']
    )
      throw new Error('Invalid native machine pin.');
    pins.push({ relayUrl: record['relayUrl'], machinePublicKey: relayV2.b64u(machine) });
  }
  current(identity, revision);
  return pins;
}

export async function forgetNativeRelayPin(
  identity: NativeSigningIdentity,
  machinePublicKey: string,
): Promise<void> {
  const revision = getIdentityRevision();
  current(identity, revision);
  const rid = await relayV2.ridOf(relayV2.fromB64u(machinePublicKey));
  current(identity, revision);
  const reply = object(
    await nativeIdentityRequest({
      op: 'forgetPushMachine',
      ...context(identity),
      rid: toBase64(rid.buffer as ArrayBuffer),
    }),
    ['forgotten'],
  );
  current(identity, revision);
  if (reply['forgotten'] !== true)
    throw new Error('The saved native machine could not be forgotten.');
}
