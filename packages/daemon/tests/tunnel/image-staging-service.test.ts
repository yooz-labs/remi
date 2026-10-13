import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type AuthChallengeMessage,
  type UUID,
  createAuthResponse,
  createHello,
  createIdentity,
  createPong,
  deserialize,
  fromBase64,
  generateId,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { encodeImageStagingFrame } from '../../../shared/src/image-staging';
import type { ImageUploadBegin, ImageUploadChunk } from '../../../shared/src/image-staging';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter';
import { MessageAPI } from '../../src/api/message-api';
import { Authenticator } from '../../src/auth/authenticator';
import { IdentityStore } from '../../src/auth/identity-store';
import { PTYSession } from '../../src/pty/pty-session';
import { SessionBindingStore } from '../../src/session/session-binding-store';
import { SessionRegistry } from '../../src/session/session-registry';
import { SessionStore } from '../../src/session/session-store';
import {
  type ImageStagingRequest,
  type ImageStagingResponse,
  ImageStagingService,
} from '../../src/tunnel/image-staging-service';
import { Reservations } from '../../src/tunnel/reservations';
import { findTestPort, pollUntil } from '../integration/hub-test-utils';

const fixtures = resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'remi-staging-service-'));
  const store = new IdentityStore(join(home, 'auth'));
  const registry = new SessionRegistry();
  const binding = new SessionBindingStore(new SessionStore(join(home, 'sessions.json')));
  const sessionId = generateId();
  const harnessSessionId = generateId();
  const pty = new PTYSession({ command: '/bin/cat', cwd: home });
  const sockets: WebSocket[] = [];
  const resources: { adapter?: WebSocketAdapter; service?: ImageStagingService } = {};
  cleanup.push(async () => {
    const settled = resources.service ? await resources.service.close() : true;
    for (const socket of sockets) socket.close();
    await resources.adapter?.stop();
    await pty.close();
    if (settled) rmSync(home, { recursive: true, force: true });
    expect(settled).toBe(true);
  });
  await pty.start();
  registry.registerSession(sessionId, home, pty, new MessageAPI({ sessionId }), true);
  binding.preAssign({
    remiSessionId: sessionId,
    claudeSessionId: harnessSessionId,
    projectPath: home,
    port: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });
  await store.generate();
  const authenticator = new Authenticator({ identity: await store.unlock(), identityStore: store });
  const port = await findTestPort();
  let connected = Promise.withResolvers<UUID>();
  const adapter = new WebSocketAdapter(
    { host: '127.0.0.1', port, authenticator },
    {
      onConnect(id) {
        expect(registry.attachConnection(sessionId, id).success).toBe(true);
        connected.resolve(id);
      },
      onDisconnect(id) {
        registry.detachConnection(id);
        void resources.service?.invalidateConnection(id);
      },
      async onImageUpload(id, ingress) {
        const current = resources.service;
        if (!current) throw new Error('Service not initialized');
        const deliver = (message: ImageStagingResponse) => {
          adapter.sendRaw(id, message);
        };
        if (ingress.kind === 'request') await current.handle(id, ingress.request, deliver);
        else current.refuseMalformed(id, ingress.correlation, deliver);
      },
    },
  );
  resources.adapter = adapter;
  await adapter.start();
  const directAdapter = () => adapter;
  const service = await ImageStagingService.open({
    home,
    identityStore: store,
    sessionRegistry: registry,
    bindingStore: binding,
    directAdapter,
  });
  resources.service = service;
  async function client() {
    connected = Promise.withResolvers<UUID>();
    const identity = await createIdentity();
    const unlocked = await unlockIdentity(identity);
    await store.addAuthorizedKey(identity.publicKey, 'test client');
    const received: import('@remi/shared').ProtocolMessage[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    socket.onmessage = async (event) => {
      try {
        const message = deserialize(String(event.data));
        if (message) received.push(message);
        if (message?.type === 'auth_challenge') {
          const challenge = message as AuthChallengeMessage;
          const signature = await sign(unlocked.privateKey, fromBase64(challenge.challenge));
          // Upload identity comes from the verified signature and canonical public key.
          socket.send(
            serialize(createAuthResponse(identity.publicKey, signature, identity.fingerprint)),
          );
        } else if (message?.type === 'auth_result') {
          if (!message.success) throw new Error('Actual client authentication refused');
          socket.send(serialize(createHello(generateId(), 'test')));
        } else if (message?.type === 'ping') {
          socket.send(serialize(createPong(message.id)));
        }
      } catch (error) {
        connected.reject(error);
      }
    };
    socket.onerror = () => connected.reject(new Error('Actual client socket failed'));
    const id = await connected.promise;
    expect(adapter?.getDirectConnection(id)?.connectionClientPublicKey).toBe(identity.publicKey);
    expect(adapter?.getDirectConnection(id)?.connectionClientFingerprint).toBe(
      identity.fingerprint,
    );
    return { id, socket, identity, received };
  }
  const owner = await client();
  const ledger = () => new Reservations(join(home, 'image-staging', 'ledger')).inspect();
  const begin = (file = 'fixture.png'): { request: ImageUploadBegin; bytes: Buffer } => {
    const bytes = readFileSync(join(fixtures, file));
    return {
      bytes,
      request: {
        type: 'image_upload_begin',
        id: generateId(),
        timestamp: new Date().toISOString(),
        sessionId,
        binding: { harness: 'claude', harnessSessionId },
        mediaType: file.endsWith('.png') ? 'image/png' : 'image/jpeg',
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('base64url'),
      },
    };
  };
  return {
    home,
    store,
    registry,
    binding,
    sessionId,
    harnessSessionId,
    pty,
    adapter,
    directAdapter,
    service,
    client,
    owner,
    ledger,
    begin,
  };
}

async function invoke(service: ImageStagingService, id: UUID, request: ImageStagingRequest) {
  let response: ImageStagingResponse | undefined;
  await service.handle(id, request, (value) => {
    response = value;
  });
  if (!response) throw new Error('Missing actual staging outcome');
  expect(response.requestId).toBe(request.id);
  expect(response.sessionId).toBe(request.sessionId);
  return response;
}

async function start(f: Awaited<ReturnType<typeof fixture>>, file = 'fixture.png') {
  const { request, bytes } = f.begin(file);
  const accepted = await invoke(f.service, f.owner.id, request);
  if (accepted.type !== 'image_upload_accepted') throw new Error('Actual begin not accepted');
  return { request, bytes, accepted };
}

async function chunks(f: Awaited<ReturnType<typeof fixture>>, transferId: string, bytes: Buffer) {
  for (let at = 0, seq = 0; at < bytes.length; at += 32768, seq++) {
    const request: ImageUploadChunk = {
      type: 'image_upload_chunk',
      id: generateId(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      transferId,
      seq,
      data: bytes.subarray(at, at + 32768).toString('base64url'),
    };
    const ack = await invoke(f.service, f.owner.id, request);
    expect(ack.type).toBe('image_upload_chunk_ack');
    if (ack.type === 'image_upload_chunk_ack')
      expect(ack.receivedBytes).toBe(Math.min(at + 32768, bytes.length));
  }
}

function operation(
  f: Awaited<ReturnType<typeof fixture>>,
  transferId: string,
  type: 'image_upload_complete' | 'image_upload_cancel',
): ImageStagingRequest {
  return {
    type,
    id: generateId(),
    timestamp: new Date().toISOString(),
    sessionId: f.sessionId,
    transferId,
  };
}

test('actual signed direct clients stage exact PNG/JPEG once and retain the original outcome', async () => {
  const f = await fixture();
  for (const file of ['fixture.png', 'fixture.jpg']) {
    const { request, bytes, accepted } = await start(f, file);
    const replay = await invoke(f.service, f.owner.id, request);
    expect(replay.type).toBe('image_upload_accepted');
    if (replay.type === 'image_upload_accepted') {
      expect(replay.transferId).toBe(accepted.transferId);
      expect(replay.expiresAt).toBe(accepted.expiresAt);
    }
    await chunks(f, accepted.transferId, bytes);
    const result = await invoke(
      f.service,
      f.owner.id,
      operation(f, accepted.transferId, 'image_upload_complete'),
    );
    expect(result.type).toBe('image_upload_result');
    if (result.type !== 'image_upload_result') throw new Error('Image was not staged');
    expect(result.byteLength).toBe(bytes.length);
    expect(result.digest).toBe(request.digest);
    expect(result.artifactId).not.toBe(result.transferId);
    const repeated = await invoke(
      f.service,
      f.owner.id,
      operation(f, accepted.transferId, 'image_upload_complete'),
    );
    expect(repeated.type).toBe('image_upload_result');
    if (repeated.type === 'image_upload_result') {
      expect(repeated.artifactId).toBe(result.artifactId);
      expect(repeated.artifactExpiresAt).toBe(result.artifactExpiresAt);
    }
    const cancelled = await invoke(
      f.service,
      f.owner.id,
      operation(f, accepted.transferId, 'image_upload_cancel'),
    );
    expect(cancelled.type === 'image_upload_refused' && cancelled.code).toBe('conflict');
  }
  expect(f.ledger().filter((row) => row.state === 'staged')).toHaveLength(2);
  expect(f.ledger()[0]?.device).toBe(
    createHash('sha256').update(Buffer.from(f.owner.identity.publicKey, 'base64')).digest('hex'),
  );
});

test('a second authorized client cannot learn or retire another client transfer', async () => {
  const f = await fixture();
  const foreign = await f.client();
  const { request, bytes, accepted } = await start(f);
  for (const input of [
    request,
    operation(f, accepted.transferId, 'image_upload_cancel'),
    operation(f, accepted.transferId, 'image_upload_complete'),
  ]) {
    const refusal = await invoke(f.service, foreign.id, input);
    expect(refusal.type === 'image_upload_refused' && refusal.code).toBe('unavailable');
    expect(f.ledger()[0]?.state).toBe('active');
  }
  await chunks(f, accepted.transferId, bytes);
  const staged = await invoke(
    f.service,
    f.owner.id,
    operation(f, accepted.transferId, 'image_upload_complete'),
  );
  expect(staged.type).toBe('image_upload_result');
});

test('wrong sequence is terminal; actual cleanup and retained cancellation are correlated', async () => {
  const f = await fixture();
  const { bytes, accepted } = await start(f);
  const request: ImageUploadChunk = {
    type: 'image_upload_chunk',
    id: generateId(),
    timestamp: new Date().toISOString(),
    sessionId: f.sessionId,
    transferId: accepted.transferId,
    seq: 1,
    data: bytes.toString('base64url'),
  };
  const refused = await invoke(f.service, f.owner.id, request);
  expect(refused.type === 'image_upload_refused' && refused.code).toBe('sequence');
  expect(f.ledger()[0]?.state).toBe('settled');
  for (let i = 0; i < 2; i++) {
    const cancelled = await invoke(
      f.service,
      f.owner.id,
      operation(f, accepted.transferId, 'image_upload_cancel'),
    );
    expect(cancelled.type).toBe('image_upload_cancel_result');
    expect(f.ledger()[0]?.charge).toBe(0);
  }
});

test('revoke and regrant do not revive an upload; changed binding retires only the owned partial', async () => {
  const f = await fixture();
  const first = await start(f);
  expect(f.store.removeAuthorizedKey(f.owner.identity.fingerprint)).toBe(true);
  await f.store.addAuthorizedKey(f.owner.identity.publicKey, 'regranted');
  const revoked = await invoke(
    f.service,
    f.owner.id,
    operation(f, first.accepted.transferId, 'image_upload_complete'),
  );
  expect(revoked.type === 'image_upload_refused' && revoked.code).toBe('unavailable');
  await f.service.maintain();
  expect(f.ledger()[0]?.state).toBe('settled');
  const second = await start(f);
  f.binding.update(f.sessionId, generateId());
  const changed = await invoke(
    f.service,
    f.owner.id,
    operation(f, second.accepted.transferId, 'image_upload_complete'),
  );
  expect(changed.type === 'image_upload_refused' && changed.code).toBe('binding_changed');
  await f.service.maintain();
  expect(f.ledger().filter((row) => row.state === 'active')).toHaveLength(0);
});

test('a live staged view survives another service recovery and disconnect, ending at session exit', async () => {
  const f = await fixture();
  const { bytes, accepted } = await start(f);
  await chunks(f, accepted.transferId, bytes);
  expect(
    (
      await invoke(
        f.service,
        f.owner.id,
        operation(f, accepted.transferId, 'image_upload_complete'),
      )
    ).type,
  ).toBe('image_upload_result');
  const other = await ImageStagingService.open({
    home: f.home,
    identityStore: f.store,
    sessionRegistry: f.registry,
    bindingStore: f.binding,
    directAdapter: f.directAdapter,
  });
  try {
    expect(f.ledger()[0]?.state).toBe('staged');
    f.registry.detachConnection(f.owner.id);
    await f.service.invalidateConnection(f.owner.id);
    await f.service.maintain();
    expect(f.ledger()[0]?.state).toBe('staged');
    f.registry.closeSession(f.sessionId, 'forced');
    await f.service.invalidateSession(f.sessionId);
    expect(f.ledger()[0]?.state).toBe('settled');
  } finally {
    expect(await other.close()).toBe(true);
  }
});

test('the shared home enforces device and session capacity across two live services', async () => {
  const f = await fixture();
  await start(f);
  const other = await ImageStagingService.open({
    home: f.home,
    identityStore: f.store,
    sessionRegistry: f.registry,
    bindingStore: f.binding,
    directAdapter: f.directAdapter,
  });
  try {
    expect((await invoke(other, f.owner.id, f.begin().request)).type).toBe('image_upload_accepted');
    const deviceFull = await invoke(f.service, f.owner.id, f.begin().request);
    expect(deviceFull.type === 'image_upload_refused' && deviceFull.code).toBe('busy');
    const second = await f.client();
    for (let i = 0; i < 2; i++)
      expect((await invoke(other, second.id, f.begin().request)).type).toBe(
        'image_upload_accepted',
      );
    const third = await f.client();
    const sessionFull = await invoke(f.service, third.id, f.begin().request);
    expect(sessionFull.type === 'image_upload_refused' && sessionFull.code).toBe('busy');
    expect(f.ledger().filter((row) => row.state === 'active')).toHaveLength(4);
  } finally {
    expect(await other.close()).toBe(true);
  }
});

test('a wrong completed digest is refused and cancellation during completion publishes no artifact', async () => {
  const f = await fixture();
  const declaration = f.begin();
  declaration.request.digest = createHash('sha256').update('different bytes').digest('base64url');
  const accepted = await invoke(f.service, f.owner.id, declaration.request);
  if (accepted.type !== 'image_upload_accepted') throw new Error('Actual begin not accepted');
  await chunks(f, accepted.transferId, declaration.bytes);
  const integrity = await invoke(
    f.service,
    f.owner.id,
    operation(f, accepted.transferId, 'image_upload_complete'),
  );
  expect(integrity.type === 'image_upload_refused' && integrity.code).toBe('integrity');
  expect(f.ledger()[0]?.state).toBe('settled');
  const second = await start(f, 'fixture.jpg');
  await chunks(f, second.accepted.transferId, second.bytes);
  const completion = invoke(
    f.service,
    f.owner.id,
    operation(f, second.accepted.transferId, 'image_upload_complete'),
  );
  const cancelled = await invoke(
    f.service,
    f.owner.id,
    operation(f, second.accepted.transferId, 'image_upload_cancel'),
  );
  expect(cancelled.type).toBe('image_upload_cancel_result');
  const result = await completion;
  expect(result.type === 'image_upload_refused' && result.code).toBe('unavailable');
  expect(f.ledger().filter((row) => row.state === 'staged')).toHaveLength(0);
});

test('the actual idle deadline cleans an unfinished partial while its signed socket stays live', async () => {
  const f = await fixture();
  const { request } = await start(f);
  await Bun.sleep(31000);
  expect(f.adapter.getDirectConnection(f.owner.id)?.isConnected).toBe(true);
  expect(f.ledger()[0]?.state).toBe('settled');
  const replay = await invoke(f.service, f.owner.id, request);
  expect(replay.type === 'image_upload_refused' && replay.code).toBe('unavailable');
}, 35000);

test('settled retry slots are bounded per device; evicted cancellation cannot recreate effects', async () => {
  const f = await fixture();
  let original: string | undefined;
  for (let i = 0; i < 33; i++) {
    const { accepted } = await start(f);
    original ??= accepted.transferId;
    const cancelled = await invoke(
      f.service,
      f.owner.id,
      operation(f, accepted.transferId, 'image_upload_cancel'),
    );
    expect(cancelled.type).toBe('image_upload_cancel_result');
    expect(f.ledger().length).toBeLessThanOrEqual(32);
  }
  if (!original) throw new Error('Missing original cancellation');
  const before = f.ledger();
  const evicted = await invoke(
    f.service,
    f.owner.id,
    operation(f, original, 'image_upload_cancel'),
  );
  expect(evicted.type === 'image_upload_refused' && evicted.code).toBe('unavailable');
  expect(f.ledger()).toEqual(before);
  expect(await f.service.close()).toBe(true);
});

test('closing during completion joins the same retirement and cannot publish a staged artifact', async () => {
  const f = await fixture();
  const { bytes, accepted } = await start(f, 'fixture.jpg');
  await chunks(f, accepted.transferId, bytes);
  const completion = invoke(
    f.service,
    f.owner.id,
    operation(f, accepted.transferId, 'image_upload_complete'),
  );
  const closing = f.service.close();
  expect(f.service.close()).toBe(closing);
  expect(await closing).toBe(true);
  const result = await completion;
  expect(result.type === 'image_upload_refused' && result.code).toBe('unavailable');
  expect(f.ledger().filter((row) => row.state !== 'settled')).toHaveLength(0);
});

test('two admitted completions share the owned decoder without losing either staged outcome', async () => {
  const f = await fixture();
  const first = await start(f, 'fixture.jpg');
  const second = await start(f, 'fixture.png');
  await chunks(f, first.accepted.transferId, first.bytes);
  await chunks(f, second.accepted.transferId, second.bytes);
  const results = await Promise.all([
    invoke(f.service, f.owner.id, operation(f, first.accepted.transferId, 'image_upload_complete')),
    invoke(
      f.service,
      f.owner.id,
      operation(f, second.accepted.transferId, 'image_upload_complete'),
    ),
  ]);
  expect(results.map((result) => result.type)).toEqual([
    'image_upload_result',
    'image_upload_result',
  ]);
  expect(f.ledger().filter((row) => row.state === 'staged')).toHaveLength(2);
});

/** These checks reach the shipping raw server -> Connection -> adapter event -> service path. */
async function wire(
  f: Awaited<ReturnType<typeof fixture>>,
  request: ImageStagingRequest,
  client = f.owner,
  raw: string | Uint8Array = encodeImageStagingFrame(request),
) {
  const before = client.received.length;
  client.socket.send(raw);
  await pollUntil(
    () =>
      client.received
        .slice(before)
        .some((message) => 'requestId' in message && message.requestId === request.id),
    10000,
    'strict staging wire outcome',
  );
  const response = client.received
    .slice(before)
    .find((message) => 'requestId' in message && message.requestId === request.id);
  if (!response || !response.type.startsWith('image_upload_'))
    throw new Error('Missing actual staging reply');
  return response as ImageStagingResponse;
}

for (const filename of ['fixture.png', 'fixture.jpg']) {
  test(`strict signed direct wire stages ${filename} and preserves begin replay`, async () => {
    const f = await fixture();
    expect(f.service.isAvailable(f.owner.id)).toBe(true);
    const { request, bytes } = f.begin(filename);
    const accepted = await wire(f, request);
    if (accepted.type !== 'image_upload_accepted') throw new Error('Actual wire admission failed');
    const repeated = await wire(
      f,
      request,
      f.owner,
      new TextEncoder().encode(encodeImageStagingFrame(request)),
    );
    expect(repeated.type).toBe('image_upload_accepted');
    if (repeated.type === 'image_upload_accepted')
      expect(repeated.transferId).toBe(accepted.transferId);
    for (let at = 0, seq = 0; at < bytes.length; at += 32768, seq++) {
      const chunk: ImageUploadChunk = {
        type: 'image_upload_chunk',
        id: generateId(),
        timestamp: new Date().toISOString(),
        sessionId: f.sessionId,
        transferId: accepted.transferId,
        seq,
        data: bytes.subarray(at, at + 32768).toString('base64url'),
      };
      const ack = await wire(f, chunk);
      expect(ack.type).toBe('image_upload_chunk_ack');
      if (ack.type === 'image_upload_chunk_ack')
        expect(ack.receivedBytes).toBe(Math.min(at + 32768, bytes.length));
    }
    const result = await wire(f, operation(f, accepted.transferId, 'image_upload_complete'));
    expect(result.type).toBe('image_upload_result');
    if (result.type === 'image_upload_result') {
      expect(result.digest).toBe(request.digest);
      expect(result.byteLength).toBe(bytes.length);
      expect(result.mediaType).toBe(request.mediaType);
    }
    expect(f.ledger().filter((row) => row.state === 'staged')).toHaveLength(1);
    expect(
      f.owner.received.some(
        (message) => message.type === 'ack' && message.ack.messageId === request.id,
      ),
    ).toBe(false);
  }, 20000);
}

test('strict wire malformed transfer hints distinguish actual owner only, without writes', async () => {
  const f = await fixture();
  const { request } = f.begin();
  const accepted = await wire(f, request);
  if (accepted.type !== 'image_upload_accepted') throw new Error('Actual wire admission failed');
  const malformed = {
    type: 'image_upload_chunk',
    id: generateId(),
    timestamp: new Date().toISOString(),
    sessionId: f.sessionId,
    transferId: accepted.transferId,
    seq: -1,
    data: 'AA',
  };
  const lookup = malformed as ImageUploadChunk;
  const foreign = await f.client();
  const hidden = await wire(f, lookup, foreign, JSON.stringify(malformed));
  expect(hidden.type).toBe('image_upload_refused');
  if (hidden.type === 'image_upload_refused') expect(hidden.code).toBe('unavailable');
  const owner = await wire(f, lookup, f.owner, JSON.stringify(malformed));
  expect(owner.type).toBe('image_upload_refused');
  if (owner.type === 'image_upload_refused') expect(owner.code).toBe('malformed');
  const cancelled = await wire(f, operation(f, accepted.transferId, 'image_upload_cancel'));
  expect(cancelled.type).toBe('image_upload_cancel_result');
  const retiredRequest = operation(f, accepted.transferId, 'image_upload_cancel');
  const retiredMalformed = await wire(
    f,
    retiredRequest,
    f.owner,
    JSON.stringify({ ...retiredRequest, extra: true }),
  );
  expect(retiredMalformed.type).toBe('image_upload_refused');
  if (retiredMalformed.type === 'image_upload_refused')
    expect(retiredMalformed.code).toBe('unavailable');
});

test('escaped root type selects strict ingress and duplicate mixed root types close', async () => {
  const f = await fixture();
  const { request } = f.begin();
  const escaped = encodeImageStagingFrame(request)
    .replace('"type"', '"\\u0074ype"')
    .replace('image_upload_begin', 'image_upload_\\u0062egin');
  const accepted = await wire(f, request, f.owner, escaped);
  expect(accepted.type).toBe('image_upload_accepted');
  const mixed = `${encodeImageStagingFrame(request).slice(0, -1)},"type":"ping"}`;
  f.owner.socket.send(mixed);
  await pollUntil(
    () => f.owner.socket.readyState === WebSocket.CLOSED,
    5000,
    'mixed root type close',
  );
});

test('late type on oversized binary staging closes, while a large ordinary frame retains its ACK', async () => {
  const f = await fixture();
  const normalId = generateId();
  f.owner.socket.send(
    JSON.stringify({
      type: 'user_input',
      id: normalId,
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      content: 'x'.repeat(100000),
      nested: { type: 'image_upload_chunk' },
    }),
  );
  await pollUntil(
    () =>
      f.owner.received.some(
        (message) => message.type === 'ack' && message.ack.messageId === normalId,
      ),
    5000,
    'large legacy ACK',
  );
  const { request } = f.begin();
  const oversized = `{"padding":"${'x'.repeat(66000)}",${encodeImageStagingFrame(request).slice(1)}`;
  f.owner.socket.send(new TextEncoder().encode(oversized));
  await pollUntil(
    () => f.owner.socket.readyState === WebSocket.CLOSED,
    5000,
    'oversized staging close',
  );
});
