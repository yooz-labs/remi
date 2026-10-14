import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ImageInsertRequest,
  type ImageInsertResult,
  decodeImageInsertionFrame,
  encodeImageInsertionFrame,
} from '../../../shared/src/image-insertion.ts';
import {
  type ImageStagingMessage,
  type ImageStagingRequest,
  decodeImageStagingFrame,
  encodeImageStagingFrame,
} from '../../../shared/src/image-staging.ts';
import type { ImageUploadState } from '../../src/components/chat/ImageUpload';
import { type ImageUploadContext, ImageUploadController } from '../../src/lib/image-upload';
import { type ImageStagingResponse, WebSocketClient } from '../../src/lib/websocket-client';

const SESSION_ID = '7bb8cd18-53ea-4780-9e2e-9e2b8dc6d5b7';
const TRANSFER_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ARTIFACT_ID = 'AgICAgICAgICAgICAgICAg';
const FIXTURES = new URL('../../../shared/tests/fixtures/image-staging/', import.meta.url);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clients: WebSocketClient[] = [];
const controllers: ImageUploadController[] = [];
interface TestServer {
  readonly port: number | undefined;
  stop(): void;
}

const servers: TestServer[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const client of clients.splice(0)) client.disconnect();
  for (const server of servers.splice(0)) server.stop();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for WebSocket state');
    await wait(5);
  }
}

function livePeer(
  onRequest: (ws: Bun.ServerWebSocket<unknown>, request: ImageStagingRequest) => void,
) {
  const server = Bun.serve({
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request)) return undefined;
      return new Response('websocket required', { status: 400 });
    },
    websocket: {
      open() {},
      message(ws, data) {
        const raw = typeof data === 'string' ? data : data.toString();
        const message = decodeImageStagingFrame(raw);
        if (message && !('requestId' in message)) onRequest(ws, message as ImageStagingRequest);
      },
      close() {},
    },
  });
  servers.push(server);
  return server;
}

function sendMessage(ws: Bun.ServerWebSocket<unknown>, message: ImageStagingMessage): void {
  ws.send(encodeImageStagingFrame(message));
}

function responseBase(request: { id: string; sessionId: string }) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: request.sessionId,
    requestId: request.id,
  };
}

async function transportClient(
  server: TestServer,
  events: ConstructorParameters<typeof WebSocketClient>[1] = {},
): Promise<WebSocketClient> {
  if (server.port === undefined) throw new Error('Test WebSocket server has no port');
  const client = new WebSocketClient(
    {
      url: `ws://127.0.0.1:${server.port}/image-upload-test`,
      autoReconnect: false,
      heartbeatInterval: 0,
      connectionTimeout: 2000,
    },
    events,
  );
  clients.push(client);
  client.connect();
  await waitFor(
    () =>
      client.isTransportOpen ||
      client.connectionStatus === 'error' ||
      client.connectionStatus === 'disconnected',
  );
  return client;
}

async function connectedClient(
  server: TestServer,
  events: ConstructorParameters<typeof WebSocketClient>[1] = {},
): Promise<WebSocketClient> {
  const client = await transportClient(server, events);
  await waitFor(() => client.connectionStatus === 'authenticating');
  return client;
}

async function authenticate(client: WebSocketClient): Promise<object> {
  expect(client.imageUploadGeneration).toBeNull();
  client.setConnected();
  const generation = client.imageUploadGeneration;
  expect(generation).not.toBeNull();
  return generation as object;
}

function testContext(
  client: WebSocketClient,
  generation: object,
  protocolVersion: unknown = 1,
): ImageUploadContext {
  return {
    transport: 'direct',
    connection: client,
    generation,
    sessionId: SESSION_ID,
    binding: { harness: 'claude', harnessSessionId: 'claude-session-for-test' },
    capabilities: ['image_staging'],
    protocolVersion,
  };
}

function actualFile(name: string, bytes: ArrayBuffer | Uint8Array, type: string): File {
  const data = bytes instanceof Uint8Array ? Uint8Array.from(bytes) : new Uint8Array(bytes);
  return new File([data], name, { type });
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * These tests exercise client behavior against a real Bun WebSocket with a
 * controlled raw-wire peer. They do not exercise daemon admission, storage,
 * decoding, authority or production upload availability.
 */
describe('ImageUploadController over direct WebSocket', () => {
  for (const fixture of [
    { filename: 'fixture.png', mediaType: 'image/png', chunks: 1 },
    { filename: 'fixture.jpg', mediaType: 'image/jpeg', chunks: 2 },
  ] as const) {
    test(`sends the exact ${fixture.filename} bytes stop-and-wait and stages only a matching result`, async () => {
      const bytes = new Uint8Array(
        await Bun.file(new URL(fixture.filename, FIXTURES)).arrayBuffer(),
      );
      const receivedChunks: Uint8Array[] = [];
      const requests: ImageStagingRequest[] = [];
      let declaration: Extract<ImageStagingRequest, { type: 'image_upload_begin' }> | null = null;
      const server = livePeer((ws, request) => {
        requests.push(request);
        if (request.type === 'image_upload_begin') {
          declaration = request;
          sendMessage(ws, {
            type: 'image_upload_accepted',
            ...responseBase(request),
            transferId: TRANSFER_ID,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        } else if (request.type === 'image_upload_chunk') {
          const chunk = decodeBase64Url(request.data);
          receivedChunks.push(chunk);
          const receivedBytes = receivedChunks.reduce((sum, item) => sum + item.byteLength, 0);
          sendMessage(ws, {
            type: 'image_upload_chunk_ack',
            ...responseBase(request),
            transferId: request.transferId,
            seq: request.seq,
            receivedBytes,
          });
        } else if (request.type === 'image_upload_complete' && declaration) {
          sendMessage(ws, {
            type: 'image_upload_result',
            ...responseBase(request),
            transferId: request.transferId,
            outcome: 'staged',
            artifactId: ARTIFACT_ID,
            artifactExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            byteLength: declaration.byteLength,
            mediaType: declaration.mediaType,
            digest: declaration.digest,
          });
        }
      });

      let controller: ImageUploadController | null = null;
      const client = await connectedClient(server, {
        onImageStagingMessage: (message) => controller?.receive(message),
      });
      const generation = await authenticate(client);
      const states: ImageUploadState[] = [];
      let context: ImageUploadContext | null = testContext(
        client,
        generation,
        fixture.filename === 'fixture.png' ? undefined : 1,
      );
      controller = new ImageUploadController(
        { send: (request) => client.sendImageStaging(request), context: () => context },
        (state) => states.push(state),
      );
      controllers.push(controller);

      await controller.upload(actualFile(fixture.filename, bytes, fixture.mediaType));

      const expectedTypes: ImageStagingRequest['type'][] = [
        'image_upload_begin',
        ...Array.from(
          { length: fixture.chunks },
          (): ImageStagingRequest['type'] => 'image_upload_chunk',
        ),
        'image_upload_complete',
      ];
      expect(requests.map((request) => request.type)).toEqual(expectedTypes);
      expect(receivedChunks.map((chunk) => chunk.byteLength)).toEqual(
        fixture.chunks === 1 ? [bytes.byteLength] : [32768, bytes.byteLength - 32768],
      );
      expect(concatBytes(receivedChunks)).toEqual(bytes);
      const begin = requests[0];
      expect(begin?.type).toBe('image_upload_begin');
      if (begin?.type === 'image_upload_begin') {
        const actualDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        expect(begin.byteLength).toBe(bytes.byteLength);
        expect(begin.mediaType).toBe(fixture.mediaType);
        expect(begin.digest).toBe(encodeBase64Url(actualDigest));
        expect(begin.binding).toEqual({
          harness: 'claude',
          harnessSessionId: 'claude-session-for-test',
        });
      }
      expect(states.filter((state) => state.phase === 'uploading')).toEqual([
        ...Array.from({ length: fixture.chunks + 1 }, (_, index) => ({
          phase: 'uploading' as const,
          filename: fixture.filename,
          uploadedBytes: index === 0 ? 0 : Math.min(index * 32768, bytes.byteLength),
          totalBytes: bytes.byteLength,
        })),
      ]);
      expect(states.at(-1)).toEqual({ phase: 'staged', filename: fixture.filename });
      await controller.cancel();
      expect(requests.map((request) => request.type)).not.toContain('image_upload_cancel');
      expect(states.at(-1)).toEqual({ phase: 'staged', filename: fixture.filename });
      context = null;
    });
  }

  test('cancel during file preparation sends no begin request', async () => {
    const requests: ImageStagingRequest[] = [];
    const server = livePeer((_ws, request) => requests.push(request));
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    const context = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());

    const upload = controller.upload(actualFile('fixture.png', bytes, 'image/png'));
    const cancellation = controller.cancel();
    await Promise.all([upload, cancellation]);

    expect(requests).toEqual([]);
    expect(states.at(-1)).toEqual({ phase: 'idle' });
  });

  test('disconnect or disposal during native file reading sends no begin on the same context', async () => {
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());
    for (const action of ['disconnect', 'dispose'] as const) {
      const requests: ImageStagingRequest[] = [];
      const server = livePeer((_ws, request) => requests.push(request));
      let controller: ImageUploadController | null = null;
      const client = await connectedClient(server, {
        onImageStagingMessage: (message) => controller?.receive(message),
      });
      const generation = await authenticate(client);
      const states: ImageUploadState[] = [];
      const context = testContext(client, generation);
      controller = new ImageUploadController(
        { send: (request) => client.sendImageStaging(request), context: () => context },
        (state) => states.push(state),
      );
      controllers.push(controller);

      const upload = controller.upload(actualFile('fixture.png', bytes, 'image/png'));
      const stateCountAtStop = states.length;
      if (action === 'disconnect') controller.disconnect();
      else controller.dispose();
      await upload;

      expect(requests).toEqual([]);
      if (action === 'disconnect') expect(states.at(-1)?.phase).toBe('failed');
      else expect(states).toHaveLength(stateCountAtStop);
    }
  });

  test('cancel during begin wait sends cancel only after acceptance reveals the transfer ID', async () => {
    const requests: ImageStagingRequest[] = [];
    const pendingBegin: {
      current: { ws: Bun.ServerWebSocket<unknown>; request: ImageStagingRequest } | null;
    } = { current: null };
    const server = livePeer((ws, request) => {
      requests.push(request);
      if (request.type === 'image_upload_begin') {
        pendingBegin.current = { ws, request };
      } else if (request.type === 'image_upload_cancel') {
        sendMessage(ws, {
          type: 'image_upload_cancel_result',
          ...responseBase(request),
          transferId: request.transferId,
          outcome: 'cancelled',
        });
      }
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    const context = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());

    const upload = controller.upload(actualFile('fixture.png', bytes, 'image/png'));
    await waitFor(() => pendingBegin.current !== null);
    const cancellation = controller.cancel();
    await waitFor(() => states.some((state) => state.phase === 'cancelling'));
    expect(requests.map((request) => request.type)).toEqual(['image_upload_begin']);

    const begin = pendingBegin.current;
    if (!begin || begin.request.type !== 'image_upload_begin')
      throw new Error('Missing begin request');
    sendMessage(begin.ws, {
      type: 'image_upload_accepted',
      ...responseBase(begin.request),
      transferId: TRANSFER_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await Promise.all([upload, cancellation]);

    expect(requests.map((request) => request.type)).toEqual([
      'image_upload_begin',
      'image_upload_cancel',
    ]);
    expect(states.at(-1)).toEqual({ phase: 'idle' });
  });

  test('cancel during chunk wait stops before another chunk or completion', async () => {
    const requests: ImageStagingRequest[] = [];
    const pendingChunk: {
      current: {
        ws: Bun.ServerWebSocket<unknown>;
        request: Extract<ImageStagingRequest, { type: 'image_upload_chunk' }>;
      } | null;
    } = { current: null };
    const server = livePeer((ws, request) => {
      requests.push(request);
      if (request.type === 'image_upload_begin') {
        sendMessage(ws, {
          type: 'image_upload_accepted',
          ...responseBase(request),
          transferId: TRANSFER_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } else if (request.type === 'image_upload_chunk') {
        pendingChunk.current = { ws, request };
      } else if (request.type === 'image_upload_cancel') {
        sendMessage(ws, {
          type: 'image_upload_cancel_result',
          ...responseBase(request),
          transferId: request.transferId,
          outcome: 'cancelled',
        });
      }
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    const context = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.jpg', FIXTURES)).arrayBuffer());

    const upload = controller.upload(actualFile('fixture.jpg', bytes, 'image/jpeg'));
    await waitFor(() => pendingChunk.current !== null);
    const cancellation = controller.cancel();
    await waitFor(() => states.some((state) => state.phase === 'cancelling'));
    const chunk = pendingChunk.current;
    if (!chunk) throw new Error('Missing chunk request');
    sendMessage(chunk.ws, {
      type: 'image_upload_chunk_ack',
      ...responseBase(chunk.request),
      transferId: chunk.request.transferId,
      seq: chunk.request.seq,
      receivedBytes:
        chunk.request.data.length === 0 ? 0 : decodeBase64Url(chunk.request.data).byteLength,
    });
    await Promise.all([upload, cancellation]);

    expect(requests.map((request) => request.type)).toEqual([
      'image_upload_begin',
      'image_upload_chunk',
      'image_upload_cancel',
    ]);
    expect(
      states.filter((state) => state.phase === 'uploading').map((state) => state.uploadedBytes),
    ).toEqual([0]);
    expect(states.at(-1)).toEqual({ phase: 'idle' });
  });

  test('a verified staged result wins over a later cancel conflict', async () => {
    const requests: ImageStagingRequest[] = [];
    const received: {
      begin: Extract<ImageStagingRequest, { type: 'image_upload_begin' }> | null;
      complete: Extract<ImageStagingRequest, { type: 'image_upload_complete' }> | null;
      cancel: Extract<ImageStagingRequest, { type: 'image_upload_cancel' }> | null;
      peer: Bun.ServerWebSocket<unknown> | null;
    } = { begin: null, complete: null, cancel: null, peer: null };
    const server = livePeer((ws, request) => {
      requests.push(request);
      received.peer = ws;
      if (request.type === 'image_upload_begin') {
        received.begin = request;
        sendMessage(ws, {
          type: 'image_upload_accepted',
          ...responseBase(request),
          transferId: TRANSFER_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } else if (request.type === 'image_upload_chunk') {
        sendMessage(ws, {
          type: 'image_upload_chunk_ack',
          ...responseBase(request),
          transferId: request.transferId,
          seq: request.seq,
          receivedBytes: decodeBase64Url(request.data).byteLength,
        });
      } else if (request.type === 'image_upload_complete') {
        received.complete = request;
      } else if (request.type === 'image_upload_cancel') {
        received.cancel = request;
      }
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    const context = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());

    const upload = controller.upload(actualFile('fixture.png', bytes, 'image/png'));
    await waitFor(() => received.complete !== null);
    const cancellation = controller.cancel();
    await waitFor(() => received.cancel !== null);
    const completeRequest = received.complete;
    const beginRequest = received.begin;
    const currentPeer = received.peer;
    if (
      !completeRequest ||
      completeRequest.type !== 'image_upload_complete' ||
      !beginRequest ||
      beginRequest.type !== 'image_upload_begin' ||
      !currentPeer
    ) {
      throw new Error('Missing completion race request');
    }
    sendMessage(currentPeer, {
      type: 'image_upload_result',
      ...responseBase(completeRequest),
      transferId: completeRequest.transferId,
      outcome: 'staged',
      artifactId: ARTIFACT_ID,
      artifactExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      byteLength: beginRequest.byteLength,
      mediaType: beginRequest.mediaType,
      digest: beginRequest.digest,
    });
    const cancelRequest = received.cancel;
    if (!cancelRequest || cancelRequest.type !== 'image_upload_cancel') {
      throw new Error('Missing cancellation race request');
    }
    sendMessage(currentPeer, {
      type: 'image_upload_refused',
      ...responseBase(cancelRequest),
      operation: 'image_upload_cancel',
      code: 'conflict',
    });
    await Promise.all([upload, cancellation]);

    expect(requests.map((request) => request.type)).toEqual([
      'image_upload_begin',
      'image_upload_chunk',
      'image_upload_complete',
      'image_upload_cancel',
    ]);
    expect(states.at(-1)).toEqual({ phase: 'staged', filename: 'fixture.png' });
  });

  test('a confirmed cancel during completion wins over a late completion refusal', async () => {
    const requests: ImageStagingRequest[] = [];
    const received: {
      complete: Extract<ImageStagingRequest, { type: 'image_upload_complete' }> | null;
      peer: Bun.ServerWebSocket<unknown> | null;
    } = { complete: null, peer: null };
    const server = livePeer((ws, request) => {
      requests.push(request);
      received.peer = ws;
      if (request.type === 'image_upload_begin') {
        sendMessage(ws, {
          type: 'image_upload_accepted',
          ...responseBase(request),
          transferId: TRANSFER_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } else if (request.type === 'image_upload_chunk') {
        sendMessage(ws, {
          type: 'image_upload_chunk_ack',
          ...responseBase(request),
          transferId: request.transferId,
          seq: request.seq,
          receivedBytes: decodeBase64Url(request.data).byteLength,
        });
      } else if (request.type === 'image_upload_complete') {
        received.complete = request;
      } else if (request.type === 'image_upload_cancel') {
        sendMessage(ws, {
          type: 'image_upload_cancel_result',
          ...responseBase(request),
          transferId: request.transferId,
          outcome: 'cancelled',
        });
      }
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    const context = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());

    const upload = controller.upload(actualFile('fixture.png', bytes, 'image/png'));
    await waitFor(() => received.complete !== null);
    const cancellation = controller.cancel();
    await Promise.all([upload, cancellation]);

    const completeRequest = received.complete;
    const currentPeer = received.peer;
    if (!completeRequest || completeRequest.type !== 'image_upload_complete' || !currentPeer) {
      throw new Error('Missing completion request');
    }
    sendMessage(currentPeer, {
      type: 'image_upload_refused',
      ...responseBase(completeRequest),
      operation: 'image_upload_complete',
      code: 'unavailable',
    });
    expect(requests.map((request) => request.type)).toEqual([
      'image_upload_begin',
      'image_upload_chunk',
      'image_upload_complete',
      'image_upload_cancel',
    ]);
    expect(states.at(-1)).toEqual({ phase: 'idle' });
  });

  test('unmatched chunk acknowledgment cannot advance progress; a matching one can', async () => {
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.jpg', FIXTURES)).arrayBuffer());
    const states: ImageUploadState[] = [];
    let context: ImageUploadContext | null = null;
    let ignoredWrongRequestId = false;
    const requests: ImageStagingRequest[] = [];
    const server = livePeer((ws, request) => {
      requests.push(request);
      if (request.type === 'image_upload_begin') {
        sendMessage(ws, {
          type: 'image_upload_accepted',
          ...responseBase(request),
          transferId: TRANSFER_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } else if (request.type === 'image_upload_chunk' && request.seq === 0) {
        const chunk = decodeBase64Url(request.data);
        sendMessage(ws, {
          type: 'image_upload_chunk_ack',
          ...responseBase(request),
          requestId: crypto.randomUUID(),
          transferId: request.transferId,
          seq: request.seq,
          receivedBytes: chunk.byteLength,
        });
        setTimeout(() => {
          ignoredWrongRequestId =
            states.filter((state) => state.phase === 'uploading').length === 1;
          sendMessage(ws, {
            type: 'image_upload_chunk_ack',
            ...responseBase(request),
            transferId: request.transferId,
            seq: request.seq,
            receivedBytes: chunk.byteLength,
          });
        }, 20);
      } else if (request.type === 'image_upload_chunk' && request.seq === 1) {
        sendMessage(ws, {
          type: 'image_upload_chunk_ack',
          ...responseBase(request),
          transferId: request.transferId,
          seq: request.seq,
          receivedBytes: bytes.byteLength,
        });
      } else if (request.type === 'image_upload_complete') {
        const begin = requests.find((item) => item.type === 'image_upload_begin');
        if (begin?.type !== 'image_upload_begin') return;
        sendMessage(ws, {
          type: 'image_upload_result',
          ...responseBase(request),
          transferId: request.transferId,
          outcome: 'staged',
          artifactId: ARTIFACT_ID,
          artifactExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          byteLength: begin.byteLength,
          mediaType: begin.mediaType,
          digest: begin.digest,
        });
      }
    });

    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    context = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);

    await controller.upload(actualFile('fixture.jpg', bytes, 'image/jpeg'));

    expect(ignoredWrongRequestId).toBe(true);
    expect(
      states.filter((state) => state.phase === 'uploading').map((state) => state.uploadedBytes),
    ).toEqual([0, 32768, bytes.byteLength]);
    expect(states.at(-1)).toEqual({ phase: 'staged', filename: 'fixture.jpg' });
  });

  test('a matching malformed acknowledgment stops uncertain without sending another request', async () => {
    const requests: ImageStagingRequest[] = [];
    const server = livePeer((ws, request) => {
      requests.push(request);
      if (request.type === 'image_upload_begin') {
        sendMessage(ws, {
          type: 'image_upload_accepted',
          ...responseBase(request),
          transferId: TRANSFER_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } else if (request.type === 'image_upload_chunk') {
        sendMessage(ws, {
          type: 'image_upload_chunk_ack',
          ...responseBase(request),
          transferId: request.transferId,
          seq: request.seq + 1,
          receivedBytes: request.data.length,
        });
      }
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    let context: ImageUploadContext | null = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);

    const bytes = await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer();
    await controller.upload(actualFile('fixture.png', new Uint8Array(bytes), 'image/png'));

    expect(requests.map((request) => request.type)).toEqual([
      'image_upload_begin',
      'image_upload_chunk',
    ]);
    expect(states.at(-1)?.phase).toBe('uncertain');
    context = null;
  });

  test('an uncertain upload blocks the same generation until the WebSocket reconnects', async () => {
    const requests: ImageStagingRequest[] = [];
    let beginCount = 0;
    let acceptedBegin: Extract<ImageStagingRequest, { type: 'image_upload_begin' }> | null = null;
    const server = livePeer((ws, request) => {
      requests.push(request);
      if (request.type === 'image_upload_begin') {
        beginCount += 1;
        acceptedBegin = request;
        sendMessage(ws, {
          type: 'image_upload_accepted',
          ...responseBase(request),
          transferId: TRANSFER_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } else if (request.type === 'image_upload_chunk') {
        const receivedBytes = decodeBase64Url(request.data).byteLength;
        sendMessage(ws, {
          type: 'image_upload_chunk_ack',
          ...responseBase(request),
          transferId: request.transferId,
          seq: beginCount === 1 ? request.seq + 1 : request.seq,
          receivedBytes,
        });
      } else if (request.type === 'image_upload_complete' && acceptedBegin) {
        sendMessage(ws, {
          type: 'image_upload_result',
          ...responseBase(request),
          transferId: request.transferId,
          outcome: 'staged',
          artifactId: ARTIFACT_ID,
          artifactExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          byteLength: acceptedBegin.byteLength,
          mediaType: acceptedBegin.mediaType,
          digest: acceptedBegin.digest,
        });
      }
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    let context: ImageUploadContext | null = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);

    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());
    const file = actualFile('fixture.png', bytes, 'image/png');
    await controller.upload(file);

    expect(states.at(-1)?.phase).toBe('uncertain');
    expect(controller.canUpload).toBe(false);
    controller.dismiss();
    expect(states.at(-1)).toEqual({ phase: 'idle' });
    expect(controller.canUpload).toBe(false);
    await controller.upload(file);
    expect(requests.filter((request) => request.type === 'image_upload_begin')).toHaveLength(1);
    expect(states.at(-1)).toEqual({
      phase: 'uncertain',
      filename: 'fixture.png',
      message: 'Reconnect before retrying this image upload.',
    });

    client.forceReconnect();
    await waitFor(
      () => client.connectionStatus === 'authenticating' && client.isTransportOpen,
      3000,
    );
    const nextGeneration = await authenticate(client);
    expect(nextGeneration).not.toBe(generation);
    context = testContext(client, nextGeneration);
    expect(controller.canUpload).toBe(true);

    await controller.upload(file);
    expect(requests.filter((request) => request.type === 'image_upload_begin')).toHaveLength(2);
    expect(states.at(-1)).toEqual({ phase: 'staged', filename: 'fixture.png' });
  });

  test('context loss while begin is pending prevents old session from sending chunks', async () => {
    const requests: ImageStagingRequest[] = [];
    const server = livePeer((ws, request) => {
      requests.push(request);
      if (request.type === 'image_upload_begin') {
        const previousContext = currentContext;
        if (previousContext) currentContext = { ...previousContext, generation: {} };
        sendMessage(ws, {
          type: 'image_upload_accepted',
          ...responseBase(request),
          transferId: TRANSFER_ID,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    let currentContext: ImageUploadContext | null = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => currentContext },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer();

    await controller.upload(actualFile('fixture.png', bytes, 'image/png'));

    expect(requests.map((request) => request.type)).toEqual(['image_upload_begin']);
    expect(states.at(-1)?.phase).toBe('uncertain');
    currentContext = null;
  });

  test('refusal is correlated and shown as a friendly failure without host details', async () => {
    const server = livePeer((ws, request) => {
      if (request.type !== 'image_upload_begin') return;
      sendMessage(ws, {
        type: 'image_upload_refused',
        ...responseBase(request),
        operation: request.type,
        code: 'busy',
      });
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    let context: ImageUploadContext | null = testContext(client, generation);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer();

    await controller.upload(actualFile('fixture.png', bytes, 'image/png'));

    expect(states.at(-1)).toEqual({
      phase: 'failed',
      filename: 'fixture.png',
      message: 'The host is handling another image upload. Try again in a moment.',
    });
    context = null;
  });

  test('missing direct capability fails before sending the file', async () => {
    const requests: ImageStagingRequest[] = [];
    const server = livePeer((_ws, request) => requests.push(request));
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    const context = { ...testContext(client, generation), capabilities: [] };
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer();

    await controller.upload(actualFile('fixture.png', bytes, 'image/png'));

    expect(requests).toEqual([]);
    expect(states.at(-1)?.phase).toBe('failed');
  });

  test('unsupported protocol versions fail closed before sending', async () => {
    const requests: ImageStagingRequest[] = [];
    const server = livePeer((_ws, request) => requests.push(request));
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    let context = testContext(client, generation, 2);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());
    const file = actualFile('fixture.png', bytes, 'image/png');

    for (const protocolVersion of [2, '1', 1.5]) {
      context = testContext(client, generation, protocolVersion);
      await controller.upload(file);
      expect(states.at(-1)?.phase).toBe('failed');
    }

    expect(requests).toEqual([]);
  });

  test('a protocol version change while begin is pending stops before sending chunks', async () => {
    const requests: ImageStagingRequest[] = [];
    let context: ImageUploadContext | null = null;
    const server = livePeer((ws, request) => {
      requests.push(request);
      if (request.type !== 'image_upload_begin') return;
      if (context) context = { ...context, protocolVersion: '1' };
      sendMessage(ws, {
        type: 'image_upload_accepted',
        ...responseBase(request),
        transferId: TRANSFER_ID,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    let controller: ImageUploadController | null = null;
    const client = await connectedClient(server, {
      onImageStagingMessage: (message) => controller?.receive(message),
    });
    const generation = await authenticate(client);
    const states: ImageUploadState[] = [];
    context = testContext(client, generation, 1);
    controller = new ImageUploadController(
      { send: (request) => client.sendImageStaging(request), context: () => context },
      (state) => states.push(state),
    );
    controllers.push(controller);
    const bytes = new Uint8Array(await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer());

    await controller.upload(actualFile('fixture.png', bytes, 'image/png'));

    expect(requests.map((request) => request.type)).toEqual(['image_upload_begin']);
    expect(states.at(-1)?.phase).toBe('uncertain');
  });

  test('the shipping ID and staging codec work without crypto.randomUUID or Object.hasOwn', async () => {
    const fixturePath = new URL(
      '../../../shared/tests/fixtures/image-staging/fixture.png',
      import.meta.url,
    ).pathname;
    const protocolPath = new URL('../../../shared/src/protocol.ts', import.meta.url).pathname;
    const codecPath = new URL('../../../shared/src/image-staging.ts', import.meta.url).pathname;
    const script = `
      const crypto = globalThis.crypto;
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: { getRandomValues: crypto.getRandomValues.bind(crypto) },
      });
      Object.defineProperty(Object, 'hasOwn', { configurable: true, value: undefined });
      const { generateId } = await import(${JSON.stringify(protocolPath)});
      const { encodeImageStagingFrame, decodeImageStagingFrame } = await import(${JSON.stringify(codecPath)});
      const bytes = new Uint8Array(await Bun.file(${JSON.stringify(fixturePath)}).arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const data = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      const frame = encodeImageStagingFrame({
        type: 'image_upload_chunk',
        id: generateId(),
        timestamp: new Date().toISOString(),
        sessionId: '${SESSION_ID}',
        transferId: '${TRANSFER_ID}',
        seq: 0,
        data,
      });
      const decoded = decodeImageStagingFrame(frame);
      if (!decoded || decoded.type !== 'image_upload_chunk' || decoded.data !== data) process.exit(1);
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });
});

describe('WebSocketClient image staging boundary', () => {
  test('uses strict response ingress and exposes a new opaque generation per authenticated socket', async () => {
    const responses: ImageStagingResponse[] = [];
    const ordinary: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return undefined;
        return new Response('websocket required', { status: 400 });
      },
      websocket: {
        open(ws) {
          sendMessage(ws, {
            type: 'image_upload_refused',
            id: crypto.randomUUID(),
            requestId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId: SESSION_ID,
            operation: 'image_upload_begin',
            code: 'busy',
          });
        },
        message() {},
        close() {},
      },
    });
    servers.push(server);
    const client = await connectedClient(server, {
      onMessage: (message) => ordinary.push(message),
      onImageStagingMessage: (message) => responses.push(message),
    });
    await waitFor(() => responses.length === 1);
    expect(responses[0]?.type).toBe('image_upload_refused');
    expect(ordinary).toEqual([]);
    expect(client.imageUploadGeneration).toBeNull();

    client.setConnected();
    const first = client.imageUploadGeneration;
    expect(first).not.toBeNull();
    client.disconnect();
    expect(client.imageUploadGeneration).toBeNull();
    client.connect();
    await waitFor(() => client.connectionStatus === 'authenticating');
    client.setConnected();
    const second = client.imageUploadGeneration;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  test('closes on malformed image staging candidates with a fixed error and no legacy delivery', async () => {
    const errors: string[] = [];
    const ordinary: unknown[] = [];
    let connectionClosed = false;
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return undefined;
        return new Response('websocket required', { status: 400 });
      },
      websocket: {
        open(ws) {
          // Duplicate type members are a strict staging failure even though JSON.parse accepts them.
          ws.send(
            '{"type":"image_upload_chunk_ack","id":"70000000-0000-4000-8000-000000000001","timestamp":"2026-10-13T00:00:00.000Z","sessionId":"7bb8cd18-53ea-4780-9e2e-9e2b8dc6d5b7","requestId":"70000000-0000-4000-8000-000000000002","transferId":"AQEBAQEBAQEBAQEBAQEBAQ","seq":0,"receivedBytes":1,"type":"image_upload_complete"}',
          );
        },
        message() {},
        close() {
          connectionClosed = true;
        },
      },
    });
    servers.push(server);
    await transportClient(server, {
      onError: (error) => errors.push(error.message),
      onMessage: (message) => ordinary.push(message),
    });

    await waitFor(() => errors.length > 0 && connectionClosed);
    expect(errors).toEqual(['Invalid image staging response']);
    expect(connectionClosed).toBe(true);
    expect(ordinary).toEqual([]);
  });

  test('closes on a valid client-direction staging frame from the server', async () => {
    const errors: string[] = [];
    let connectionClosed = false;
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request)) return undefined;
        return new Response('websocket required', { status: 400 });
      },
      websocket: {
        open(ws) {
          sendMessage(ws, {
            type: 'image_upload_begin',
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId: SESSION_ID,
            binding: { harness: 'claude', harnessSessionId: 'wrong-direction' },
            mediaType: 'image/png',
            byteLength: 1,
            digest: encodeBase64Url(new Uint8Array(32)),
          });
        },
        message() {},
        close() {
          connectionClosed = true;
        },
      },
    });
    servers.push(server);
    const client = await transportClient(server, {
      onError: (error) => errors.push(error.message),
    });

    await waitFor(() => errors.length > 0 && connectionClosed);
    expect(errors).toEqual(['Invalid image staging response']);
    expect(connectionClosed).toBe(true);
    expect(client.connectionStatus).toBe('disconnected');
  });
});

/** Real raw-wire client controls only; host authority/effects are proven separately. */
async function insertionFixture(options: { caps?: string[]; expiryMs?: number } = {}) {
  const requests: ImageInsertRequest[] = [];
  const otherRequests: ImageStagingRequest[] = [];
  let socket: Bun.ServerWebSocket<unknown> | null = null;
  let begin: Extract<ImageStagingRequest, { type: 'image_upload_begin' }> | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request)) return undefined;
      return new Response('websocket required', { status: 400 });
    },
    websocket: {
      open() {},
      close() {},
      message(ws, data) {
        socket = ws;
        const raw = typeof data === 'string' ? data : new Uint8Array(data);
        const insertion = decodeImageInsertionFrame(raw);
        if (insertion?.type === 'image_insert_request') {
          requests.push(insertion);
          return;
        }
        const staging = decodeImageStagingFrame(raw);
        if (!staging || 'requestId' in staging) throw new Error('Unexpected client frame');
        const request = staging as ImageStagingRequest;
        otherRequests.push(request);
        if (request.type === 'image_upload_begin') {
          begin = request;
          sendMessage(ws, {
            type: 'image_upload_accepted',
            ...responseBase(request),
            transferId: TRANSFER_ID,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        } else if (request.type === 'image_upload_chunk') {
          sendMessage(ws, {
            type: 'image_upload_chunk_ack',
            ...responseBase(request),
            transferId: TRANSFER_ID,
            seq: request.seq,
            receivedBytes: begin?.byteLength ?? 0,
          });
        } else if (request.type === 'image_upload_complete' && begin) {
          sendMessage(ws, {
            type: 'image_upload_result',
            ...responseBase(request),
            transferId: TRANSFER_ID,
            outcome: 'staged',
            artifactId: ARTIFACT_ID,
            artifactExpiresAt: new Date(Date.now() + (options.expiryMs ?? 60_000)).toISOString(),
            mediaType: begin.mediaType,
            byteLength: begin.byteLength,
            digest: begin.digest,
          });
        }
      },
    },
  });
  servers.push(server);
  let controller: ImageUploadController | null = null;
  const client = await connectedClient(server, {
    onImageStagingMessage: (message) => controller?.receive(message),
    onImageInsertionMessage: (message) => controller?.receiveInsertion(message),
    onMessage: (message) => controller?.receiveInputReceipt(message),
  });
  const generation = await authenticate(client);
  let context: ImageUploadContext | null = {
    ...testContext(client, generation),
    capabilities: options.caps ?? ['image_staging', 'image_insertion'],
  };
  const states: ImageUploadState[] = [];
  controller = new ImageUploadController(
    {
      send: (request) => client.sendImageStaging(request),
      sendInsertion: (request) => client.sendImageInsertion(request),
      context: () => context,
    },
    (state) => states.push(state),
  );
  controllers.push(controller);
  const bytes = await Bun.file(new URL('fixture.png', FIXTURES)).arrayBuffer();
  await controller.upload(actualFile('fixture.png', bytes, 'image/png'));
  function lastDraft() {
    const state = states.at(-1);
    return state?.phase === 'staged' ? state.draft : undefined;
  }
  function result(effect: Pick<ImageInsertResult, 'outcome' | 'code'>, request = requests.at(-1)) {
    if (!request || !socket) throw new Error('No insertion request');
    return {
      type: 'image_insert_result' as const,
      ...responseBase(request),
      ...effect,
    } as ImageInsertResult;
  }
  function send(result: ImageInsertResult, binary = false) {
    if (!socket) throw new Error('No socket');
    const text = encodeImageInsertionFrame(result);
    socket.send(binary ? new TextEncoder().encode(text) : text);
  }
  return {
    client,
    controller,
    requests,
    otherRequests,
    states,
    lastDraft,
    result,
    send,
    current: () => context,
    context: (next: ImageUploadContext | null) => {
      context = next;
    },
    raw: (text: string) => {
      if (!socket) throw new Error('No socket');
      socket.send(text);
    },
  };
}

describe('explicit image draft client over real WebSocket', () => {
  test('staging never inserts, repeated clicks share one attempt, and success never submits', async () => {
    const f = await insertionFixture();
    expect(f.lastDraft()?.phase).toBe('available');
    expect(f.requests).toHaveLength(0);
    const originalExpiry = f.lastDraft()?.expiresAt;
    f.controller.addToDraft();
    f.controller.addToDraft();
    await waitFor(() => f.requests.length === 1);
    expect(f.controller.canUpload).toBe(false);
    expect(f.requests[0]).toMatchObject({
      sessionId: SESSION_ID,
      artifactId: ARTIFACT_ID,
      binding: { harness: 'claude', harnessSessionId: 'claude-session-for-test' },
    });
    f.send(f.result({ outcome: 'inserted', code: 'none' }), true);
    await waitFor(() => f.lastDraft()?.phase === 'inserted');
    f.controller.addToDraft();
    await wait(20);
    expect(f.requests).toHaveLength(1);
    expect(f.otherRequests.map((request) => request.type)).toEqual([
      'image_upload_begin',
      'image_upload_chunk',
      'image_upload_complete',
    ]);
    expect(f.lastDraft()?.expiresAt).toBe(originalExpiry);
  });

  for (const code of ['busy', 'prompt_up'] as const) {
    test(`${code} permits a fresh explicit attempt but no automatic retry`, async () => {
      const f = await insertionFixture();
      f.controller.addToDraft();
      await waitFor(() => f.requests.length === 1);
      const original = f.requests[0];
      f.send(f.result({ outcome: 'refused', code }));
      await waitFor(() => f.lastDraft()?.phase === 'refused');
      expect(f.requests).toHaveLength(1);
      expect(f.lastDraft()?.action).toBe('insert');
      f.controller.addToDraft();
      await waitFor(() => f.requests.length === 2);
      expect(f.requests[1]?.id).not.toBe(original?.id);
      f.send(f.result({ outcome: 'inserted', code: 'none' }, original));
      await wait(20);
      expect(f.lastDraft()?.phase).toBe('inserting');
      f.send(f.result({ outcome: 'inserted', code: 'none' }));
      await waitFor(() => f.lastDraft()?.phase === 'inserted');
    });
  }

  test('timeout keeps the exact request; status check resends it and a late reply resolves it', async () => {
    const f = await insertionFixture();
    f.controller.addToDraft();
    await waitFor(() => f.requests.length === 1);
    const original = f.requests[0];
    f.send({ ...f.result({ outcome: 'inserted', code: 'none' }), requestId: crypto.randomUUID() });
    f.send({ ...f.result({ outcome: 'inserted', code: 'none' }), sessionId: crypto.randomUUID() });
    expect(f.lastDraft()?.phase).toBe('inserting');
    await waitFor(() => f.lastDraft()?.phase === 'uncertain', 16_000);
    expect(f.lastDraft()?.action).toBe('check');
    expect(f.requests).toHaveLength(1);
    f.controller.addToDraft();
    await waitFor(() => f.requests.length === 2);
    expect(f.requests[1]).toEqual(original);
    f.send(f.result({ outcome: 'inserted', code: 'none' }, original));
    await waitFor(() => f.lastDraft()?.phase === 'inserted');
    f.controller.addToDraft();
    expect(f.requests).toHaveLength(2);
  }, 20_000);

  for (const change of [
    'generation',
    'connection',
    'binding',
    'capability',
    'protocol',
    'detach',
  ] as const) {
    test(`${change} cannot revive completed upload insertion authority`, async () => {
      const f = await insertionFixture();
      const original = f.current();
      if (!original) throw new Error('No context');
      if (change === 'generation') f.context({ ...original, generation: {} });
      else if (change === 'connection') f.context({ ...original, connection: {} });
      else if (change === 'binding')
        f.context({ ...original, binding: { harness: 'claude', harnessSessionId: 'other' } });
      else if (change === 'capability') f.context({ ...original, capabilities: ['image_staging'] });
      else if (change === 'protocol') f.context({ ...original, protocolVersion: 2 });
      else {
        f.context(null);
        f.controller.disconnect();
      }
      f.controller.addToDraft();
      expect(f.lastDraft()?.phase).toBe('unavailable');
      f.context(original);
      f.controller.addToDraft();
      await wait(15);
      expect(f.requests).toHaveLength(0);
    });
  }

  test('original expiry cancels a pending result without resurrection', async () => {
    const f = await insertionFixture({ expiryMs: 120 });
    f.controller.addToDraft();
    await waitFor(() => f.requests.length === 1);
    await waitFor(() => f.lastDraft()?.phase === 'expired');
    f.send(f.result({ outcome: 'inserted', code: 'none' }));
    await wait(20);
    expect(f.lastDraft()?.phase).toBe('expired');
    f.controller.addToDraft();
    expect(f.requests).toHaveLength(1);
  });

  test('disconnect after confirmed insertion removes image-only Send permanently', async () => {
    const f = await insertionFixture();
    f.controller.addToDraft();
    await waitFor(() => f.requests.length === 1);
    f.send(f.result({ outcome: 'inserted', code: 'none' }));
    await waitFor(() => f.lastDraft()?.phase === 'inserted');
    f.controller.disconnect();
    expect(f.lastDraft()?.phase).toBe('unavailable');
    expect(f.controller.takeImageDraftForSend(crypto.randomUUID())).toBe(false);
    f.controller.addToDraft();
    expect(f.requests).toHaveLength(1);
  });

  test('explicit Send is consumed once and a repeated insertion result cannot revive it', async () => {
    const f = await insertionFixture();
    expect(f.controller.takeImageDraftForSend(crypto.randomUUID())).toBe(false);
    f.controller.addToDraft();
    await waitFor(() => f.requests.length === 1);
    expect(f.controller.takeImageDraftForSend(crypto.randomUUID())).toBe(false);
    const response = f.result({ outcome: 'inserted', code: 'none' });
    f.send(response);
    await waitFor(() => f.lastDraft()?.phase === 'inserted');
    const sendId = crypto.randomUUID();
    expect(f.controller.takeImageDraftForSend(sendId)).toBe(true);
    expect(f.controller.takeImageDraftForSend(crypto.randomUUID())).toBe(false);
    f.send(response);
    await wait(20);
    expect(f.lastDraft()?.phase).toBe('submitting');
    f.raw(
      JSON.stringify({
        type: 'ack',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ack: { messageId: sendId, state: 'delivered', timestamp: new Date().toISOString() },
      }),
    );
    await waitFor(() => f.lastDraft()?.phase === 'submitted');
    expect(f.controller.takeImageDraftForSend(crypto.randomUUID())).toBe(false);
    expect(f.otherRequests.map((request) => request.type)).toEqual([
      'image_upload_begin',
      'image_upload_chunk',
      'image_upload_complete',
    ]);
  });

  test('send timeout retains its deadline and only its delivered receipt releases the draft', async () => {
    const f = await insertionFixture();
    f.controller.addToDraft();
    await waitFor(() => f.requests.length === 1);
    f.send(f.result({ outcome: 'inserted', code: 'none' }));
    await waitFor(() => f.lastDraft()?.phase === 'inserted');
    const sendId = crypto.randomUUID();
    const expiry = f.lastDraft()?.expiresAt;
    expect(f.controller.canUpload).toBe(false);
    expect(f.controller.takeImageDraftForSend(sendId)).toBe(true);
    expect(f.controller.canUpload).toBe(false);
    const ack = (messageId: string, state = 'delivered') =>
      JSON.stringify({
        type: 'ack',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ack: { messageId, state, timestamp: new Date().toISOString() },
      });
    f.raw(ack(crypto.randomUUID()));
    f.raw(ack(sendId, 'sent'));
    await wait(20);
    expect(f.lastDraft()?.phase).toBe('submitting');
    await waitFor(() => f.lastDraft()?.phase === 'send_uncertain', 16_000);
    expect(f.lastDraft()?.expiresAt).toBe(expiry);
    expect(f.controller.canUpload).toBe(false);
    f.raw(ack(sendId));
    await waitFor(() => f.lastDraft()?.phase === 'submitted');
    expect(f.controller.canUpload).toBe(true);
    expect(f.requests).toHaveLength(1);
  }, 20_000);

  test('known session end expires the reference and dismiss cancels the local timer', async () => {
    const f = await insertionFixture({ expiryMs: 120 });
    f.controller.endSession(crypto.randomUUID());
    expect(f.lastDraft()?.phase).toBe('available');
    f.controller.endSession(SESSION_ID);
    expect(f.lastDraft()?.phase).toBe('expired');
    f.controller.dismiss();
    const count = f.states.length;
    await wait(150);
    expect(f.states).toHaveLength(count);
    expect(f.states.at(-1)).toEqual({ phase: 'idle' });
  });

  test('staging capability alone keeps the existing staging-only UI', async () => {
    const f = await insertionFixture({ caps: ['image_staging'] });
    expect(f.lastDraft()).toBeUndefined();
    f.controller.addToDraft();
    expect(f.requests).toHaveLength(0);
    expect(f.states.at(-1)).toEqual({ phase: 'staged', filename: 'fixture.png' });
  });

  for (const raw of ['duplicate', 'direction'] as const) {
    test(`strict insertion ingress closes on ${raw} with no result callback`, async () => {
      const f = await insertionFixture();
      f.controller.addToDraft();
      await waitFor(() => f.requests.length === 1);
      const text =
        raw === 'duplicate'
          ? encodeImageInsertionFrame(f.result({ outcome: 'inserted', code: 'none' })).replace(
              '"outcome":"inserted"',
              '"outcome":"inserted","outcome":"inserted"',
            )
          : encodeImageInsertionFrame(f.requests[0] as ImageInsertRequest);
      f.raw(text);
      await waitFor(() => f.client.connectionStatus === 'disconnected');
      expect(f.lastDraft()?.phase).not.toBe('inserted');
    });
  }
});
