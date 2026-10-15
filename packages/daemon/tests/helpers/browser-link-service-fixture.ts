/** Owned real service/PTY/producer/stores and signed socket endpoints. No installed configuration. */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AckMessage,
  createAuthResponse,
  createHello,
  createHelloAck,
  createIdentity,
  createPong,
  createSessionListResponse,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import {
  type BrowserLinkMessage,
  type BrowserLinkReceiverRequest,
  decodeBrowserLinkFrame,
  encodeBrowserLinkFrame,
} from '../../../shared/src/browser-links.ts';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter.ts';
import { MessageAPI } from '../../src/api/message-api.ts';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { CAPABILITY_HEADER, loadOrCreateCapabilityToken } from '../../src/auth/capability-token.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { buildSessionList } from '../../src/cli/handlers/session-list-entries.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import {
  type BrowserLinkProducerContext,
  BrowserLinkProducerRuntime,
} from '../../src/tunnel/browser-link-producer.ts';
import { BrowserLinkService } from '../../src/tunnel/browser-link-service.ts';
import { directTlsFixture } from './direct-tls-fixture.ts';

export async function until(check: () => boolean, label: string, timeout = 3000): Promise<void> {
  const end = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= end) throw new Error(`Owned browser timeout: ${label}`);
    await Bun.sleep(5);
  }
}
export interface BrowserFixtureResources {
  readonly files: ReturnType<typeof directTlsFixture>;
  readonly ptys: readonly PTYSession[];
  readonly consumerExits: readonly Promise<void>[];
  readonly adapter: WebSocketAdapter;
  readonly service: BrowserLinkService;
  readonly producer: BrowserLinkProducerRuntime;
}

export async function browserFixture(
  options: {
    tls?: boolean;
    installed?: boolean;
    port?: number;
    relay?: boolean;
    observe?: (owned: BrowserFixtureResources) => void;
  } = {},
) {
  const files = directTlsFixture();
  const ptys: PTYSession[] = [];
  const consumerExits = new Map<PTYSession, Promise<void>>();
  const sockets: WebSocket[] = [];
  const owned: {
    adapter?: WebSocketAdapter;
    service?: BrowserLinkService;
    producer?: BrowserLinkProducerRuntime;
    reservation?: ReturnType<typeof Bun.serve> | undefined;
  } = {};
  async function close(cleanup: { preserveFiles?: boolean } = {}) {
    const errors: unknown[] = [];
    // Retire synchronously before the first await, preserving the launcher until actual exit.
    try {
      owned.producer?.retire();
    } catch (error) {
      errors.push(error);
    }
    const attempt = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => owned.service?.close());
    for (const ws of sockets) await attempt(() => ws.close());
    await attempt(() => owned.reservation?.stop(true));
    await attempt(() => owned.adapter?.stop());
    for (const pty of ptys) await attempt(() => pty.close());
    const consumersEnded = ptys.every(
      (pty) => pty.childPid === null || pty.sessionState === 'exited',
    );
    if (consumersEnded) {
      await attempt(() =>
        Promise.all(
          ptys.filter((pty) => pty.childPid !== null).map((pty) => consumerExits.get(pty)),
        ),
      );
      await attempt(() => owned.producer?.close());
      if (!cleanup.preserveFiles) await attempt(() => files.cleanup());
    } else {
      // A failed consumer close does not authorize removing its still-needed launcher/profile.
      errors.push(new Error('Owned browser consumers have not ended'));
    }
    if (errors.length) throw new AggregateError(errors, 'Owned browser fixture cleanup failed');
  }
  try {
    const trust = new IdentityStore(join(files.home, 'auth'));
    await trust.generate();
    const relayAuthority = new SecurePushStore(files.home, trust);
    const capability = options.relay
      ? loadOrCreateCapabilityToken(join(files.home, 'capability.key'))
      : 'owned-browser-capability';
    const authenticator = new Authenticator({
      identity: await trust.unlock(),
      identityStore: trust,
    });
    const registry = new SessionRegistry();
    const bindings = new SessionBindingStore(new SessionStore(join(files.home, 'sessions.json')));
    const transcriptDiscovery = new TranscriptDiscovery({
      projectsDir: join(files.userHome, '.claude', 'projects'),
    });
    let sessionId: string = randomUUID();
    let bindingId: string = randomUUID();
    let context: BrowserLinkProducerContext = {
      sessionId,
      binding: { harness: 'claude', harnessSessionId: bindingId },
      runtime: {},
    };
    const connectionIds: string[] = [];
    function createPTY() {
      let resolve!: () => void;
      const exited = new Promise<void>((done) => {
        resolve = done;
      });
      const pty = new PTYSession(
        {
          command: '/bin/cat',
          cwd: files.work,
          env: files.env,
          size: { cols: 80, rows: 24 },
        },
        { onExit: () => resolve() },
      );
      ptys.push(pty);
      consumerExits.set(pty, exited);
      return pty;
    }
    const pty = createPTY();
    await pty.start();
    registry.registerSession(sessionId, files.work, pty, new MessageAPI({ sessionId }), true);
    bindings.preAssign({
      remiSessionId: sessionId,
      claudeSessionId: bindingId,
      projectPath: files.work,
      port: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
    const reservation = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('owned browser port reservation'),
    });
    owned.reservation = reservation;
    const port = options.port ?? (reservation.port as number);
    reservation.stop(true);
    owned.reservation = undefined;
    const adapter = new WebSocketAdapter(
      {
        host: '127.0.0.1',
        port,
        authenticator,
        ...(options.tls !== false && { tls: files.tls }),
        capabilityToken: capability,
        ...(options.tls !== false && { localControl: { home: files.home } }),
      },
      {
        onConnect(id) {
          registry.attachConnection(sessionId, id);
          connectionIds.push(id);
          if (options.relay)
            adapter.sendRaw(
              id,
              createHelloAck('owned', sessionId, {
                attachState: 'attached',
                binding: {
                  identity: { harness: 'claude', harnessSessionId: bindingId },
                  transcriptPath: null,
                },
                capabilities: service.isAvailable(id) ? ['browser_links'] : [],
              }),
            );
        },
        onDisconnect(id) {
          registry.detachConnection(id);
          service?.forgetConnection(id);
        },
        ...(options.relay && {
          onSessionListRequest(id: string, requestId: string, includeExternal: boolean) {
            const { own, external } = buildSessionList(
              {
                sessionRegistry: registry,
                bindingStore: bindings,
                transcriptDiscovery,
                harness: { transcriptPath: () => null },
              },
              includeExternal,
            );
            adapter.sendRaw(id, createSessionListResponse([...own, ...external], requestId));
          },
        }),
        ...(options.installed !== false && {
          onBrowserLinkReceiver(id: string, request: BrowserLinkReceiverRequest) {
            service.handleReceiver(id, request);
          },
        }),
      },
    );
    owned.adapter = adapter;
    const service = new BrowserLinkService({
      identityStore: trust,
      sessions: registry,
      bindings,
      directAdapter: () => adapter,
      producerContextFor: (id) => (id === sessionId ? context : null),
      ...(options.relay && { relayAuthority }),
    });
    owned.service = service;
    const producer = new BrowserLinkProducerRuntime({
      context,
      temporaryRoot: tmpdir(),
      offer: (captured, url) => service.offer(captured, url),
    });
    owned.producer = producer;
    await producer.start();
    options.observe?.({
      files,
      ptys,
      consumerExits: [...consumerExits.values()],
      adapter,
      service,
      producer,
    });
    await adapter.start();
    const storedIdentity = await createIdentity();
    const identity = await unlockIdentity(storedIdentity);
    await trust.addAuthorizedKey(identity.publicKeyRaw, 'owned browser peer');
    async function client(
      extra: {
        capability?: boolean;
        private?: boolean;
        freshKey?: boolean;
        headers?: Record<string, string>;
      } = {},
    ) {
      const ownIdentity = extra.freshKey ? await unlockIdentity(await createIdentity()) : identity;
      if (extra.freshKey)
        await trust.addAuthorizedKey(ownIdentity.publicKeyRaw, 'owned other peer');
      const previous = connectionIds.length;
      const endpoint = extra.private
        ? JSON.parse(await Bun.file(join(files.home, 'local-endpoints', `${port}.json`)).text())
            .privatePort
        : port;
      const secure = !extra.private && options.tls !== false;
      const ws = new WebSocket(`${secure ? 'wss' : 'ws'}://127.0.0.1:${endpoint}/ws`, {
        ...(secure && { tls: { ca: files.ca } }),
        headers: {
          ...extra.headers,
          ...(extra.capability && { [CAPABILITY_HEADER]: capability }),
        },
      } as never);
      sockets.push(ws);
      const received: { type: string; code?: string; [key: string]: unknown }[] = [];
      const browser: BrowserLinkMessage[] = [];
      let failure = false;
      ws.onopen = () => {
        if (extra.capability) ws.send(serialize(createHello(randomUUID(), 'test')));
      };
      ws.onmessage = async (event) => {
        try {
          const raw = String(event.data);
          const message = JSON.parse(raw);
          received.push(message);
          const decoded = decodeBrowserLinkFrame(raw);
          if (decoded) browser.push(decoded);
          if (message.type === 'auth_challenge') {
            if (message.serverPublicKey !== trust.load()?.publicKey)
              throw new Error('Owned server pin refused');
            ws.send(
              serialize(
                createAuthResponse(
                  ownIdentity.publicKeyRaw,
                  await sign(ownIdentity.privateKey, fromBase64(message.challenge)),
                  ownIdentity.fingerprint,
                ),
              ),
            );
          } else if (message.type === 'auth_result' && message.success)
            ws.send(serialize(createHello(randomUUID(), 'test')));
          else if (message.type === 'ping') ws.send(serialize(createPong(message.id)));
        } catch {
          failure = true;
        }
      };
      ws.onerror = () => {
        failure = true;
      };
      await until(() => failure || connectionIds.length > previous, 'signed peer');
      if (failure) throw new Error('Owned browser peer failed');
      const id = connectionIds[previous] as string;
      const request = (
        seq: number,
        action: 'select' | 'release' = 'select',
        patch: Partial<BrowserLinkReceiverRequest> = {},
      ): BrowserLinkReceiverRequest => ({
        type: 'browser_link_receiver_request',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId,
        binding: { harness: 'claude', harnessSessionId: bindingId },
        seq,
        action,
        ...patch,
      });
      async function submit(value: BrowserLinkReceiverRequest) {
        const start = browser.length;
        ws.send(encodeBrowserLinkFrame(value));
        await until(
          () =>
            browser
              .slice(start)
              .some((m) => m.type === 'browser_link_receiver_result' && m.requestId === value.id),
          'receiver result',
        );
        return browser
          .slice(start)
          .find(
            (m) => m.type === 'browser_link_receiver_result' && m.requestId === value.id,
          ) as Extract<BrowserLinkMessage, { type: 'browser_link_receiver_result' }>;
      }
      return {
        id,
        ws,
        received,
        browser,
        identity: ownIdentity,
        request,
        submit,
        connection: () => adapter.getDirectConnection(id),
      };
    }
    async function rotate(nextBinding: string = randomUUID(), marker: object = {}) {
      service.invalidateSession(sessionId);
      bindings.update(sessionId, nextBinding);
      bindingId = nextBinding;
      context = {
        sessionId,
        binding: { harness: 'claude', harnessSessionId: nextBinding },
        runtime: marker,
      };
      producer.rotate(context);
    }
    async function switchSession(nextId: string = randomUUID()) {
      const current = registry.getSession(sessionId);
      if (current) await current.pty.close();
      registry.handlePTYExit(sessionId);
      service.invalidateSession(sessionId);
      sessionId = nextId;
      bindingId = randomUUID();
      const replacement = createPTY();
      await replacement.start();
      registry.registerSession(
        sessionId,
        files.work,
        replacement,
        new MessageAPI({ sessionId }),
        true,
      );
      bindings.preAssign({
        remiSessionId: sessionId,
        claudeSessionId: bindingId,
        projectPath: files.work,
        port: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      context = {
        sessionId,
        binding: { harness: 'claude', harnessSessionId: bindingId },
        runtime: {},
      };
      producer.rotate(context);
      for (const id of connectionIds)
        if (adapter.getDirectConnection(id)?.isConnected) registry.attachConnection(sessionId, id);
      return sessionId;
    }
    return {
      files,
      trust,
      relayAuthority,
      registry,
      bindings,
      sessionId,
      pty,
      adapter,
      port,
      service,
      producer,
      identity,
      storedIdentity,
      client,
      rotate,
      switchSession,
      context: () => context,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, ...(cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError])],
        'Owned browser fixture startup cleanup failed',
      );
    }
    throw error;
  }
}
export type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;

/** Owned actual child; shape grants no device or transfer authority. */
export interface OwnedRelayChild {
  readonly files: { readonly home: string; readonly work: string };
  readonly trust: IdentityStore;
  readonly identity: import('@remi/shared').UnlockedIdentity;
  readonly storedIdentity: import('@remi/shared').RemiIdentity;
  readonly sessionId: string;
  readonly port: number;
  readonly pid?: number;
  close(): Promise<unknown>;
}
/** Full owned Worker/Hub/child transport; caller supplies the real child authority owner. */
export async function relayMachineFixture<T extends OwnedRelayChild>(
  f: T,
  additionalDevices: readonly import('@remi/shared').UnlockedIdentity[] = [],
) {
  let worker: import('../../../signaling/tests/e2e/harness.ts').TestWorker | undefined;
  let relay: import('../../src/remote/hub-relay.ts').HubRelay | undefined;
  const peers: {
    socket: import('../../../signaling/tests/e2e/endpoints.ts').Socket;
    channel?: import('@remi/shared').relayV2.Channel;
  }[] = [];
  const logs: string[] = [];
  const authorityFaults: string[] = [];
  type CloseReceipt = Awaited<ReturnType<T['close']>>;
  let closeTask: Promise<CloseReceipt> | undefined;
  function close(): Promise<CloseReceipt> {
    const existing = closeTask;
    if (existing) return existing;
    const task: Promise<CloseReceipt> = (async (): Promise<CloseReceipt> => {
      const errors: unknown[] = [];
      const attempt = async (fn: () => unknown) => {
        try {
          await fn();
        } catch (e) {
          errors.push(e);
        }
      };
      for (const peer of peers) await attempt(() => peer.socket.close());
      await attempt(() => relay?.stop());
      for (const peer of peers) await attempt(() => peer.channel?.transportClosed());
      await attempt(() => worker?.stop());
      let result: unknown;
      await attempt(async () => {
        result = await f.close();
      });
      if (errors.length) throw new AggregateError(errors, 'Owned relay browser cleanup failed');
      return result as CloseReceipt;
    })();
    closeTask = task;
    return task;
  }
  try {
    const [
      { relayV2, deserialize },
      { Socket, admit, clientUrl },
      { startWorker },
      { HubRelay },
      { RelayDeviceStore },
      { SessionRegistryFile },
    ] = await Promise.all([
      import('@remi/shared'),
      import('../../../signaling/tests/e2e/endpoints.ts'),
      import('../../../signaling/tests/e2e/harness.ts'),
      import('../../src/remote/hub-relay.ts'),
      import('../../src/remote/relay-device-store.ts'),
      import('../../src/session/session-registry-file.ts'),
    ]);
    worker = await startWorker();
    const machineIdentity = await f.trust.unlock();
    const devices = new RelayDeviceStore(f.files.home, f.trust);
    await devices.add(f.identity.publicKeyRaw, 'owned relay');
    for (const device of additionalDevices) {
      await f.trust.addAuthorizedKey(device.publicKeyRaw, 'owned additional relay');
      await devices.add(device.publicKeyRaw, 'owned additional relay');
    }
    const registry = new SessionRegistryFile(join(f.files.home, 'live'));
    registry.register({
      sessionId: f.sessionId,
      pid: f.pid ?? process.pid,
      wsPort: f.port,
      hookPort: 1,
      projectPath: f.files.work,
      name: 'owned',
      startedAt: new Date().toISOString(),
    });
    relay = new HubRelay(
      {
        relayUrl: worker.wsUrl,
        identity: machineIdentity,
        trust: f.trust,
        dir: f.files.home,
        registry,
        log: (message) => {
          logs.push(message);
          if (message.includes('InterprocessFileLockError') && authorityFaults.length < 4)
            authorityFaults.push(
              new Error('Owned actual authority caller').stack
                ?.split('\n')
                .slice(0, 16)
                .join('\n') ?? 'Owned stack unavailable',
            );
        },
      },
      {
        onSessionListRequest(id, requestId) {
          // This hub owns no session; actual child lists are aggregated by HubRelay.
          relay?.sendRaw(id, createSessionListResponse([], requestId));
        },
      },
    );
    await relay.start();
    await until(() => logs.includes('Relay control admitted'), 'real relay control', 10000);
    const machinePublicKey = new Uint8Array(Buffer.from(machineIdentity.publicKeyRaw, 'base64'));
    const rid = await relayV2.ridOf(machinePublicKey);
    async function connect(device = f.identity) {
      const signer = await relayV2.signerFromKey(
        device.privateKey,
        new Uint8Array(Buffer.from(device.publicKeyRaw, 'base64')),
      );
      if (!worker) throw Error('Owned relay Worker unavailable');
      const socket = await Socket.open(clientUrl(worker, Buffer.from(rid).toString('hex')));
      const peer: (typeof peers)[number] = { socket };
      peers.push(peer); // Own before any handshake await.
      await admit(socket, { signer, publicKey: signer.publicKey }, 'client', rid);
      await socket.json();
      await socket.json();
      const start = await relayV2.clientStart(
        { machinePublicKey, device: signer, mode: 'resume', random: relayV2.systemRandom },
        Date.now(),
      );
      socket.sendText(start.hello);
      const auth = await start.onHelloAck(await socket.text(), Date.now());
      socket.sendText(auth.auth);
      const channel = await auth.onReady(await socket.text(), Date.now(), {
        emit: (bytes) => socket.sendBinary(bytes),
        close: (code) => socket.close(code),
      });
      peer.channel = channel;
      // Shipping manager initializes the sessionless hub before selecting a child.
      const initialHubControl: Uint8Array[] = [];
      const hubHello = createHello('owned-machine', 'T4');
      await channel.send(new TextEncoder().encode(serialize(hubHello)));
      const hubDeadline = performance.now() + 3000;
      let hubHelloAcknowledgment: AckMessage | undefined;
      for (let i = 0; i < 64; i++) {
        const bytes = await channel.receive(
          await socket.binary(Math.max(1, hubDeadline - performance.now())),
        );
        if (!bytes) throw Error('Owned relay closed before machine hello acknowledgment');
        const control = deserialize(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        );
        if (control?.type === 'ack' && control.ack.messageId === hubHello.id) {
          if (control.ack.state !== 'delivered') throw Error('Owned machine hello not delivered');
          hubHelloAcknowledgment = control;
          break;
        }
        // These units are already opened; never replay ciphertext through the channel.
        initialHubControl.push(bytes);
        if (performance.now() >= hubDeadline) break;
      }
      if (!hubHelloAcknowledgment) throw Error('Owned machine hello acknowledgment absent');
      return {
        socket,
        channel,
        machineHello: { requestId: hubHello.id, acknowledgment: hubHelloAcknowledgment },
        send: (message: Parameters<typeof serialize>[0]) =>
          channel.send(new TextEncoder().encode(serialize(message))),
        next: async (timeoutMs = 3000) => {
          for (let i = 0; i < 8; i++) {
            const bytes =
              initialHubControl.shift() ?? (await channel.receive(await socket.binary(timeoutMs)));
            if (!bytes) throw Error('Owned relay closed before browser result');
            const message = deserialize(
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
            );
            if (message && message.type !== 'ack') return message;
          }
          throw Error('Owned relay application bound');
        },
      };
    }
    function observeChildFrames() {
      const rows: {
        order: number;
        at: number;
        type: string | null;
        id: string | null;
        bytes: number;
      }[] = [];
      if (!relay) throw Error('Owned relay unavailable');
      const current = Reflect.get(relay, 'peers') as Map<
        string,
        { proxy?: { children: Map<string, { ws: WebSocket }> } }
      >;
      for (const peer of current.values()) {
        const children =
          peer.proxy &&
          (Reflect.get(peer.proxy, 'children') as Map<string, { ws: WebSocket }> | undefined);
        if (!children) continue;
        for (const child of children.values())
          child.ws.addEventListener('message', (event) => {
            if (rows.length >= 16) return;
            const raw = event.data;
            let type: string | null = null;
            let id: string | null = null;
            const bytes =
              typeof raw === 'string'
                ? Buffer.byteLength(raw)
                : raw instanceof ArrayBuffer
                  ? raw.byteLength
                  : ArrayBuffer.isView(raw)
                    ? raw.byteLength
                    : raw instanceof Blob
                      ? raw.size
                      : 0;
            if (typeof raw === 'string' && bytes <= 65536)
              try {
                const value = JSON.parse(raw);
                type = typeof value.type === 'string' ? value.type.slice(0, 96) : null;
                id = typeof value.id === 'string' ? value.id.slice(0, 96) : null;
              } catch {}
            rows.push({ order: rows.length + 1, at: performance.now(), type, id, bytes });
          });
      }
      return rows;
    }
    return {
      ...f,
      worker,
      relay,
      logs,
      authorityFaults,
      observeChildFrames,
      liveRegistry: registry,
      machineIdentity,
      machinePublicKey,
      rid,
      deviceIdentity: f.storedIdentity,
      connect,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Owned relay browser startup cleanup failed');
    }
    throw error;
  }
}

/** Existing browser wrapper retains its child, generated identity and cleanup API. */
export async function relayBrowserFixture(
  additionalDevices: readonly import('@remi/shared').UnlockedIdentity[] = [],
) {
  const f = await browserFixture({ relay: true, tls: false });
  return relayMachineFixture(f, additionalDevices);
}
