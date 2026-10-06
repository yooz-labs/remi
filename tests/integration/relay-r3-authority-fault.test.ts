/** A ready peer's authority is re-read on every frame in both directions (R3).
 * An unreadable store and a revoked grant both close the peer; the log says which (#1201).
 */
import { expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createSessionUpdate } from '@remi/shared';
import { resumed } from './relay-r3-fixture.ts';

/** A lock owned by a live foreign process, exactly what a concurrent `remi authorize` leaves. */
function holdForeignLock(dir: string): () => void {
  const lockPath = join(dir, 'authorized_keys.json.lock');
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      ownerId: 'owned-foreign-owner',
      pid: process.ppid,
      host: hostname(),
      acquiredAt: Date.now(),
    }),
  );
  return () => rmSync(lockPath, { force: true });
}

test('an unreadable authority store closes the peer and is logged as a store fault, not a revocation (#1201)', async () => {
  const owned = await resumed();
  const release = holdForeignLock(owned.dir);
  try {
    // The outbound check waits out the real 2 s lock timeout, then fails closed.
    owned.relay.broadcast(createSessionUpdate('owned-session', 'idle'));
    release();
    expect((await owned.socket.closed).code).toBeGreaterThan(0);
    const authority = owned.logs.filter((line) => line.startsWith('Relay authority'));
    expect(authority).toEqual([
      'Relay authority store unreadable (InterprocessFileLockError); failing closed, not a revocation',
    ]);
    expect(owned.logs.some((line) => line.includes('no longer current'))).toBe(false);
  } finally {
    release();
    await owned.cleanup();
  }
}, 15000);

test('a revoked grant closes the peer and is logged as a revocation (#1201)', async () => {
  const owned = await resumed();
  try {
    expect(owned.trust.removeAuthorizedKey(owned.device.fingerprint)).toBe(true);
    owned.relay.broadcast(createSessionUpdate('owned-session', 'idle'));
    expect((await owned.socket.closed).code).toBeGreaterThan(0);
    expect(owned.logs.filter((line) => line.startsWith('Relay authority'))).toEqual([
      'Relay authority no longer current; failing closed',
    ]);
    expect(owned.logs.some((line) => line.includes('unreadable'))).toBe(false);
  } finally {
    await owned.cleanup();
  }
}, 15000);
