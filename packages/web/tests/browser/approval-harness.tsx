/* eslint-disable react-refresh/only-export-components -- This test module exports harness controls. */
import {
  type ProtocolMessage,
  type UnlockedIdentity,
  createIdentity,
  unlockIdentity,
} from '@remi/shared';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
let initialIdentityProp: UnlockedIdentity | null = null;
let provide: ReturnType<typeof useConnectionManager>['provideIdentity'];
let connect: ReturnType<typeof useConnectionManager>['connectDirect'];
let releaseCheckpoint: (() => void) | undefined;
let checkpointReached = false;
let lastConnections: ReturnType<typeof useConnectionManager>['connections'] = [];
const wireTrace: Array<Record<string, unknown>> = [];
const stateTrace: Array<Array<Record<string, unknown>>> = [];
let setIdentityInput: (input: {
  identity: UnlockedIdentity | null;
  revision: number;
}) => void;
let propRevision = 0;
const checkpoint = new Promise<void>((resolve) => {
  releaseCheckpoint = resolve;
});

function Harness() {
  const [identityInput, setIdentityInputState] = useState({
    identity: initialIdentityProp,
    revision: 0,
  });
  const { identity: identityProp, revision: identityRevision } = identityInput;
  const outputRef = useRef<HTMLOutputElement>(null);
  const previousConnections = useRef<ReturnType<typeof useConnectionManager>['connections']>([]);
  const manager = useConnectionManager({
    autoReconnect: false,
    unlockedIdentity: identityProp,
    onMessage: (_connectionId, message: ProtocolMessage) => {
      const item = message as ProtocolMessage & {
        sessionId?: unknown;
        attachState?: unknown;
        harness?: unknown;
        harnessSessionId?: unknown;
      };
      wireTrace.push({
        type: item.type,
        ...(typeof item.sessionId === 'string' || item.sessionId === null
          ? { sessionId: item.sessionId }
          : {}),
        ...(typeof item.attachState === 'string' ? { attachState: item.attachState } : {}),
        ...(typeof item.harness === 'string' ? { harness: item.harness } : {}),
        ...(typeof item.harnessSessionId === 'string'
          ? { harnessSessionId: item.harnessSessionId }
          : {}),
      });
      if (wireTrace.length > 100) wireTrace.shift();
    },
  });
  useEffect(() => {
    connect = manager.connectDirect;
    provide = manager.provideIdentity;
    lastConnections = manager.connections;
    stateTrace.push(
      manager.connections.map((connection) => ({
        connectionId: connection.connectionId,
        url: connection.url,
        status: connection.status,
        sessionId: connection.sessionId,
        attachState: connection.attachState,
        harness: connection.harness,
        harnessSessionId: connection.harnessSessionId,
        capabilities: connection.capabilities,
        imageUploadEnabled: connection.imageUploadEnabled,
      })),
    );
    if (stateTrace.length > 100) stateTrace.shift();
    setIdentityInput = setIdentityInputState;
  }, [manager.connectDirect, manager.provideIdentity, manager.connections]);
  useEffect(() => {
    if (manager.connections === previousConnections.current) return;
    previousConnections.current = manager.connections;
    outputRef.current?.setAttribute('data-prop-effect-revision', String(identityRevision));
  }, [identityRevision, manager.connections]);
  return (
    <output
      ref={outputRef}
      data-testid="manager-state"
      data-prop-effect-revision="0"
      data-identity-prop={identityProp?.publicKeyRaw ?? 'none'}
    >
      {JSON.stringify(manager.connections)}
    </output>
  );
}

export async function start(
  options: {
    stored?: 'none' | 'plain' | 'encrypted';
    memoryOnly?: boolean;
    deferIdentityProp?: boolean;
  } = {},
) {
  const identity = await createIdentity(
    options.stored === 'encrypted' ? 'isolated-passphrase' : undefined,
  );
  if (options.memoryOnly) memoryIdentity = await unlockIdentity(identity);
  else if (options.stored !== 'none') saveIdentity(identity);
  initialIdentityProp = options.deferIdentityProp ? null : memoryIdentity;
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
export function trace() {
  return { messages: wireTrace, states: stateTrace };
}
export function provideCurrentIdentity() {
  if (!memoryIdentity) throw new Error('No memory identity is installed');
  provide('' as Parameters<typeof provide>[0], memoryIdentity);
}
export function applyMatchingIdentityProp() {
  if (!memoryIdentity) throw new Error('No memory identity is installed');
  propRevision += 1;
  flushSync(() => {
    setIdentityInput({ identity: memoryIdentity, revision: propRevision });
  });
  return { revision: propRevision, publicKeyRaw: memoryIdentity.publicKeyRaw };
}
export async function replacePropIdentity() {
  propRevision += 1;
  const identity = await unlockIdentity(await createIdentity());
  flushSync(() => {
    setIdentityInput({ identity, revision: propRevision });
  });
  return { revision: propRevision, publicKeyRaw: identity.publicKeyRaw };
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
