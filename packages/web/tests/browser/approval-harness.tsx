/** Real hook with a scheduling checkpoint after real identity key imports. */
import { useConnectionManager } from '../../src/hooks/useConnectionManager';
import { createIdentity } from '@remi/shared';
import { importIdentity, removeIdentity, saveIdentity } from '../../src/lib/identity-client';
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';

let connect: ReturnType<typeof useConnectionManager>['connectDirect'];
let releaseCheckpoint: (() => void) | undefined;
let checkpointReached = false;
let lastConnections: ReturnType<typeof useConnectionManager>['connections'] = [];
const checkpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });

function Harness() {
  const manager = useConnectionManager({
    autoReconnect: false,
    identitySetupCheckpoint: async () => { checkpointReached = true; await checkpoint; },
  });
  useEffect(() => { connect = manager.connectDirect; lastConnections = manager.connections; });
  return <output data-testid="manager-state">{JSON.stringify(manager.connections)}</output>;
}

export async function start() {
  const identity = await createIdentity();
  saveIdentity(identity);
  const container = document.createElement('div');
  document.body.append(container);
  createRoot(container).render(<Harness />);
  return { publicKey: identity.publicKey, fingerprint: identity.fingerprint };
}
export function connectTo(url: string) { connect(url); }
export function reached() { return checkpointReached; }
export function release() { releaseCheckpoint?.(); }
export function snapshot() { return lastConnections; }
export async function replaceIdentity() {
  const identity = await createIdentity();
  importIdentity(JSON.stringify(identity));
  return identity.fingerprint;
}
export function deleteIdentity() { removeIdentity(); }
