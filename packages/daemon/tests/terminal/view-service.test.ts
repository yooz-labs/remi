import { afterEach, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createPing, encodeTerminalViewFrame, serialize } from '@remi/shared';
import {
  InterprocessFileLockError,
  withInterprocessFileLockNonblocking,
} from '../../src/storage/interprocess-file-lock.ts';
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
