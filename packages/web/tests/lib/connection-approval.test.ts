/** Real identities and the shipping approval lifecycle; no transport claim. */
import { describe, expect, test } from 'bun:test';
import { createIdentity, fingerprint, fromBase64, unlockIdentity } from '@remi/shared';
import { ConnectionApproval } from '../../src/lib/connection-approval';

describe('first-connect approval (#873)', () => {
  test('retains own public payload after refusal/disconnect/retry until verified success', async () => {
    const identity = await unlockIdentity(await createIdentity());
    const approval = new ConnectionApproval();
    const attempt = await approval.begin(identity, 'ws://localhost:18765');
    approval.refuse(attempt, 'UNKNOWN_KEY');
    const snapshot = approval.snapshot;
    expect(snapshot?.status).toBe('pending');
    expect(snapshot?.fingerprint).toBe(await fingerprint(fromBase64(identity.publicKeyRaw)));
    expect(snapshot?.authorizeCommand).toBe(`remi authorize ${identity.fingerprint}`);
    expect(JSON.parse(snapshot?.publicJson ?? '{}')).toEqual({
      publicKey: identity.publicKeyRaw, fingerprint: identity.fingerprint,
    });
    expect(snapshot?.publicJson).not.toContain('private');
    approval.disconnected();
    expect(approval.snapshot).toEqual(snapshot);
    const retry = await approval.begin(identity, 'ws://localhost:18765');
    expect(approval.snapshot).toEqual(snapshot);
    approval.verified(retry);
    expect(approval.snapshot).toBeNull();
  });

  test('does not apply delayed results after reconnect or identity/host replacement', async () => {
    const identity = await unlockIdentity(await createIdentity());
    const replacement = await unlockIdentity(await createIdentity());
    const approval = new ConnectionApproval();
    const old = await approval.begin(identity, 'ws://localhost:18765');
    approval.disconnected();
    approval.refuse(old, 'UNKNOWN_KEY');
    expect(approval.snapshot).toBeNull();
    const current = await approval.begin(identity, 'ws://localhost:18765');
    approval.refuse(current, 'UNKNOWN_KEY');
    const next = await approval.begin(replacement, 'ws://localhost:18765');
    expect(approval.snapshot).toBeNull();
    approval.refuse(current, 'UNKNOWN_KEY');
    expect(approval.snapshot).toBeNull();
    approval.refuse(next, 'UNKNOWN_KEY');
    await approval.begin(replacement, 'ws://other-host:18765');
    expect(approval.snapshot).toBeNull();
  });

  test('queue/storage errors expose own key without claiming pending; spoof/malformed errors do not', async () => {
    const identity = await unlockIdentity(await createIdentity());
    const approval = new ConnectionApproval();
    const attempt = await approval.begin(identity, 'ws://localhost:18765');
    approval.refuse(attempt, 'PENDING_QUEUE_FULL');
    expect(approval.snapshot?.status).toBe('queue-full');
    approval.refuse(attempt, 'AUTH_STORE_ERROR', 'Unable to save approval request');
    expect(approval.snapshot?.status).toBe('store-error');
    expect(approval.snapshot?.detail).toBe('Unable to save approval request');
    approval.refuse(attempt, 'FINGERPRINT_MISMATCH');
    expect(approval.snapshot).toBeNull();
  });
});
