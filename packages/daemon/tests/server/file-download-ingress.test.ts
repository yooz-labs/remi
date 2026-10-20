/** Actual signed TLS/raw server/service endpoints; no direct handle call proves these routes. */
import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  type FileDownloadMessage,
  type FileFetchAccepted,
  type ProtocolMessage,
  createHello,
  decodeFileDownloadFrame,
  deserialize,
  encodeFileDownloadFrame,
} from '@remi/shared';
import { resumed } from '../../../../tests/integration/relay-r3-fixture.ts';
import { loadOrCreateCapabilityToken } from '../../src/auth/capability-token';
import { SessionRegistryFile } from '../../src/session/session-registry-file';
import {
  type FileDownloadIngressResources,
  makeFileDownloadIngressFixture,
  relayFileDownloadFixture,
  until,
} from '../helpers/file-download-ingress-fixture.ts';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0)) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned raw download cleanup failed');
});

async function fixture(options: Parameters<typeof makeFileDownloadIngressFixture>[0] = {}) {
  const f = await makeFileDownloadIngressFixture(options);
  cleanups.push(f.close);
  return f;
}

test('raw fixture occupied-port startup failure drains actual service/listener/consumer/files', async () => {
  const blocker = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('owned occupied raw port'),
  });
  let observed: FileDownloadIngressResources | undefined;
  try {
    await expect(
      makeFileDownloadIngressFixture({
        port: blocker.port as number,
        observe(owned) {
          observed = owned;
        },
      }),
    ).rejects.toHaveProperty('code', 'EADDRINUSE');
    if (!observed) throw new Error('Owned raw fixture did not reach actual adapter');
    const owned: FileDownloadIngressResources = observed;
    expect(owned.pty.sessionState).toBe('exited');
    await owned.consumerExit;
    expect(() => process.kill(owned.pty.childPid as number, 0)).toThrow();
    expect(fs.existsSync(owned.files.directory)).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${blocker.port}/health`)).text()).toBe(
      'owned occupied raw port',
    );
  } finally {
    // Diagnostic assertion failures never qualify cleanup; still drain their owned resources.
    if (observed) {
      const owned: FileDownloadIngressResources = observed;
      try {
        await owned.service.close();
      } finally {
        try {
          await owned.adapter.stop();
        } finally {
          await owned.pty.close();
          await owned.consumerExit;
          owned.files.cleanup();
        }
      }
    }
    blocker.stop(true);
  }
}, 15000);

test('raw fixture retains charged home on real settlement fault while draining socket and consumer, then safe retry settles', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('owned charged raw fixture');
  accepted(await peer.send(peer.begin()));
  const file = join(f.files.home, 'image-staging', 'ledger', 'reservations.json');
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, '{ owned ledger fault');
    await expect(f.close()).rejects.toThrow('Owned raw download fixture cleanup failed');
    expect(peer.ws.readyState).toBe(WebSocket.CLOSED);
    expect(f.pty.sessionState).toBe('exited');
    await f.consumerExit;
    expect(fs.existsSync(f.files.home)).toBe(true);
  } finally {
    fs.writeFileSync(file, original);
  }
  expect(
    f
      .ledger()
      .inspect()
      .some((row) => row.charge > 0),
  ).toBe(true);
  expect(await f.service.close()).toBe(true);
  expect(
    f
      .ledger()
      .inspect()
      .every((row) => row.charge === 0),
  ).toBe(true);
  await f.close();
  expect(fs.existsSync(f.files.directory)).toBe(false);
});

function accepted(frame: FileDownloadMessage): FileFetchAccepted {
  if (frame.type !== 'file_fetch_accepted') throw new Error('Expected actual raw acceptance');
  return frame;
}

for (const harness of ['claude', 'codex'] as const)
  test(`actual signed TLS ${harness} text/binary route transfers exact private bytes without ACK or PTY effects`, async () => {
    const f = await fixture({ harness });
    const peer = await f.client();
    for (const size of [1, 32768, 32769, 10485760]) {
      const source = Buffer.alloc(size, 0x67);
      f.write(source);
      const begin = peer.begin();
      const raw = JSON.stringify(begin)
        .replace('"type"', '"t\\u0079pe"')
        .replace('file_fetch_', 'file\\u005ffetch_');
      // The large native preparation has its own budget; all reads/ordinary responses keep3s.
      const value = accepted(
        await peer.send(begin, new TextEncoder().encode(raw), size === 10485760 ? 10000 : 3000),
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (let seq = 0; bytes < size; seq++) {
        const request = {
          ...peer.envelope(),
          type: 'file_fetch_read' as const,
          transferId: value.transferId,
          seq,
          receivedBytes: bytes,
        };
        const response = await peer.send(
          request,
          seq % 2
            ? new TextEncoder().encode(encodeFileDownloadFrame(request))
            : encodeFileDownloadFrame(request),
        );
        expect(response.type).toBe('file_fetch_chunk');
        if (response.type !== 'file_fetch_chunk')
          throw new Error('Expected actual raw private chunk');
        expect(response.seq).toBe(seq);
        const data = Buffer.from(response.data, 'base64url');
        chunks.push(data);
        bytes += data.length;
      }
      expect(Buffer.concat(chunks)).toEqual(source);
      const digest = createHash('sha256').update(source).digest('base64url');
      expect(value.digest).toBe(digest);
      expect(
        await peer.send({
          ...peer.envelope(),
          type: 'file_fetch_complete',
          transferId: value.transferId,
          receivedBytes: size,
          digest,
        }),
      ).toMatchObject({ type: 'file_fetch_result', outcome: 'complete' });
    }
    expect(
      f
        .ledger()
        .inspect()
        .every((row) => row.state === 'settled' && row.charge === 0),
    ).toBe(true);
    expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
    expect(Buffer.concat(f.output)).toEqual(Buffer.alloc(0));
  }, 30000);

test('raw malformed correlation uses only current owning begin/transfer, with no initial allocation or ACK', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('owned raw bytes');
  const initial = peer.begin();
  expect(await peer.send(initial, JSON.stringify({ ...initial, extra: true }))).toMatchObject({
    code: 'unavailable',
  });
  expect(f.ledger().inspect()).toEqual([]);
  const begin = peer.begin();
  const value = accepted(await peer.send(begin));
  const badRead = {
    ...peer.envelope(),
    type: 'file_fetch_read',
    transferId: value.transferId,
    seq: 320,
    receivedBytes: 0,
  };
  expect(await peer.send(badRead)).toMatchObject({
    type: 'file_fetch_refused',
    operation: 'file_fetch_read',
    code: 'malformed',
  });
  const badCancel = {
    ...peer.envelope(),
    type: 'file_fetch_cancel',
    beginId: begin.id,
    extra: true,
  };
  expect(await peer.send(badCancel)).toMatchObject({
    code: 'malformed',
    operation: 'file_fetch_cancel',
  });
  expect(await peer.send({ ...badRead, id: randomUUID(), transferId: 'invalid' })).toMatchObject({
    code: 'unavailable',
  });
  const foreign = await f.client();
  expect(await foreign.send({ ...badRead, id: randomUUID() })).toMatchObject({
    code: 'unavailable',
  });
  expect(
    await peer.send({ ...peer.envelope(), type: 'file_fetch_cancel', beginId: begin.id }),
  ).toMatchObject({ outcome: 'cancelled' });
  expect(await peer.send({ ...badRead, id: randomUUID() })).toMatchObject({ code: 'unavailable' });
  expect(
    f
      .ledger()
      .inspect()
      .every((r) => r.charge === 0),
  ).toBe(true);
  expect(peer.frames.some((m) => m.type === 'file_fetch_chunk')).toBe(false);
  expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
  expect(Buffer.concat(f.output)).toEqual(Buffer.alloc(0));
});

test('raw duplicates reach service sequence rules; pre-acceptance cancel names beginId and suppresses bytes', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write(Buffer.alloc(10485760));
  const pending = peer.begin();
  peer.ws.send(encodeFileDownloadFrame(pending));
  const cancel = { ...peer.envelope(), type: 'file_fetch_cancel' as const, beginId: pending.id };
  expect(
    await peer.send(cancel, new TextEncoder().encode(encodeFileDownloadFrame(cancel))),
  ).toMatchObject({ outcome: 'cancelled' });
  expect(peer.frames.some((m) => m.type === 'file_fetch_accepted')).toBe(false);
  f.write('two reads');
  const begin = peer.begin();
  const value = accepted(await peer.send(begin));
  const read = {
    ...peer.envelope(),
    type: 'file_fetch_read' as const,
    transferId: value.transferId,
    seq: 0,
    receivedBytes: 0,
  };
  expect(await peer.send(read)).toMatchObject({ type: 'file_fetch_chunk' });
  peer.ws.send(encodeFileDownloadFrame(read));
  await until(
    () => peer.frames.some((m) => m.type === 'file_fetch_refused' && m.requestId === read.id),
    'duplicate reaches service',
  );
  expect(peer.frames.filter((m) => m.type === 'file_fetch_chunk')).toHaveLength(1);
  expect(
    peer.frames.find((m) => m.type === 'file_fetch_refused' && m.requestId === read.id),
  ).toMatchObject({ code: 'sequence' });
  expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
  expect(Buffer.concat(f.output)).toEqual(Buffer.alloc(0));
}, 15000);

test('recognized duplicate/ambiguous/host/scalar/oversize frames close before callbacks or generic ACK', async () => {
  const f = await fixture();
  for (const variant of [
    'duplicate-first',
    'duplicate-last',
    'scalar',
    'oversize',
    'deep',
    'host',
  ] as const) {
    const peer = await f.client();
    const begin = peer.begin();
    const raw = encodeFileDownloadFrame(begin);
    const before = f.invocations.length;
    let frame: string | Uint8Array = raw;
    if (variant === 'duplicate-first') frame = `{"type":"hello",${raw.slice(1)}`;
    if (variant === 'duplicate-last') frame = `${raw.slice(0, -1)},"t\\u0079pe":"hello"}`;
    if (variant === 'scalar') frame = raw.replace(begin.id, '\\ud800');
    if (variant === 'oversize')
      frame = new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(65536), ...begin }));
    if (variant === 'deep')
      frame = JSON.stringify({
        ...begin,
        nested: JSON.parse(`${'['.repeat(70)}0${']'.repeat(70)}`),
      });
    if (variant === 'host')
      frame = encodeFileDownloadFrame({
        type: 'file_fetch_result',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: f.sessionId,
        requestId: begin.id,
        transferId: Buffer.alloc(16).toString('base64url'),
        outcome: 'complete',
      });
    peer.ws.send(frame);
    await until(
      () =>
        peer.ws.readyState === WebSocket.CLOSED ||
        peer.received.some((m) => m.code === 'INVALID_MESSAGE'),
      `strict raw ${variant}`,
    );
    expect(
      peer.ws.readyState,
      `strict original ${variant} closes instead of generic fallback`,
    ).toBe(WebSocket.CLOSED);
    expect(f.invocations.length).toBe(before);
    expect(peer.frames).toEqual([]);
    expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
  }
  expect(f.ledger().inspect()).toEqual([]);
  expect(Buffer.concat(f.output)).toEqual(Buffer.alloc(0));
}, 15000);

test('no-handler text/binary retains INVALID_MESSAGE before ACK/dedupe and current grant closes first', async () => {
  const f = await fixture({ installed: false });
  const peer = await f.client();
  const begin = peer.begin();
  for (const frame of [JSON.stringify(begin), new TextEncoder().encode(JSON.stringify(begin))]) {
    const before = peer.received.filter((m) => m.type === 'error').length;
    peer.ws.send(frame);
    await until(
      () =>
        peer.ws.readyState === WebSocket.CLOSED ||
        peer.received.filter((m) => m.type === 'error').length > before,
      'no-handler invalid',
    );
    expect(peer.ws.readyState, 'no-handler stays open with INVALID_MESSAGE').toBe(WebSocket.OPEN);
    expect(peer.received.filter((m) => m.type === 'error').at(-1)?.code).toBe('INVALID_MESSAGE');
  }
  expect(
    peer.received.filter((m) => m.type === 'error').every((m) => m.code === 'INVALID_MESSAGE'),
  ).toBe(true);
  f.trust.removeAuthorizedKey(f.identity.fingerprint);
  peer.ws.send(JSON.stringify(begin));
  await until(
    () =>
      peer.ws.readyState === WebSocket.CLOSED ||
      peer.received.filter((m) => m.code === 'INVALID_MESSAGE').length > 2,
    'grant before no-handler error',
  );
  expect(peer.ws.readyState, 'current grant closes before no-handler response').toBe(
    WebSocket.CLOSED,
  );
  expect(peer.received.some((m) => m.type === 'error' && m.code === 'CLOSING')).toBe(true);
  expect(f.invocations).toEqual([]);
  expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
});

test('actual plain/private capability and unsigned paths cannot admit or receive download content', async () => {
  for (const route of ['plain', 'private', 'public-capability'] as const) {
    const f = await fixture({ tls: route !== 'plain' });
    const peer = await f.client(
      route === 'plain' ? {} : { private: route === 'private', capability: true },
    );
    peer.ws.send(JSON.stringify(peer.begin()));
    await until(() => f.invocations.length === 1, 'actual refused transport callback');
    await Bun.sleep(20);
    expect(peer.frames).toEqual([]);
    expect(f.ledger().inspect()).toEqual([]);
    expect(Buffer.concat(f.output)).toEqual(Buffer.alloc(0));
  }
  const f = await fixture();
  const peer = await f.client({ unsigned: true });
  peer.ws.send(JSON.stringify(peer.begin()));
  await until(() => peer.ws.readyState === WebSocket.CLOSED, 'unsigned strict frame');
  expect(f.invocations).toEqual([]);
  expect(f.ledger().inspect()).toEqual([]);
});

test('raw original grant epoch, attachment and runtime loss cannot send a specific malformed owner result', async () => {
  for (const boundary of ['grant', 'attachment', 'runtime'] as const) {
    const f = await fixture();
    const peer = await f.client();
    f.write('bounded owner');
    const begin = peer.begin();
    const value = accepted(await peer.send(begin));
    if (boundary === 'grant') {
      f.trust.removeAuthorizedKey(f.identity.fingerprint);
      await f.trust.addAuthorizedKey(f.identity.publicKeyRaw, 'owned regrant');
    } else if (boundary === 'attachment') {
      if (!peer.id) throw new Error('Owned connection missing');
      f.registry.detachConnection(peer.id);
      f.registry.attachConnection(f.sessionId, peer.id);
    } else f.replaceContext();
    const bad = {
      ...peer.envelope(),
      type: 'file_fetch_read',
      transferId: value.transferId,
      seq: 320,
      receivedBytes: 0,
    };
    expect(await peer.send(bad)).toMatchObject({ code: 'unavailable' });
    expect(peer.frames.some((m) => m.type === 'file_fetch_chunk')).toBe(false);
    await f.service.maintain();
    expect(
      f
        .ledger()
        .inspect()
        .every((r) => r.charge === 0),
    ).toBe(true);
  }
}, 15000);

test('actual enrolled relay correlates all four terminal refusals for unknown and unverified children without ACK or effects', async () => {
  for (const childState of ['unknown', 'unverified'] as const) {
    for (const type of [
      'file_fetch_begin',
      'file_fetch_read',
      'file_fetch_complete',
      'file_fetch_cancel',
    ] as const) {
      const f = await fixture({ tls: false });
      let invoked = 0;
      const remote = await resumed({
        onFileDownload() {
          invoked++;
        },
      });
      try {
        if (childState === 'unverified') {
          // A real source child receives a different owned capability and must challenge/refuse
          // this proxy. Its actual file handler must never receive the original request.
          loadOrCreateCapabilityToken(join(remote.dir, 'capability.key'));
          new SessionRegistryFile(join(remote.dir, 'live')).register({
            sessionId: f.sessionId,
            pid: process.pid,
            wsPort: f.port,
            hookPort: 1,
            projectPath: f.files.work,
            name: 'owned-unverified',
            startedAt: new Date().toISOString(),
          });
        }
        const envelope = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          sessionId: f.sessionId,
        };
        const request =
          type === 'file_fetch_begin'
            ? { ...envelope, type, binding: f.binding, relativePath: 'sample.bin' }
            : type === 'file_fetch_cancel'
              ? { ...envelope, type, beginId: randomUUID() }
              : type === 'file_fetch_read'
                ? {
                    ...envelope,
                    type,
                    transferId: Buffer.alloc(16).toString('base64url'),
                    seq: 0,
                    receivedBytes: 0,
                  }
                : {
                    ...envelope,
                    type,
                    transferId: Buffer.alloc(16).toString('base64url'),
                    receivedBytes: 1,
                    digest: Buffer.alloc(32).toString('base64url'),
                  };
        await remote.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(request)));
        const received: ProtocolMessage[] = [];
        let terminal: FileDownloadMessage | null = null;
        for (let i = 0; i < 8 && !terminal; i++) {
          const bytes = await remote.channel.receive(await remote.socket.binary());
          if (!bytes) throw Error('Owned relay closed before correlated terminal');
          const message = deserialize(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
          );
          if (!message) throw Error('Owned relay response absent');
          received.push(message);
          terminal = decodeFileDownloadFrame(bytes);
          if (!terminal) {
            // ChildProxy may separately announce the unverified socket's close.
            expect(message.type === 'error' && message.code).toBe('SESSION_NOT_FOUND');
            expect(message.type === 'error' && message.details?.['sessionId']).toBe(f.sessionId);
          }
        }
        expect(terminal).toMatchObject({
          type: 'file_fetch_refused',
          requestId: envelope.id,
          operation: type,
          sessionId: f.sessionId,
          code: 'unavailable',
        });
        const late = await remote.socket.next(80).catch(() => undefined);
        if (late) {
          const bytes = await remote.channel.receive(late);
          const message = bytes
            ? deserialize(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
            : null;
          if (!message) throw Error('Owned late child close notice absent');
          received.push(message);
          expect(message.type === 'error' && message.code).toBe('SESSION_NOT_FOUND');
          expect(message.type === 'error' && message.details?.['sessionId']).toBe(f.sessionId);
        }
        expect(received.some((message) => message.type === 'ack')).toBe(false);
        expect(remote.socket.isClosed).toBe(false);
        expect(invoked).toBe(0);
        expect(f.invocations).toEqual([]);
        expect(f.ledger().inspect()).toEqual([]);
      } finally {
        await remote.cleanup();
      }
    }
  }
}, 30000);

test('actual consumed file child loss ends the relay instead of claiming a pre-send refusal', async () => {
  const f = await relayFileDownloadFixture();
  try {
    const peer = await f.connect();
    await peer.send(createHello('owned-file-loss', 'T4', { resumeSessionId: f.sessionId }));
    expect((await peer.next()).type).toBe('hello_ack');
    f.write('owned consumed file bytes');
    const begin = {
      type: 'file_fetch_begin' as const,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      binding: f.binding,
      relativePath: 'sample.bin',
    };
    await peer.channel.send(new TextEncoder().encode(encodeFileDownloadFrame(begin)));
    const value = await peer.next();
    expect(value.type).toBe('file_fetch_accepted');
    expect('requestId' in value && value.requestId).toBe(begin.id);
    const owners = [
      ...(
        Reflect.get(f.relay, 'peers') as Map<
          string,
          { proxy: { children: Map<string, { stateOwner: boolean }> } }
        >
      ).values(),
    ].flatMap((owner) => [...owner.proxy.children.values()].map((child) => child.stateOwner));
    expect(owners).toEqual([true]);
    await f.adapter.stop(); // Real already-consumed child socket; never move to a replacement.
    await until(() => peer.socket.isClosed, 'consumed file owner channel retired');
    const close = await peer.socket.closed;
    const tailTypes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const frame = await peer.socket.next(80).catch(() => undefined);
      if (!frame) break;
      const bytes = await peer.channel.receive(frame);
      if (!bytes) {
        tailTypes.push('authenticated-bye');
        break;
      }
      const message = deserialize(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      );
      if (!message) throw Error('Owned closing frame invalid');
      tailTypes.push(message.type);
      expect(message.type).not.toBe('file_fetch_refused');
    }
    expect(tailTypes.length).toBeLessThan(8);
    console.info('Owned consumed file-loss transport', JSON.stringify({ close, tailTypes }));
    expect(f.relay.connectionCount).toBe(0);
    await f.service.maintain();
    expect(
      f
        .ledger()
        .inspect()
        .every((row) => row.state === 'settled' && row.charge === 0),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

test('unrecognized BOM and invalid-leading UTF8 preserve generic INVALID_MESSAGE without a download effect', async () => {
  const f = await fixture();
  const peer = await f.client();
  const raw = JSON.stringify(peer.begin());
  for (const frame of [
    `\ufeff${raw}`,
    new TextEncoder().encode(`\ufeff${raw}`),
    new Uint8Array([255, 254]),
  ]) {
    const before = peer.received.filter((m) => m.type === 'error').length;
    peer.ws.send(frame);
    await until(
      () =>
        peer.ws.readyState === WebSocket.CLOSED ||
        peer.received.filter((m) => m.type === 'error').length > before,
      'unrecognized generic rejection',
    );
  }
  expect(peer.ws.readyState).toBe(WebSocket.OPEN);
  expect(f.invocations).toEqual([]);
  expect(peer.frames).toEqual([]);
  expect(f.ledger().inspect()).toEqual([]);
});

test('closed service leaves correlated malformed input unsent without generic fallback', async () => {
  const f = await fixture();
  const peer = await f.client();
  expect(await f.service.close()).toBe(true);
  peer.ws.send(JSON.stringify({ ...peer.begin(), extra: true }));
  await until(() => f.invocations.length === 1, 'closed malformed callback');
  await Bun.sleep(20);
  expect(peer.frames).toEqual([]);
  expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
  expect(f.ledger().inspect()).toEqual([]);
});

test('installed sync/async callback failures close with fixed content-free text and no fallback ACK', async () => {
  for (const callbackFailure of [true, 'async'] as const) {
    const f = await fixture({ callbackFailure });
    const peer = await f.client();
    peer.ws.send(JSON.stringify(peer.begin()));
    await until(
      () =>
        peer.ws.readyState === WebSocket.CLOSED ||
        peer.received.some((m) => m.code === 'INVALID_MESSAGE'),
      'callback failure closed',
    );
    expect(peer.ws.readyState, 'callback failure closes without generic fallback').toBe(
      WebSocket.CLOSED,
    );
    expect(peer.frames).toEqual([]);
    expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
    expect(JSON.stringify(peer.received)).not.toContain('Owned callback failure');
    expect(f.ledger().inspect()).toEqual([]);
  }
});

test('original invalid UTF8 binary differs from correlatable replacement text before callbacks', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('ordinary source');
  const begin = peer.begin();
  accepted(await peer.send(begin));
  const cancel = { ...peer.envelope(), type: 'file_fetch_cancel' as const, beginId: begin.id };
  expect(await peer.send(cancel)).toMatchObject({ type: 'file_fetch_cancel_result' });
  const marker = 'ORIGINAL_BYTE_MARKER';
  const binaryRequest = { ...peer.begin(), probe: marker };
  const encoded = Buffer.from(JSON.stringify(binaryRequest));
  const at = encoded.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  const binary = Buffer.concat([
    encoded.subarray(0, at),
    Buffer.from([255]),
    encoded.subarray(at + marker.length),
  ]);
  expect(() => new TextDecoder('utf-8', { fatal: true }).decode(binary)).toThrow();
  const replacement = JSON.parse(new TextDecoder().decode(binary));
  replacement.id = randomUUID();
  const ledgerBefore = JSON.stringify(f.ledger().inspect());
  const ptyBefore = Buffer.concat(f.output);
  peer.ws.send(JSON.stringify(replacement));
  await until(
    () =>
      peer.frames.some(
        (m) =>
          m.type === 'file_fetch_refused' && 'requestId' in m && m.requestId === replacement.id,
      ),
    'actual replacement text refusal',
  );
  expect(peer.ws.readyState).toBe(WebSocket.OPEN);
  expect(peer.frames.find((m) => 'requestId' in m && m.requestId === replacement.id)).toMatchObject(
    {
      type: 'file_fetch_refused',
      // No owned operation remains after cancellation: the short initial refusal is unavailable.
      code: 'unavailable',
    },
  );
  const before = f.invocations.length;
  peer.ws.send(binary);
  await until(
    () =>
      peer.ws.readyState === WebSocket.CLOSED ||
      peer.frames.some((m) => 'requestId' in m && m.requestId === binaryRequest.id),
    'actual invalid original binary closes',
  );
  expect(peer.ws.readyState).toBe(WebSocket.CLOSED);
  expect(f.invocations.length).toBe(before);
  expect(peer.frames.some((m) => 'requestId' in m && m.requestId === binaryRequest.id)).toBe(false);
  expect(peer.received.some((m) => m.type === 'ack')).toBe(false);
  expect(JSON.stringify(f.ledger().inspect())).toBe(ledgerBefore);
  expect(Buffer.concat(f.output)).toEqual(ptyBefore);
}, 15000);
