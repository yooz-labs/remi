/** Actual isolated signed WSS, registry, binding, launch capture and zero-input PTY. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type TerminalViewBinding,
  type TerminalViewMessage,
  type TerminalViewRequest,
  createAuthResponse,
  createHello,
  createIdentity,
  createPong,
  decodeTerminalViewFrame,
  encodeTerminalViewFrame,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter.ts';
import { MessageAPI } from '../../src/api/message-api.ts';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import type { WebSocketServer } from '../../src/server/websocket-server.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TerminalCaptureHost } from '../../src/terminal/capture-host.ts';
import { TerminalViewService } from '../../src/terminal/view-service.ts';
import { until } from './browser-link-service-fixture.ts';
import { directTlsFixture } from './direct-tls-fixture.ts';
import { terminalPacketPeer } from './terminal-packet-peer.ts';

export { until };
export async function terminalServiceFixture(
  options: {
    harness?: 'claude' | 'codex';
    tls?: boolean;
    files?: ReturnType<typeof directTlsFixture>;
    deferredCapture?: boolean;
    size?: { cols: number; rows: number };
    initialOutput?: string;
    childPrefix?: string;
    onOutput?: (data: string) => void;
    messageApiFactory?: (registry: SessionRegistry, sessionId: string) => MessageAPI;
  } = {},
) {
  const files = options.files ?? directTlsFixture();
  const prefix = options.childPrefix ?? join(files.home, 'terminal-child');
  const sessionId = randomUUID();
  const sockets: { close(): void }[] = [];
  const packetPeers: ReturnType<typeof terminalPacketPeer>[] = [];
  const registry = new SessionRegistry();
  const bindings = new SessionBindingStore(new SessionStore(join(files.home, 'sessions.json')));
  const capture = new TerminalCaptureHost(files.home);
  let runtime: object = {};
  let binding: TerminalViewBinding = {
    harness: options.harness ?? 'claude',
    harnessSessionId: randomUUID(),
  };
  let service: TerminalViewService | undefined;
  let adapter: WebSocketAdapter | undefined;
  let exited = false;
  const pty = new PTYSession(
    {
      command: process.execPath,
      args: [
        ...(Bun.main.startsWith('/$bunfs/')
          ? []
          : ['--no-env-file', resolve(import.meta.dir, 'terminal-output-child.ts')]),
        '--owned-output-child',
        prefix,
        options.initialOutput ?? 'FIRST\x1b[6n',
      ],
      cwd: files.work,
      env: files.env,
      size: options.size ?? { cols: 40, rows: 4 },
    },
    {
      ...(options.onOutput && { onData: options.onOutput }),
      onExit: () => {
        exited = true;
      },
    },
  );
  const assign = () =>
    bindings.preAssign({
      remiSessionId: sessionId,
      harness: binding.harness,
      claudeSessionId: binding.harness === 'claude' ? binding.harnessSessionId : null,
      ...(binding.harness === 'codex' && { harnessSessionId: binding.harnessSessionId }),
      projectPath: files.work,
      port: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
  async function launch() {
    assert.equal(pty.sessionState, 'created', 'owned fixture starts its actual PTY once');
    assert(await capture.prepare(sessionId, pty));
    await pty.start();
    await until(() => fs.existsSync(`${prefix}.ready`), 'actual output child ready');
  }
  async function waitForSnapshot() {
    await until(() => {
      const frame = capture.contextFor(sessionId)?.borrow();
      frame?.release();
      return !!frame;
    }, 'actual launch snapshot ready');
  }
  async function close() {
    const errors: unknown[] = [];
    service?.close();
    try {
      await until(() => {
        for (const packet of packetPeers) if (packet.hasPendingPong()) packet.confirmPong();
        const records = service
          ? (Reflect.get(service, 'records') as Map<object, { slot: { busy: boolean } }>)
          : new Map<object, { slot: { busy: boolean } }>();
        return [...records.values()].every((record) => !record.slot.busy);
      }, 'owned service native receipts settle before socket cleanup');
    } catch (error) {
      errors.push(error);
    }
    for (const ws of sockets) ws.close();
    try {
      await adapter?.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await pty.close(1000);
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!(await capture.closeAll())) errors.push(new Error('Owned capture cleanup uncertain'));
    } catch (error) {
      errors.push(error);
    }
    if (pty.childPid !== null) {
      try {
        assert(exited && !pty.isRunning, 'owned PTY exited');
        assert.throws(() => process.kill(pty.childPid as number, 0), { code: 'ESRCH' });
        assert.equal(
          JSON.parse(fs.readFileSync(`${prefix}.input`, 'utf8')).inputBytes,
          0,
          'service writes zero actual PTY input',
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Owned terminal service evidence retained: ${files.directory}`,
      );
    files.cleanup();
  }
  try {
    const trust = new IdentityStore(join(files.home, 'auth'));
    if (!trust.load()) await trust.generate();
    const authenticator = new Authenticator({
      identity: await trust.unlock(),
      identityStore: trust,
    });
    if (!options.deferredCapture) await launch();
    const messageApi =
      options.messageApiFactory?.(registry, sessionId) ?? new MessageAPI({ sessionId });
    registry.registerSession(sessionId, files.work, pty, messageApi, true);
    assign();
    if (!options.deferredCapture) await waitForSnapshot();
    const connectionIds: string[] = [];
    const actualAdapter = new WebSocketAdapter(
      {
        port: 0,
        host: '127.0.0.1',
        authenticator,
        ...(options.tls !== false && { tls: files.tls }),
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
        onTerminalView(id, ingress) {
          service?.handle(id, ingress);
        },
      },
    );
    adapter = actualAdapter;
    service = new TerminalViewService({
      identityStore: trust,
      sessions: registry,
      bindings,
      capture,
      directAdapter: () => actualAdapter,
      runtimeFor: (id) => (id === sessionId ? runtime : undefined),
    });
    const core = service;
    await actualAdapter.start();
    const server = Reflect.get(actualAdapter, 'server') as WebSocketServer;
    const identity = await unlockIdentity(await createIdentity());
    await trust.addAuthorizedKey(identity.publicKeyRaw, 'owned terminal peer');
    async function client(freshKey = false, holdNativeReceipt = false) {
      const ownIdentity = freshKey ? await unlockIdentity(await createIdentity()) : identity;
      if (freshKey)
        await trust.addAuthorizedKey(ownIdentity.publicKeyRaw, 'owned second terminal peer');
      const start = connectionIds.length;
      assert(!holdNativeReceipt || options.tls !== false, 'packet receipt peer requires real TLS');
      const packet = holdNativeReceipt ? terminalPacketPeer(server.port, files.ca) : null;
      if (packet) packetPeers.push(packet);
      const ws =
        packet ??
        new WebSocket(
          `${options.tls === false ? 'ws' : 'wss'}://127.0.0.1:${server.port}/ws`,
          options.tls === false ? undefined : ({ tls: { ca: files.ca } } as never),
        );
      sockets.push(ws);
      const received: { type: string; [key: string]: unknown }[] = [];
      const frames: TerminalViewMessage[] = [];
      let failure: unknown;
      let helloId: string | undefined;
      ws.onmessage = async (event: { data: unknown }) => {
        try {
          const text = String(event.data);
          const message = JSON.parse(text);
          received.push(message);
          const terminal = decodeTerminalViewFrame(text);
          if (terminal) frames.push(terminal);
          if (message.type === 'auth_challenge') {
            assert.equal(message.serverPublicKey, trust.load()?.publicKey);
            ws.send(
              serialize(
                createAuthResponse(
                  ownIdentity.publicKeyRaw,
                  await sign(ownIdentity.privateKey, fromBase64(message.challenge)),
                  ownIdentity.fingerprint,
                ),
              ),
            );
          } else if (message.type === 'auth_result' && message.success) {
            const hello = createHello(randomUUID(), 'owned terminal test');
            helloId = hello.id;
            ws.send(serialize(hello));
          } else if (message.type === 'ping') ws.send(serialize(createPong(message.id)));
        } catch (error) {
          failure = error;
        }
      };
      ws.onerror = () => {
        failure = new Error('Owned terminal socket failed');
      };
      await until(
        () =>
          failure !== undefined ||
          (connectionIds.length > start &&
            received.some(
              (frame) =>
                frame.type === 'ack' &&
                (frame['ack'] as { messageId?: string } | undefined)?.messageId === helloId,
            )),
        'actual signed terminal peer',
      );
      if (failure !== undefined) throw failure;
      // The normal hello ACK precedes terminal ingress; terminal assertions start here.
      received.length = 0;
      const id = connectionIds[start];
      assert(id);
      const common = () => ({ id: randomUUID(), timestamp: new Date().toISOString(), sessionId });
      const open = (): TerminalViewRequest => ({
        ...common(),
        type: 'session_terminal_open',
        binding: { ...binding },
      });
      const read = (viewId: string, afterRevision: number | null = null): TerminalViewRequest => ({
        ...common(),
        type: 'session_terminal_read',
        viewId,
        afterRevision,
      });
      const finish = (viewId: string): TerminalViewRequest => ({
        ...common(),
        type: 'session_terminal_close',
        viewId,
      });
      async function submit(request: TerminalViewRequest) {
        ws.send(encodeTerminalViewFrame(request));
        await until(
          () => frames.some((frame) => 'requestId' in frame && frame.requestId === request.id),
          'strict terminal response',
        );
        const response = frames.find(
          (frame) => 'requestId' in frame && frame.requestId === request.id,
        );
        assert(response);
        return response;
      }
      return {
        id,
        ws,
        packet,
        identity: ownIdentity,
        frames,
        received,
        open,
        read,
        finish,
        submit,
        connection: () => actualAdapter.getDirectConnection(id),
      };
    }
    return {
      files,
      prefix,
      pty,
      trust,
      capture,
      registry,
      bindings,
      adapter: actualAdapter,
      server,
      service: core,
      sessionId,
      connectionIds,
      client,
      async startCapture() {
        await launch();
        await waitForSnapshot();
      },
      binding: () => binding,
      rotateBinding() {
        binding = { ...binding, harnessSessionId: randomUUID() };
        assign();
      },
      rotateRuntime() {
        runtime = {};
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Terminal service startup failed');
    }
    throw error;
  }
}
export type TerminalServiceFixture = Awaited<ReturnType<typeof terminalServiceFixture>>;
