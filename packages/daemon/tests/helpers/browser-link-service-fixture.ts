/** Owned real service/PTY/producer/stores and signed socket endpoints. No installed configuration. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createAuthResponse,
  createHello,
  createIdentity,
  createPong,
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
import { CAPABILITY_HEADER } from '../../src/auth/capability-token.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
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
export async function browserFixture(options: { tls?: boolean; installed?: boolean } = {}) {
  const files = directTlsFixture();
  const trust = new IdentityStore(join(files.home, 'auth'));
  await trust.generate();
  const authenticator = new Authenticator({ identity: await trust.unlock(), identityStore: trust });
  const registry = new SessionRegistry();
  const bindings = new SessionBindingStore(new SessionStore(join(files.home, 'sessions.json')));
  let sessionId: string = randomUUID();
  let bindingId: string = randomUUID();
  let context: BrowserLinkProducerContext = {
    sessionId,
    binding: { harness: 'claude', harnessSessionId: bindingId },
    runtime: {},
  };
  const ptys: PTYSession[] = [];
  const sockets: WebSocket[] = [];
  const connectionIds: string[] = [];
  const pty = new PTYSession({
    command: '/bin/cat',
    cwd: files.work,
    env: files.env,
    size: { cols: 80, rows: 24 },
  });
  ptys.push(pty);
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
  const port = reservation.port as number;
  reservation.stop(true);
  const adapter = new WebSocketAdapter(
    {
      host: '127.0.0.1',
      port,
      authenticator,
      ...(options.tls !== false && { tls: files.tls }),
      capabilityToken: 'owned-browser-capability',
      ...(options.tls !== false && { localControl: { home: files.home } }),
    },
    {
      onConnect(id) {
        registry.attachConnection(sessionId, id);
        connectionIds.push(id);
      },
      onDisconnect(id) {
        registry.detachConnection(id);
        service?.forgetConnection(id);
      },
      ...(options.installed !== false && {
        onBrowserLinkReceiver(id: string, request: BrowserLinkReceiverRequest) {
          service.handleReceiver(id, request);
        },
      }),
    },
  );
  const service = new BrowserLinkService({
    identityStore: trust,
    sessions: registry,
    bindings,
    directAdapter: () => adapter,
    producerContextFor: (id) => (id === sessionId ? context : null),
  });
  const producer = new BrowserLinkProducerRuntime({
    context,
    temporaryRoot: '/Volumes/S1/yooz/remi/t',
    offer: (captured, url) => service.offer(captured, url),
  });
  await producer.start();
  await adapter.start();
  const identity = await unlockIdentity(await createIdentity());
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
    if (extra.freshKey) await trust.addAuthorizedKey(ownIdentity.publicKeyRaw, 'owned other peer');
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
        ...(extra.capability && { [CAPABILITY_HEADER]: 'owned-browser-capability' }),
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
    const replacement = new PTYSession({
      command: '/bin/cat',
      cwd: files.work,
      env: files.env,
      size: { cols: 80, rows: 24 },
    });
    ptys.push(replacement);
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
  async function close() {
    service.close();
    producer.retire();
    for (const ws of sockets) ws.close();
    await adapter.stop();
    for (const p of ptys) await p.close();
    await producer.close();
    files.cleanup();
  }
  return {
    files,
    trust,
    registry,
    bindings,
    sessionId,
    pty,
    adapter,
    port,
    service,
    producer,
    identity,
    client,
    rotate,
    switchSession,
    context: () => context,
    close,
  };
}
export type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;
