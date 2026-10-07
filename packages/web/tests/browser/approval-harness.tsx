import { type UnlockedIdentity, createIdentity, unlockIdentity } from '@remi/shared';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
/** Real hook with a scheduling checkpoint after real identity key imports. */
import { useConnectionManager } from '../../src/hooks/useConnectionManager';
import {
  importIdentity,
  removeIdentity,
  saveIdentity,
  unlockStoredIdentity,
} from '../../src/lib/identity-client';

let memoryIdentity: UnlockedIdentity | null = null;
let provide: ReturnType<typeof useConnectionManager>['provideIdentity'];
let connect: ReturnType<typeof useConnectionManager>['connectDirect'];
let releaseCheckpoint: (() => void) | undefined;
let checkpointReached = false;
let lastConnections: ReturnType<typeof useConnectionManager>['connections'] = [];
const checkpoint = new Promise<void>((resolve) => {
  releaseCheckpoint = resolve;
});

function Harness() {
  const manager = useConnectionManager({
    autoReconnect: false,
    unlockedIdentity: memoryIdentity,
  });
  useEffect(() => {
    connect = manager.connectDirect;
    provide = manager.provideIdentity;
    lastConnections = manager.connections;
  });
  return <output data-testid="manager-state">{JSON.stringify(manager.connections)}</output>;
}

export async function start(
  options: { stored?: 'none' | 'plain' | 'encrypted'; memoryOnly?: boolean } = {},
) {
  const identity = await createIdentity(
    options.stored === 'encrypted' ? 'isolated-passphrase' : undefined,
  );
  if (options.memoryOnly) memoryIdentity = await unlockIdentity(identity);
  else if (options.stored !== 'none') saveIdentity(identity);
  // Scheduling only: await the ORIGINAL browser import and eventually return
  // that exact CryptoKey. No key/signature/auth result is substituted.
  const originalImport = crypto.subtle.importKey.bind(crypto.subtle);
  crypto.subtle.importKey = async (
    format: KeyFormat,
    data: BufferSource | JsonWebKey,
    algorithm: AlgorithmIdentifier,
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<CryptoKey> => {
    const key =
      format === 'jwk'
        ? await originalImport('jwk', data as JsonWebKey, algorithm, extractable, usages)
        : await originalImport(format, data as BufferSource, algorithm, extractable, usages);
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    if (!checkpointReached && format === 'raw' && name === 'Ed25519') {
      checkpointReached = true;
      await checkpoint;
    }
    return key;
  };
  const container = document.createElement('div');
  document.body.append(container);
  createRoot(container).render(<Harness />);
  return { publicKey: identity.publicKey, fingerprint: identity.fingerprint };
}
export function connectTo(url: string) {
  connect(url);
}
export function reached() {
  return checkpointReached;
}
export function release() {
  releaseCheckpoint?.();
}
export function snapshot() {
  return lastConnections;
}
export async function replaceIdentity() {
  const identity = await createIdentity();
  importIdentity(JSON.stringify(identity));
  return identity.fingerprint;
}
export function deleteIdentity() {
  removeIdentity();
}

export async function providePassphrase() {
  provide('' as Parameters<typeof provide>[0], await unlockStoredIdentity('isolated-passphrase'));
}
