import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createPing, encodeTerminalViewFrame, serialize } from '@remi/shared';
import {
  InterprocessFileLockError,
  withInterprocessFileLockNonblocking,
} from '../../src/storage/interprocess-file-lock.ts';
import type { TerminalSendSlot } from '../../src/terminal/send-slot.ts';
import {
  type TerminalServiceFixture,
  terminalServiceFixture,
  until,
} from '../helpers/terminal-service-fixture.ts';

const fixtures: TerminalServiceFixture[] = [];
async function fixture(options: Parameters<typeof terminalServiceFixture>[0] = {}) {
  const f = await terminalServiceFixture(options);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const records = (f: TerminalServiceFixture) =>
  Reflect.get(f.service, 'records') as Map<object, unknown>;
const views = (f: TerminalServiceFixture) =>
  (
    JSON.parse(fs.readFileSync(join(f.files.home, 'terminal-view/reservations.json'), 'utf8'))
      .records as { kind: string }[]
  ).filter((row) => row.kind === 'view');

test('overdue actual maintenance preserves a new Open until its first native response', async () => {
  const f = await fixture();
  const peer = await f.client();
  const original = f.service.handle;
  let delayed = false;
  // Make the existing250ms interval overdue before Open creates its later0ms job.
  // Both callbacks and the incoming signedWSS request remain real.
  f.service.handle = (id, ingress) => {
    if (
      !delayed &&
      ingress.kind === 'request' &&
      ingress.request.type === 'session_terminal_open'
    ) {
      delayed = true;
      Bun.sleepSync(275);
    }
    return original.call(f.service, id, ingress);
  };
  try {
    const opened = await peer.submit(peer.open());
    expect(delayed).toBe(true);
    expect(opened.type).toBe('session_terminal_opened');
    expect(records(f).size).toBe(1);
  } finally {
    f.service.handle = original;
  }
});

test('an actual reopen preserves read spacing for the same reserved connection view', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  const packet = peer.packet;
  if (!packet) throw new Error('Expected actual packet TLS peer');
  const recordForPeer = () =>
    records(f).get(peer.connection() as object) as {
      lastRead: number;
      slot: { busy: boolean };
    };
  const settle = async () => {
    await until(packet.hasPendingPong, 'actual reopen-rate native receipt');
    packet.confirmPong();
    await until(() => !recordForPeer().slot.busy, 'actual reopen-rate receipt settled');
  };
  const first = await peer.submit(peer.open());
  if (first.type !== 'session_terminal_opened') throw new Error('Expected first owned view');
  await settle();
  const read = await peer.submit(peer.read(first.viewId));
  expect(read.type).toBe('session_terminal_snapshot');
  const previousRead = recordForPeer().lastRead;
  await settle();
  const reopened = await peer.submit(peer.open());
  if (reopened.type !== 'session_terminal_opened') throw new Error('Expected new owned view');
  expect(reopened.viewId).not.toBe(first.viewId);
  await settle();
  expect(performance.now() - previousRead).toBeLessThan(500);
  const second = await peer.submit(peer.read(reopened.viewId));
  expect(second).toMatchObject({ type: 'session_terminal_refused', code: 'busy' });
  expect(recordForPeer().lastRead).toBe(previousRead);
  await settle();
});

async function grantLock(
  f: TerminalServiceFixture,
  run: () => Promise<void>,
  storePath: unknown = Reflect.get(f.trust, 'authorizedKeysPath'),
) {
  const prefix = join(f.files.home, `held-grant-${randomUUID()}`);
  const path = storePath;
  if (typeof path !== 'string') throw new Error('Expected actual grant store path');
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      resolve(import.meta.dir, '../helpers/terminal-store-lock-holder.ts'),
      path,
      prefix,
    ],
    {
      cwd: f.files.directory,
      env: f.files.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    await until(
      () => fs.existsSync(`${prefix}.ready`) || child.exitCode !== null,
      'actual external grant owner',
    );
    expect(child.exitCode).toBeNull();
    expect(JSON.parse(fs.readFileSync(`${prefix}.ready`, 'utf8')).pid).toBe(child.pid);
    await run();
  } finally {
    fs.writeFileSync(`${prefix}.go`, 'release');
    const timeout = setTimeout(() => child.kill('SIGTERM'), 3000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timeout);
    }
    expect(child.exitCode, await stderr).toBe(0);
    expect(await stdout).toBe('');
    expect(await stderr).toBe('');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  }
}

test('another Open waits for an explicit new request after the shared native owner settles', async () => {
  const f = await fixture();
  const first = await f.client(false, true);
  const second = await f.client(true, true);
  assert(first.packet && second.packet);
  const opened = await first.submit(first.open());
  expect(opened.type).toBe('session_terminal_opened');
  await until(first.packet.hasPendingPong, 'first actual Open receipt remains owned');
  const pressured = second.open();
  second.ws.send(encodeTerminalViewFrame(pressured));
  const ping = createPing();
  second.ws.send(serialize(ping));
  await until(
    () => second.received.some((m) => m.type === 'pong' && m['pingId'] === ping.id),
    'second actual Open processed under shared native pressure',
  );
  const record = records(f).get(second.connection() as object) as {
    viewId: string;
    slot: { busy: boolean };
    intent: unknown;
  };
  expect(record.viewId).toBe('');
  expect(record.slot.busy).toBe(false);
  expect(record.intent).toBeNull();
  expect(second.frames).toEqual([]);
  first.packet.confirmPong();
  await until(
    () => [...records(f).values()].every((r) => !(r as { slot: { busy: boolean } }).slot.busy),
    'prior actual Open receipt settled',
  );
  await Bun.sleep(30);
  expect(second.frames).toEqual([]);
  const fresh = second.open();
  expect(fresh.id).not.toBe(pressured.id);
  expect((await second.submit(fresh)).type).toBe('session_terminal_opened');
});

test('a scheduled Open omitted by actual grant contention requires a fresh explicit request', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  assert(peer.packet);
  const service = f.service as unknown as {
    admit: (...args: unknown[]) => { slot: TerminalSendSlot } | null;
  };
  const admit = service.admit;
  let blocked = false;
  service.admit = (...args) => {
    const record = admit.apply(service, args);
    if (!record) return record;
    const schedule = record.slot.schedule;
    record.slot.schedule = (operation) =>
      schedule.call(record.slot, (deliver) => {
        if (!blocked) {
          blocked = true;
          return withInterprocessFileLockNonblocking(
            Reflect.get(f.trust, 'authorizedKeysPath') as string,
            () => operation(deliver),
          );
        }
        return operation(deliver);
      });
    return record;
  };
  try {
    const pressured = peer.open();
    peer.ws.send(encodeTerminalViewFrame(pressured));
    await until(() => blocked, 'actual scheduled Open enters held original grant');
    const record = records(f).get(peer.connection() as object) as {
      viewId: string;
      slot: TerminalSendSlot;
      intent: unknown;
    };
    expect(record.viewId).toBe('');
    expect(record.slot.busy).toBe(false);
    expect(record.intent).toBeNull();
    expect(peer.frames).toEqual([]);
    await Bun.sleep(30);
    expect(peer.frames).toEqual([]);
    const fresh = peer.open();
    expect(fresh.id).not.toBe(pressured.id);
    expect((await peer.submit(fresh)).type).toBe('session_terminal_opened');
  } finally {
    service.admit = admit;
  }
});

test('a pending reader gets the next native turn before a just-served reader repeats', async () => {
  const f = await fixture();
  const peers = [await f.client(false, true), await f.client(true, true)];
  const leases: string[] = [];
  for (const peer of peers) {
    const opened = await peer.submit(peer.open());
    assert(opened.type === 'session_terminal_opened' && peer.packet);
    leases.push(opened.viewId);
    await until(peer.packet.hasPendingPong, 'actual fair-reader Open receipt');
    peer.packet.confirmPong();
    await until(
      () => [...records(f).values()].every((r) => !(r as { slot: { busy: boolean } }).slot.busy),
      'actual fair-reader Open settled',
    );
  }
  const [first, second] = peers;
  assert(first?.packet && second?.packet && leases[0] && leases[1]);
  const initial = await first.submit(first.read(leases[0]));
  assert(initial.type === 'session_terminal_snapshot');
  await until(first.packet.hasPendingPong, 'actual fair-reader projection held');
  const repeat = first.read(leases[0]);
  const waiting = second.read(leases[1]);
  first.ws.send(encodeTerminalViewFrame(repeat));
  second.ws.send(encodeTerminalViewFrame(waiting));
  await until(
    () => [...records(f).values()].every((r) => !!Reflect.get(r as object, 'intent')),
    'both real reads await shared model disposal',
  );
  const nativeOrder: string[] = [];
  const originals = peers.map((peer) => {
    const native = Reflect.get(peer.connection() as object, 'ws') as { send(text: string): number };
    const send = native.send;
    native.send = (text) => {
      const frame = JSON.parse(text);
      if (typeof frame.requestId === 'string') nativeOrder.push(frame.requestId);
      return send.call(native, text);
    };
    return { native, send };
  });
  try {
    first.packet.confirmPong();
    await until(() => nativeOrder.length > 0, 'next actual native response entered');
    expect(nativeOrder[0]).toBe(waiting.id);
  } finally {
    for (const { native, send } of originals) native.send = send;
  }
});

test('actual grant contention during maintenance retains an admitted view without data', async () => {
  const f = await fixture();
  const peer = await f.client();
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  await until(
    () => [...records(f).values()].every((r) => !(r as { slot: { busy: boolean } }).slot.busy),
    'actual Open receipt settled',
  );
  const maintain = Reflect.get(f.service, 'maintain') as () => void;
  let observed = 0;
  Reflect.set(f.service, 'maintain', () => {
    const result = maintain.call(f.service);
    observed++;
    return result;
  });
  try {
    await grantLock(f, async () => {
      const before = observed;
      await until(() => observed > before, 'actual maintenance runs while grant is held');
      expect(records(f).size).toBe(1);
    });
    expect((await peer.submit(peer.read(opened.viewId))).type).toBe('session_terminal_snapshot');
  } finally {
    Reflect.set(f.service, 'maintain', maintain);
  }
});

test('actual grant contention preserves one first-time read before its protected effect', async () => {
  const f = await fixture();
  const peer = await f.client();
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  await until(
    () => [...records(f).values()].every((r) => !(r as { slot: { busy: boolean } }).slot.busy),
    'actual Open receipt settled',
  );
  const read = peer.read(opened.viewId);
  const actual = f.service.handle;
  let received = false;
  f.service.handle = (id, ingress) => {
    const value = actual.call(f.service, id, ingress);
    if (ingress.kind === 'request' && ingress.request.id === read.id) received = true;
    return value;
  };
  try {
    await grantLock(f, async () => {
      peer.ws.send(encodeTerminalViewFrame(read));
      await until(() => received, 'actual read reaches held original grant');
      expect(records(f).size).toBe(1);
      expect(peer.frames.some((frame) => 'requestId' in frame && frame.requestId === read.id)).toBe(
        false,
      );
    });
    await until(
      () =>
        peer.frames.some(
          (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
        ),
      'first-time read enters only after actual lock release',
    );
    expect(
      peer.frames.filter((frame) => 'requestId' in frame && frame.requestId === read.id),
    ).toHaveLength(1);
  } finally {
    f.service.handle = actual;
  }
});

test('two actual reads under a held grant occupy only one unentered intent', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  assert(peer.packet);
  const opened = await peer.submit(peer.open());
  assert(opened.type === 'session_terminal_opened');
  await until(peer.packet.hasPendingPong, 'actual burst Open native receipt');
  peer.packet.confirmPong();
  const record = records(f).get(peer.connection() as object) as {
    intent: { request: { id: string } } | null;
    slot: TerminalSendSlot;
  };
  await until(() => !record.slot.busy, 'actual burst Open settled');
  const first = peer.read(opened.viewId);
  const second = peer.read(opened.viewId);
  await grantLock(f, async () => {
    assert(peer.packet);
    peer.packet.sendBatch([encodeTerminalViewFrame(first), encodeTerminalViewFrame(second)]);
    const ping = createPing();
    peer.ws.send(serialize(ping));
    await until(
      () =>
        peer.received.some((message) => message.type === 'pong' && message['pingId'] === ping.id),
      'both actual reads processed while the original grant stays held',
    );
    expect(record.intent?.request.id).toBe(first.id);
    expect(record.slot.busy).toBe(false);
    expect(peer.frames.some((frame) => frame.type === 'session_terminal_snapshot')).toBe(false);
  });
  await until(
    () => peer.frames.some((frame) => 'requestId' in frame && frame.requestId === first.id),
    'first actual read enters after grant release',
  );
  await until(peer.packet.hasPendingPong, 'first actual read owns its native receipt');
  expect(record.intent).toBeNull();
  expect(peer.frames.some((frame) => 'requestId' in frame && frame.requestId === second.id)).toBe(
    false,
  );
  peer.packet.confirmPong();
});

test('actual grant contention before a scheduled callback retains its unentered read once', async () => {
  const f = await fixture();
  const peer = await f.client();
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  const record = records(f).get(peer.connection() as object) as { slot: TerminalSendSlot };
  await until(() => !record.slot.busy, 'actual Open native receipt settled');
  const schedule = record.slot.schedule;
  let first = true;
  record.slot.schedule = (operation) =>
    schedule.call(record.slot, (deliver) => {
      if (first) {
        first = false;
        return withInterprocessFileLockNonblocking(
          Reflect.get(f.trust, 'authorizedKeysPath') as string,
          () => operation(deliver),
        );
      }
      return operation(deliver);
    });
  try {
    const read = peer.read(opened.viewId);
    const response = await peer.submit(read);
    expect(first).toBe(false);
    expect(response.type).toBe('session_terminal_snapshot');
    expect(
      peer.frames.filter((frame) => 'requestId' in frame && frame.requestId === read.id),
    ).toHaveLength(1);
  } finally {
    record.slot.schedule = schedule;
  }
});

test('an actual Close during grant contention cancels a held read before any later data', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  const packet = peer.packet;
  if (!packet) throw new Error('Expected actual native packet peer');
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  await until(packet.hasPendingPong, 'actual Open native receipt held');
  const read = peer.read(opened.viewId);
  peer.ws.send(encodeTerminalViewFrame(read));
  await until(
    () => [...records(f).values()].some((r) => !!Reflect.get(r as object, 'intent')),
    'actual first read held',
  );
  const close = peer.finish(opened.viewId);
  const actual = f.service.handle;
  let received = false;
  f.service.handle = (id, ingress) => {
    const result = actual.call(f.service, id, ingress);
    if (ingress.kind === 'request' && ingress.request.id === close.id) received = true;
    return result;
  };
  try {
    await grantLock(f, async () => {
      peer.ws.send(encodeTerminalViewFrame(close));
      await until(() => received, 'actual Close reaches held original grant');
    });
    packet.confirmPong();
    await until(() => records(f).size === 0, 'actual Close retires held read');
    expect(
      peer.frames.some(
        (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
      ),
    ).toBe(false);
  } finally {
    f.service.handle = actual;
  }
});

test('actual quota contention holds a read while its same capture remains current', async () => {
  const f = await fixture();
  const peer = await f.client();
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  const record = records(f).get(peer.connection() as object) as {
    slot: TerminalSendSlot;
    intent: unknown;
  };
  await until(() => !record.slot.busy, 'actual Open receipt settled');
  const read = peer.read(opened.viewId);
  await grantLock(
    f,
    async () => {
      peer.ws.send(encodeTerminalViewFrame(read));
      await until(
        () => records(f).size === 0 || record.intent !== null,
        'actual quota lookup meets held file lock',
      );
      expect(f.capture.contextFor(f.sessionId)?.available).toBe(true);
      expect(records(f).size).toBe(1);
      expect(peer.frames.some((frame) => 'requestId' in frame && frame.requestId === read.id)).toBe(
        false,
      );
    },
    join(f.files.home, 'terminal-view', 'reservations.json'),
  );
  await until(
    () =>
      peer.frames.some(
        (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
      ),
    'same original view sends after actual quota lock release',
  );
  expect(
    peer.frames.filter((frame) => 'requestId' in frame && frame.requestId === read.id),
  ).toHaveLength(1);
});

test('a real retryable lock failure after the guarded callback never replays its entered read', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  const packet = peer.packet;
  if (!packet) throw new Error('Expected actual packet peer');
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  await until(packet.hasPendingPong, 'actual Open ping');
  packet.confirmPong();
  const record = records(f).get(peer.connection() as object) as {
    slot: TerminalSendSlot;
    intent: unknown;
    state: string;
  };
  await until(() => !record.slot.busy, 'actual Open receipt settled');
  const originalGrant = f.trust.withAuthorizationEpochNonblocking;
  const grant = originalGrant.bind(f.trust);
  const schedule = record.slot.schedule;
  let insideFuture = false;
  f.trust.withAuthorizationEpochNonblocking = <T>(
    key: string,
    operation: (epoch: string | null) => T,
    migrate = false,
  ): T =>
    grant(
      key,
      (epoch) => {
        const result = operation(epoch);
        if (insideFuture)
          withInterprocessFileLockNonblocking(
            Reflect.get(f.trust, 'authorizedKeysPath') as string,
            () => {},
          );
        return result;
      },
      migrate,
    );
  record.slot.schedule = (operation) =>
    schedule.call(record.slot, (deliver) => {
      insideFuture = true;
      try {
        return operation(deliver);
      } finally {
        insideFuture = false;
      }
    });
  try {
    const read = peer.read(opened.viewId);
    expect((await peer.submit(read)).type).toBe('session_terminal_snapshot');
    expect(record.state).toBe('retired');
    expect(record.intent).toBeNull();
    await until(packet.hasPendingPong, 'actual entered snapshot ping');
    packet.confirmPong();
    await until(
      () => records(f).size === 0,
      'entered operation retires after actual native disposal',
    );
    expect(
      peer.frames.filter((frame) => 'requestId' in frame && frame.requestId === read.id),
    ).toHaveLength(1);
  } finally {
    f.trust.withAuthorizationEpochNonblocking = originalGrant;
    record.slot.schedule = schedule;
  }
});

test('an actual Close cancels a held first read before native export', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  const packet = peer.packet;
  if (!packet) throw new Error('Expected actual packet TLS peer');
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  await until(packet.hasPendingPong, 'actual Open receipt is held');
  const read = peer.read(opened.viewId);
  const close = peer.finish(opened.viewId);
  peer.ws.send(encodeTerminalViewFrame(read));
  peer.ws.send(encodeTerminalViewFrame(close));
  const ping = createPing();
  peer.ws.send(serialize(ping));
  await until(
    () => peer.received.some((message) => message.type === 'pong' && message['pingId'] === ping.id),
    'actual Close ingress precedes native progress',
  );
  packet.confirmPong();
  await until(
    () =>
      peer.frames.some(
        (frame) =>
          'requestId' in frame && (frame.requestId === read.id || frame.requestId === close.id),
      ),
    'actual held operation after native progress',
  );
  expect(
    peer.frames.some(
      (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
    ),
  ).toBe(false);
  expect(
    peer.frames.some(
      (frame) => frame.type === 'session_terminal_closed' && frame.requestId === close.id,
    ),
  ).toBe(true);
  await until(packet.hasPendingPong, 'actual Close reply receipt');
  packet.confirmPong();
});

test('an actual Close precedes a queued native read and prevents its snapshot', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  const packet = peer.packet;
  if (!packet) throw new Error('Expected actual packet TLS peer');
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  await until(packet.hasPendingPong, 'actual Open ping');
  packet.confirmPong();
  const record = records(f).get(peer.connection() as object) as { slot: { busy: boolean } };
  await until(() => !record.slot.busy, 'actual Open native ownership settled');
  const read = peer.read(opened.viewId);
  const close = peer.finish(opened.viewId);
  const actual = f.service.handle;
  let closeBeforeNativeEntry = false;
  // Observe two real frames in one TLS write; every ingress still reaches the real handler.
  f.service.handle = (id, ingress) => {
    if (ingress.kind === 'request' && ingress.request.id === close.id)
      closeBeforeNativeEntry = Reflect.get(record.slot, 'operationPending') === true;
    return actual.call(f.service, id, ingress);
  };
  try {
    packet.sendBatch([encodeTerminalViewFrame(read), encodeTerminalViewFrame(close)]);
    await until(() => {
      if (packet.hasPendingPong()) packet.confirmPong();
      return peer.frames.some(
        (frame) =>
          (frame.type === 'session_terminal_snapshot' && frame.requestId === read.id) ||
          (frame.type === 'session_terminal_closed' && frame.requestId === close.id),
      );
    }, 'actual result after Close precedes native entry');
    expect(closeBeforeNativeEntry).toBe(true);
    expect(
      peer.frames.some(
        (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
      ),
    ).toBe(false);
    expect(
      peer.frames.some(
        (frame) => frame.type === 'session_terminal_closed' && frame.requestId === close.id,
      ),
    ).toBe(true);
    await until(() => {
      if (packet.hasPendingPong()) packet.confirmPong();
      return !record.slot.busy;
    }, 'actual control-only native ownership settled');
  } finally {
    f.service.handle = actual;
  }
});

test('a pending model frame keeps another admitted view and its first read', async () => {
  const f = await fixture();
  const first = await f.client(false, true);
  const second = await f.client(false, true);
  if (!first.packet || !second.packet) throw new Error('Expected actual packet TLS peers');
  const openedFirst = await first.submit(first.open());
  if (openedFirst.type !== 'session_terminal_opened') throw new Error('Expected first view');
  await until(first.packet.hasPendingPong, 'first actual Open ping');
  first.packet.confirmPong();
  const firstRecord = records(f).get(first.connection() as object) as { slot: { busy: boolean } };
  await until(() => !firstRecord.slot.busy, 'first Open native ownership settled');
  const openedSecond = await second.submit(second.open());
  if (openedSecond.type !== 'session_terminal_opened') throw new Error('Expected second view');
  await until(second.packet.hasPendingPong, 'second actual Open ping');
  second.packet.confirmPong();
  const secondRecord = records(f).get(second.connection() as object) as { slot: { busy: boolean } };
  await until(() => !secondRecord.slot.busy, 'second Open native ownership settled');
  expect((await first.submit(first.read(openedFirst.viewId))).type).toBe(
    'session_terminal_snapshot',
  );
  await until(first.packet.hasPendingPong, 'first actual snapshot keeps the shared model borrowed');
  const read = second.read(openedSecond.viewId);
  second.ws.send(encodeTerminalViewFrame(read));
  const ping = createPing();
  second.ws.send(serialize(ping));
  await until(
    () =>
      second.received.some((message) => message.type === 'pong' && message['pingId'] === ping.id),
    'second actual read reached its owner',
  );
  await until(
    () => !Reflect.get(secondRecord.slot, 'operationPending'),
    'second first-time scheduling attempt returned',
  );
  expect(records(f).size).toBe(2);
  first.packet.confirmPong();
  await until(
    () =>
      second.frames.some(
        (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
      ),
    'second admitted view completes its first read after genuine shared disposal',
  );
  await until(second.packet.hasPendingPong, 'second actual snapshot ping');
  second.packet.confirmPong();
  expect(second.connection()?.isConnected).toBe(true);
});

test('one actual next read waits for the native TLS receipt without retaining a second frame', async () => {
  const f = await fixture();
  const peer = await f.client(false, true);
  const packet = peer.packet;
  if (!packet) throw new Error('Expected actual packet TLS peer');
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  await until(packet.hasPendingPong, 'actual ordered ping after opened');
  const record = records(f).get(peer.connection() as object) as {
    slot: { busy: boolean };
    intent: { request: { id: string } } | null;
  };
  expect(record.slot.busy).toBe(true);
  const first = peer.read(opened.viewId);
  const excess = peer.read(opened.viewId);
  peer.ws.send(encodeTerminalViewFrame(first));
  peer.ws.send(encodeTerminalViewFrame(excess));
  const ping = createPing();
  peer.ws.send(serialize(ping));
  await until(
    () => peer.received.some((message) => message.type === 'pong' && message['pingId'] === ping.id),
    'ordinary protocol processed after both actual next reads',
  );
  expect(record.intent?.request.id).toBe(first.id);
  expect(record.slot.busy).toBe(true);
  expect(peer.frames.some((frame) => 'requestId' in frame && frame.requestId === first.id)).toBe(
    false,
  );
  packet.confirmPong();
  await until(
    () =>
      peer.frames.some(
        (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === first.id,
      ),
    'first-time held read completes after the actual receipt',
  );
  expect(record.intent).toBeNull();
  expect(peer.frames.some((frame) => 'requestId' in frame && frame.requestId === excess.id)).toBe(
    false,
  );
  await until(packet.hasPendingPong, 'actual ordered ping after snapshot');
  packet.confirmPong();
  await until(() => !record.slot.busy, 'snapshot native ownership settled');
  expect(peer.connection()?.isConnected).toBe(true);
});

for (const change of ['grant', 'binding', 'runtime', 'attachment', 'retirement'] as const) {
  test(`a held first-time read rechecks original ${change} before any new native effect`, async () => {
    const f = await fixture();
    const peer = await f.client(false, true);
    const packet = peer.packet;
    if (!packet) throw new Error('Expected actual packet TLS peer');
    const opened = await peer.submit(peer.open());
    if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
    await until(packet.hasPendingPong, 'actual opened receipt held');
    const read = peer.read(opened.viewId);
    peer.ws.send(encodeTerminalViewFrame(read));
    await until(() => {
      const record = records(f).get(peer.connection() as object) as
        | { intent: { request: { id: string } } | null }
        | undefined;
      return record?.intent?.request.id === read.id;
    }, 'actual first read admitted as one bounded intent');
    if (change === 'grant')
      expect(f.trust.removeAuthorizedKey(peer.identity.fingerprint)).toBe(true);
    else if (change === 'binding') f.rotateBinding();
    else if (change === 'runtime') f.rotateRuntime();
    else if (change === 'attachment') {
      f.registry.detachConnection(peer.id);
      f.registry.attachConnection(f.sessionId, peer.id);
    } else f.service.forgetSession(f.sessionId);
    packet.confirmPong();
    await until(() => {
      // A refusal can have its own real native receipt; it carries no screen.
      if (packet.hasPendingPong()) packet.confirmPong();
      return records(f).size === 0 && views(f).length === 0;
    }, 'old record and physical ledger retire after genuine native completion');
    expect(
      peer.frames.some(
        (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
      ),
    ).toBe(false);
    expect(views(f)).toHaveLength(0);
  });
}

test('oversized original native binary ingress is rejected before any text decoding copy', async () => {
  const f = await fixture();
  const peer = await f.client();
  const raw = new Uint8Array(65537);
  raw.fill(32);
  raw.set(new TextEncoder().encode(encodeTerminalViewFrame(peer.open())));
  const decode = TextDecoder.prototype.decode;
  let oversizedDecodes = 0;
  // Observe actual native decoding without substituting data, return values or transport.
  TextDecoder.prototype.decode = function (this: TextDecoder, input, options) {
    if (ArrayBuffer.isView(input) && input.byteLength > 65536) oversizedDecodes++;
    return decode.call(this, input, options);
  };
  try {
    peer.ws.send(raw);
    const ping = createPing();
    peer.ws.send(serialize(ping));
    await until(
      () =>
        peer.received.some((message) => message.type === 'pong' && message['pingId'] === ping.id),
      'ordinary protocol after oversized native ingress',
    );
    await Bun.sleep(30);
    expect(oversizedDecodes).toBe(0);
    expect(peer.frames).toEqual([]);
    expect(peer.connection()?.isConnected).toBe(true);
  } finally {
    TextDecoder.prototype.decode = decode;
  }
});

test('the actual native send executes while the original grant lock is held', async () => {
  const f = await fixture();
  const peer = await f.client();
  const connection = peer.connection();
  if (!connection) throw new Error('Expected actual connection');
  const native = Reflect.get(connection, 'ws') as { send(text: string): unknown };
  const original = native.send;
  let terminalCalls = 0;
  native.send = (text: string) => {
    if (text.includes('session_terminal_')) {
      terminalCalls++;
      expect(() =>
        withInterprocessFileLockNonblocking(
          join(f.files.home, 'auth/authorized_keys.json'),
          () => {},
        ),
      ).toThrow(InterprocessFileLockError);
    }
    return original.call(native, text);
  };
  try {
    expect((await peer.submit(peer.open())).type).toBe('session_terminal_opened');
  } finally {
    native.send = original;
  }
  expect(terminalCalls).toBe(1);
});

test('shared device quota omits an uncharged terminal reply and keeps ordinary protocol alive', async () => {
  const f = await fixture();
  const first = await f.client();
  const second = await f.client();
  expect((await first.submit(first.open())).type).toBe('session_terminal_opened');
  expect((await second.submit(second.open())).type).toBe('session_terminal_opened');
  const third = await f.client();
  const request = third.open();
  third.ws.send(encodeTerminalViewFrame(request));
  const ping = createPing();
  third.ws.send(serialize(ping));
  await until(
    () =>
      third.received.some((message) => message.type === 'pong' && message['pingId'] === ping.id),
    'ordinary pong after optional refusal',
  );
  await Bun.sleep(30);
  expect(records(f).size).toBe(2);
  expect(views(f).length).toBe(2);
  expect(third.frames).toEqual([]);
  expect(third.connection()?.isConnected).toBe(true);
  expect(
    third.received.some(
      (message) =>
        message.type === 'ack' &&
        (message['ack'] as { messageId?: string } | undefined)?.messageId === request.id,
    ),
  ).toBe(false);
});

test('a different signed device cannot read another connection view', async () => {
  const f = await fixture();
  const owner = await f.client();
  const other = await f.client(true);
  const opened = await owner.submit(owner.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected view');
  expect(await other.submit(other.read(opened.viewId))).toMatchObject({
    type: 'session_terminal_refused',
    code: 'unavailable',
  });
  expect(other.frames.some((frame) => frame.type === 'session_terminal_snapshot')).toBe(false);
});

test('a repeated close receipt remains charged and does not extend its bounded lifetime', async () => {
  const f = await fixture();
  const peer = await f.client();
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected view');
  expect((await peer.submit(peer.finish(opened.viewId))).type).toBe('session_terminal_closed');
  expect(views(f).length).toBe(1);
  await Bun.sleep(550);
  expect((await peer.submit(peer.finish(opened.viewId))).type).toBe('session_terminal_closed');
  await until(
    () => records(f).size === 0 && views(f).length === 0,
    'closed receipt released',
    2000,
  );
});

test('revocation followed by regrant cannot revive an old view incarnation', async () => {
  const f = await fixture();
  const peer = await f.client();
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected view');
  expect(f.trust.removeAuthorizedKey(peer.identity.fingerprint)).toBe(true);
  await f.trust.addAuthorizedKey(peer.identity.publicKeyRaw, 'owned renewed grant');
  const read = peer.read(opened.viewId);
  peer.ws.send(encodeTerminalViewFrame(read));
  await Bun.sleep(70);
  expect(
    peer.frames.some(
      (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === read.id,
    ),
  ).toBe(false);
  expect(
    peer.received.some(
      (message) =>
        message.type === 'ack' &&
        (message['ack'] as { messageId?: string } | undefined)?.messageId === read.id,
    ),
  ).toBe(false);
});

test('actual native close reaches its observer after logical map removal', async () => {
  const f = await fixture();
  const peer = await f.client();
  const connection = peer.connection();
  if (!connection) throw new Error('Expected actual connection');
  let retired = 0;
  let closed = 0;
  let nativePongs = 0;
  const nonce = randomBytes(16);
  const unsubscribe = connection.observeNativeSocket({
    drain() {},
    pong(data) {
      expect(Buffer.from(data).equals(nonce)).toBe(true);
      nativePongs++;
    },
    retire() {
      retired++;
    },
    closed() {
      expect(f.adapter.getDirectConnection(peer.id)).toBeUndefined();
      closed++;
    },
  });
  expect(unsubscribe).not.toBeNull();
  expect(
    connection.observeNativeSocket({ drain() {}, pong() {}, retire() {}, closed() {} }),
  ).toBeNull();
  const ping = createPing();
  peer.ws.send(serialize(ping));
  await until(
    () => peer.received.some((message) => message.type === 'pong' && message['pingId'] === ping.id),
    'domain pong remains separate from the native receipt callback',
  );
  expect(nativePongs).toBe(0);
  const native = Reflect.get(connection, 'ws') as { ping(data: Uint8Array): unknown };
  native.ping(nonce);
  await until(() => nativePongs === 1, 'actual native pong reaches its admitted observer');
  connection.close('owned native lifecycle control');
  expect(f.adapter.getDirectConnection(peer.id)).toBeUndefined();
  await until(() => closed === 1, 'actual native callback after map removal');
  expect(retired).toBe(1);
  connection.nativeSocketClosed();
  expect(closed).toBe(1);
  expect(
    connection.observeNativeSocket({ drain() {}, pong() {}, retire() {}, closed() {} }),
  ).toBeNull();
});

for (const harness of ['claude', 'codex'] as const)
  test(`actual signed WSS ${harness} opens, reads, coalesces and closes its launch-captured PTY`, async () => {
    const f = await fixture({ harness });
    const peer = await f.client();
    const opened = await peer.submit(peer.open());
    expect(opened.type).toBe('session_terminal_opened');
    if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
    const snapshot = await peer.submit(peer.read(opened.viewId));
    expect(snapshot.type).toBe('session_terminal_snapshot');
    if (snapshot.type !== 'session_terminal_snapshot')
      throw new Error('Expected actual complete screen');
    expect(snapshot.lines[0]).toBe('FIRST');
    expect(snapshot.columns).toBe(40);
    expect(snapshot.rows).toBe(4);
    expect((await peer.submit(peer.read(opened.viewId))).type).toBe('session_terminal_refused');
    await Bun.sleep(510);
    expect(await peer.submit(peer.read(opened.viewId, snapshot.revision))).toMatchObject({
      type: 'session_terminal_unchanged',
      revision: snapshot.revision,
    });
    expect(await peer.submit(peer.finish(opened.viewId))).toMatchObject({
      type: 'session_terminal_closed',
      viewId: opened.viewId,
    });
    expect(await peer.submit(peer.finish(opened.viewId))).toMatchObject({
      type: 'session_terminal_closed',
      viewId: opened.viewId,
    });
    expect(peer.received.some((message) => message.type === 'ack')).toBe(false);
  });

test('foreign IDs and malformed original frames have bounded strict refusals without a generic ACK', async () => {
  const f = await fixture();
  const peer = await f.client();
  const opened = await peer.submit(peer.open());
  if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
  expect(await peer.submit(peer.read(randomBytes(16).toString('base64url')))).toMatchObject({
    type: 'session_terminal_refused',
    code: 'unavailable',
  });
  const bad = peer.read(opened.viewId);
  peer.ws.send(JSON.stringify({ ...bad, extra: 'not allowed' }));
  await until(
    () => peer.frames.some((frame) => 'requestId' in frame && frame.requestId === bad.id),
    'malformed refusal',
  );
  expect(
    peer.frames.find((frame) => 'requestId' in frame && frame.requestId === bad.id),
  ).toMatchObject({ type: 'session_terminal_refused', code: 'malformed' });
  const duplicate = peer.open();
  peer.ws.send(
    encodeTerminalViewFrame(duplicate).replace('"type":', `"id":"${randomUUID()}","type":`),
  );
  await Bun.sleep(60);
  expect(
    peer.frames.some((frame) => 'requestId' in frame && frame.requestId === duplicate.id),
  ).toBe(false);
  expect(peer.connection()?.isConnected).toBe(true);
  expect(peer.received.some((message) => message.type === 'ack' || message.type === 'error')).toBe(
    false,
  );
});

test('plain signed WS never enters a terminal send and remains available for ordinary protocol', async () => {
  const f = await fixture({ tls: false });
  const peer = await f.client();
  peer.ws.send(encodeTerminalViewFrame(peer.open()));
  await Bun.sleep(60);
  expect(peer.frames).toEqual([]);
  expect(peer.connection()?.isConnected).toBe(true);
});

for (const change of ['runtime', 'attachment', 'binding'] as const)
  test(`original ${change} change cannot produce another terminal snapshot`, async () => {
    const f = await fixture();
    const peer = await f.client();
    const opened = await peer.submit(peer.open());
    if (opened.type !== 'session_terminal_opened') throw new Error('Expected owned view');
    if (change === 'runtime') f.rotateRuntime();
    else if (change === 'binding') f.rotateBinding();
    else {
      f.registry.detachConnection(peer.id);
      f.registry.attachConnection(f.sessionId, peer.id);
    }
    const request = peer.read(opened.viewId);
    peer.ws.send(encodeTerminalViewFrame(request));
    await Bun.sleep(70);
    expect(
      peer.frames.some(
        (frame) => frame.type === 'session_terminal_snapshot' && frame.requestId === request.id,
      ),
    ).toBe(false);
    expect(peer.connection()?.isConnected).toBe(true);
  });
