/** A ready peer's authority is re-read on every frame in both directions (R3).
 * An unreadable store and a revoked grant both close the peer; the log says which (#1201).
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPing,
  createSessionListRequest,
  createSessionListResponse,
  createSessionUpdate,
  deserialize,
  relayV2,
  serialize,
} from '@remi/shared';
import { resumed } from './relay-r3-fixture.ts';

test('a real busy authority writer retires the peer without blocking the hub event loop (#1224)', async () => {
  const owned = await resumed();
  const durablePaths = ['authorized_keys.json', 'relay_devices.json'].map((name) =>
    join(owned.dir, name),
  );
  const durableBefore = durablePaths.map((file) => readFileSync(file));
  const holder = Bun.spawn(
    [
      process.execPath,
      new URL('../../packages/daemon/tests/lock-holder-worker.ts', import.meta.url).pathname,
      owned.dir,
      '2600',
    ],
    { cwd: owned.dir, env: {}, stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const deadline = performance.now() + 3000;
    while (!existsSync(join(owned.dir, 'lock-held'))) {
      if (holder.exitCode !== null || performance.now() >= deadline)
        throw new Error('OWNED_LOCK_HOLDER_DID_NOT_ACQUIRE');
      await Bun.sleep(5);
    }
    const lockPath = join(owned.dir, 'authorized_keys.json.lock');
    const lockBefore = readFileSync(lockPath);
    expect(JSON.parse(lockBefore.toString()).pid).toBe(holder.pid);
    const started = performance.now();
    const tick = new Promise<number>((resolve) =>
      setTimeout(() => resolve(performance.now() - started), 0),
    );
    owned.relay.broadcast(createSessionUpdate('owned-session', 'idle'));
    const elapsed = performance.now() - started;
    const timerElapsed = await tick;
    expect(holder.exitCode).toBeNull();
    expect(readFileSync(lockPath)).toEqual(lockBefore);
    expect(durablePaths.map((file) => readFileSync(file))).toEqual(durableBefore);
    expect(elapsed).toBeLessThan(500);
    expect(timerElapsed).toBeLessThan(500);
    // Only an authenticated BYE may leave after the failed authority check.
    const frame = await owned.socket.binary();
    expect(frame[0]).toBe(relayV2.TYPE_BYE);
    expect(await owned.channel.receive(frame)).toBeNull();
    await owned.channel.bye();
    expect((await owned.socket.closed).code).toBeGreaterThan(0);
    expect(await owned.socket.quiet(50)).toBe(true);
    const authority = owned.logs.filter((line) => line.startsWith('Relay authority'));
    expect(authority).toEqual([
      'Relay authority store unreadable (InterprocessFileLockError); failing closed, not a revocation',
    ]);
    expect(owned.logs.some((line) => line.includes('no longer current'))).toBe(false);
    expect(await holder.exited).toBe(0);
    // A transient busy writer is not durable revocation: fresh READY can resync.
    const fresh = await owned.connect();
    expect(owned.relay.sendRaw(fresh.cid, createSessionUpdate('owned-session', 'idle'))).toBe(true);
    const payload = await fresh.channel.receive(await fresh.socket.binary());
    expect(payload === null || payload === undefined).toBe(false);
    expect(payload && deserialize(new TextDecoder().decode(payload))?.type).toBe('session_update');
  } finally {
    expect(await holder.exited).toBe(0);
    expect(await new Response(holder.stderr).text()).toBe('');
    await owned.cleanup();
  }
}, 15000);

for (const trigger of ['inbound', 'connection-count', 'connection-presence'] as const) {
  test(`a ${trigger} authority check under a real busy writer permanently retires the peer (#1224)`, async () => {
    const owned = await resumed();
    expect(owned.relay.hasConnection(owned.cid)).toBe(true);
    expect(owned.relay.connectionCount).toBe(1);
    const durablePaths = ['authorized_keys.json', 'relay_devices.json'].map((name) =>
      join(owned.dir, name),
    );
    const durableBefore = durablePaths.map((file) => readFileSync(file));
    const holder = Bun.spawn(
      [
        process.execPath,
        new URL('../../packages/daemon/tests/lock-holder-worker.ts', import.meta.url).pathname,
        owned.dir,
        '2600',
      ],
      { cwd: owned.dir, env: {}, stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const deadline = performance.now() + 3000;
      while (!existsSync(join(owned.dir, 'lock-held'))) {
        if (holder.exitCode !== null || performance.now() >= deadline)
          throw new Error('OWNED_LOCK_HOLDER_DID_NOT_ACQUIRE');
        await Bun.sleep(5);
      }
      const lockPath = join(owned.dir, 'authorized_keys.json.lock');
      const lockBefore = readFileSync(lockPath);
      expect(JSON.parse(lockBefore.toString()).pid).toBe(holder.pid);
      const started = performance.now();
      const tick = new Promise<number>((resolve) =>
        setTimeout(() => resolve(performance.now() - started), 0),
      );
      // A timeout becomes a runtime assertion: silence is not orderly retirement.
      const received = owned.socket.binary(500).catch(() => undefined);
      if (trigger === 'inbound')
        await owned.channel.send(new TextEncoder().encode(serialize(createPing())));
      else if (trigger === 'connection-count') expect(owned.relay.connectionCount).toBe(0);
      else expect(owned.relay.hasConnection(owned.cid)).toBe(false);
      const timerElapsed = await tick;
      const frame = await received;
      expect(timerElapsed).toBeLessThan(500);
      expect(holder.exitCode).toBeNull();
      expect(readFileSync(lockPath)).toEqual(lockBefore);
      expect(durablePaths.map((file) => readFileSync(file))).toEqual(durableBefore);
      expect(owned.logs.filter((line) => line.startsWith('Relay authority'))).toEqual([
        'Relay authority store unreadable (InterprocessFileLockError); failing closed, not a revocation',
      ]);
      expect(frame).toBeDefined();
      if (!frame) throw new Error('AUTHENTICATED_RETIREMENT_MISSING');
      expect(performance.now() - started).toBeLessThan(500);
      expect(holder.exitCode).toBeNull();
      expect(readFileSync(lockPath)).toEqual(lockBefore);
      expect(durablePaths.map((file) => readFileSync(file))).toEqual(durableBefore);
      // No PONG/DATA after refusal; the wrapper queue must still consume reply BYE.
      expect(frame[0]).toBe(relayV2.TYPE_BYE);
      expect(await owned.channel.receive(frame)).toBeNull();
      await owned.channel.bye();
      owned.socket.close();
      expect((await owned.socket.closed).code).toBe(1000);
      expect(await owned.socket.quiet(50)).toBe(true);
      expect(owned.logs.some((line) => line.includes('no longer current'))).toBe(false);
      expect(await holder.exited).toBe(0);
      expect(owned.logs.some((line) => line.startsWith('Relay delivery uncertain:'))).toBe(false);
      expect(owned.relay.sendRaw(owned.cid, createSessionUpdate('owned-session', 'idle'))).toBe(
        false,
      );
      // The captured peer stays retired after contention; fresh same-Dpk READY recovers.
      const fresh = await owned.connect();
      const ping = createPing();
      await fresh.channel.send(new TextEncoder().encode(serialize(ping)));
      const payload = await fresh.channel.receive(await fresh.socket.binary());
      const pong = payload ? deserialize(new TextDecoder().decode(payload)) : null;
      expect(pong?.type).toBe('pong');
      expect(pong?.type === 'pong' && pong.pingId).toBe(ping.id);
    } finally {
      expect(await holder.exited).toBe(0);
      expect(await new Response(holder.stderr).text()).toBe('');
      await owned.cleanup();
    }
  }, 15000);
}

test('a held session-list response resumes into a real busy writer and retires the READY peer (#1224)', async () => {
  let release: (() => boolean) | undefined;
  let localRequestId: string | undefined;
  let localRequests = 0;
  const owned = await resumed({
    onSessionListRequest: (cid, id) => {
      localRequests++;
      localRequestId = id;
      release = () => owned.relay.sendRaw(cid, createSessionListResponse([], id));
    },
  });
  try {
    const request = createSessionListRequest();
    await owned.channel.send(new TextEncoder().encode(serialize(request)));
    const enteredDeadline = performance.now() + 1000;
    while (!release && performance.now() < enteredDeadline) await Bun.sleep(5);
    expect(localRequests).toBe(1);
    expect(localRequestId).toBe(request.id);
    expect(release).toBeDefined();
    const durablePaths = ['authorized_keys.json', 'relay_devices.json'].map((name) =>
      join(owned.dir, name),
    );
    const durableBefore = durablePaths.map((file) => readFileSync(file));
    const holder = Bun.spawn(
      [
        process.execPath,
        new URL('../../packages/daemon/tests/lock-holder-worker.ts', import.meta.url).pathname,
        owned.dir,
        '2600',
      ],
      { cwd: owned.dir, env: {}, stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const deadline = performance.now() + 3000;
      while (!existsSync(join(owned.dir, 'lock-held'))) {
        if (holder.exitCode !== null || performance.now() >= deadline)
          throw new Error('OWNED_LOCK_HOLDER_DID_NOT_ACQUIRE');
        await Bun.sleep(5);
      }
      const lockPath = join(owned.dir, 'authorized_keys.json.lock');
      const lockBefore = readFileSync(lockPath);
      expect(JSON.parse(lockBefore.toString()).pid).toBe(holder.pid);
      const started = performance.now();
      const tick = new Promise<number>((resolve) =>
        setTimeout(() => resolve(performance.now() - started), 0),
      );
      const received = owned.socket.binary(500).catch(() => undefined);
      // sendRaw resolves the matching local waiter without checking authority or
      // emitting a frame. The first fault is sessionList's check after its await.
      expect(release?.()).toBe(false);
      const timerElapsed = await tick;
      const frame = await received;
      expect(timerElapsed).toBeLessThan(500);
      expect(holder.exitCode).toBeNull();
      expect(readFileSync(lockPath)).toEqual(lockBefore);
      expect(durablePaths.map((file) => readFileSync(file))).toEqual(durableBefore);
      expect(owned.logs.filter((line) => line.startsWith('Relay authority'))).toEqual([
        'Relay authority store unreadable (InterprocessFileLockError); failing closed, not a revocation',
      ]);
      expect(frame).toBeDefined();
      if (!frame) throw new Error('POST_AWAIT_AUTHENTICATED_RETIREMENT_MISSING');
      expect(performance.now() - started).toBeLessThan(500);
      expect(frame[0]).toBe(relayV2.TYPE_BYE);
      expect(await owned.channel.receive(frame)).toBeNull();
      await owned.channel.bye();
      owned.socket.close();
      expect((await owned.socket.closed).code).toBe(1000);
      expect(await owned.socket.quiet(50)).toBe(true);
      expect(await holder.exited).toBe(0);
      expect(owned.logs.some((line) => line.startsWith('Relay delivery uncertain:'))).toBe(false);
      expect(owned.relay.sendRaw(owned.cid, createSessionUpdate('owned-session', 'idle'))).toBe(
        false,
      );
      const fresh = await owned.connect();
      const ping = createPing();
      await fresh.channel.send(new TextEncoder().encode(serialize(ping)));
      const payload = await fresh.channel.receive(await fresh.socket.binary());
      const pong = payload ? deserialize(new TextDecoder().decode(payload)) : null;
      expect(pong?.type).toBe('pong');
      expect(pong?.type === 'pong' && pong.pingId).toBe(ping.id);
      expect(localRequests).toBe(1);
    } finally {
      expect(await holder.exited).toBe(0);
      expect(await new Response(holder.stderr).text()).toBe('');
    }
  } finally {
    release?.();
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
