/** Real owned signed raw-route components; production CLI/scoped-hello acceptance is separate. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  type FileDownloadIngressResult,
  type FileDownloadMessage,
  createAuthResponse,
  createHello,
  createHelloAck,
  createIdentity,
  createPong,
  createSessionListResponse,
  decodeFileDownloadFrame,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
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
import { FileDownloadService } from '../../src/tunnel/file-download-service.ts';
import { Reservations } from '../../src/tunnel/reservations.ts';
import { relayMachineFixture, until } from './browser-link-service-fixture.ts';
import { directTlsFixture } from './direct-tls-fixture.ts';
export { until };
export interface FileDownloadIngressResources {
  readonly files: ReturnType<typeof directTlsFixture>;
  readonly pty: PTYSession;
  readonly consumerExit: Promise<void>;
  readonly adapter: WebSocketAdapter;
  readonly service: FileDownloadService;
}

export async function makeFileDownloadIngressFixture(
  options: {
    tls?: boolean;
    relay?: boolean;
    installed?: boolean;
    harness?: 'claude' | 'codex';
    callbackFailure?: boolean | 'async';
    port?: number;
    observe?: (owned: FileDownloadIngressResources) => void;
  } = {},
) {
  const files = directTlsFixture();
  const sockets: WebSocket[] = [];
  const output: Buffer[] = [];
  const connectionIds: string[] = [];
  const invocations: Exclude<FileDownloadIngressResult, { kind: 'uncorrelatable' }>[] = [];
  const pending = new Set<Promise<void>>();
  let adapter: WebSocketAdapter | undefined;
  let service: FileDownloadService | undefined;
  let pty: PTYSession | undefined;
  let consumerEnded = false;
  let reservation: ReturnType<typeof Bun.serve> | undefined;
  const lifecycleErrors: unknown[] = [];
  let consumerExit: Promise<void> | undefined;
  async function close() {
    const errors: unknown[] = [];
    let settled = !service;
    const attempt = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(async () => {
      if (service) settled = await service.close();
    });
    for (const ws of sockets) await attempt(() => ws.close());
    await attempt(() => adapter?.stop());
    await attempt(() => reservation?.stop(true));
    await attempt(() => pty?.close());
    if (pty && pty.childPid !== null && consumerExit) {
      if (pty.sessionState === 'exited') await attempt(() => consumerExit);
      else errors.push(new Error('Owned raw consumer did not exit'));
    }
    await attempt(() => Promise.all(pending));
    errors.push(...lifecycleErrors);
    if (!settled) errors.push(new Error('Owned download debt remains charged'));
    if (settled && (!pty || consumerEnded || pty.childPid === null))
      await attempt(() => files.cleanup());
    else if (!consumerEnded) errors.push(new Error('Owned raw download consumer remains'));
    if (errors.length)
      throw new AggregateError(errors, 'Owned raw download fixture cleanup failed');
  }
  try {
    const trust = new IdentityStore(options.relay ? files.home : join(files.home, 'auth'));
    await trust.generate();
    const relayAuthority = new SecurePushStore(files.home, trust);
    const capability = options.relay
      ? loadOrCreateCapabilityToken(join(files.home, 'capability.key'))
      : 'owned-download-capability';
    const authenticator = new Authenticator({
      identity: await trust.unlock(),
      identityStore: trust,
    });
    const registry = new SessionRegistry();
    const transcriptDiscovery = new TranscriptDiscovery({
      projectsDir: join(files.userHome, '.claude', 'projects'),
    });
    const sessionId = randomUUID();
    const binding = { harness: options.harness ?? 'claude', harnessSessionId: randomUUID() };
    consumerExit = new Promise<void>((resolve) => {
      pty = new PTYSession(
        { command: '/bin/cat', cwd: files.work, env: files.env },
        {
          onRawData: (data) => output.push(Buffer.from(data)),
          onExit: () => {
            consumerEnded = true;
            resolve();
          },
        },
      );
    });
    if (!pty) throw new Error('Owned raw PTY missing');
    const ownedPTY = pty;
    await pty.start();
    registry.registerSession(sessionId, files.work, pty, new MessageAPI({ sessionId }), true);
    const bindings = new SessionBindingStore(new SessionStore(join(files.home, 'sessions.json')));
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
    const protectedPath = join(files.directory, 'protected');
    fs.mkdirSync(protectedPath, { mode: 0o700 });
    let context = { runtime: pty as object, protectedRootPaths: [protectedPath] };
    reservation = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('owned raw held port'),
    });
    const port = options.port ?? (reservation.port as number);
    reservation.stop(true);
    reservation = undefined;
    adapter = new WebSocketAdapter(
      {
        host: '127.0.0.1',
        port,
        authenticator,
        capabilityToken: capability,
        ...(options.tls !== false && { tls: files.tls, localControl: { home: files.home } }),
      },
      {
        onConnect(id) {
          registry.attachConnection(sessionId, id);
          connectionIds.push(id);
          if (options.relay)
            adapter?.sendRaw(
              id,
              createHelloAck('owned', sessionId, {
                attachState: 'attached',
                binding: { identity: binding, transcriptPath: null },
                capabilities: service?.isAvailable(id) ? ['file_download'] : [],
              }),
            );
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
            adapter?.sendRaw(id, createSessionListResponse([...own, ...external], requestId));
          },
        }),
        onDisconnect(id) {
          const work = service?.invalidateConnection(id);
          if (work) {
            pending.add(work);
            void work.then(
              () => pending.delete(work),
              (error) => {
                pending.delete(work);
                lifecycleErrors.push(error);
              },
            );
          }
          registry.detachConnection(id);
        },
        ...(options.installed !== false && {
          onFileDownload(
            id: string,
            ingress: Exclude<FileDownloadIngressResult, { kind: 'uncorrelatable' }>,
          ) {
            invocations.push(ingress);
            if (options.callbackFailure === 'async')
              return Promise.reject(new Error('Owned callback failure must stay private'));
            if (options.callbackFailure)
              throw new Error('Owned callback failure must stay private');
            if (!service) throw new Error('Owned service missing');
            if (ingress.kind === 'request') return service.handle(id, ingress.request);
            service.refuseMalformed(id, ingress.correlation);
          },
        }),
      },
    );
    const realAdapter = adapter;
    service = await FileDownloadService.open({
      home: files.home,
      identityStore: trust,
      sessions: registry,
      bindings,
      directAdapter: () => realAdapter,
      contextFor: (id) => (id === sessionId ? context : null),
      ...(options.relay && { relayAuthority }),
    });
    const core = service;
    options.observe?.({ files, pty: ownedPTY, consumerExit, adapter: realAdapter, service: core });
    await adapter.start();
    const storedIdentity = await createIdentity();
    const identity = await unlockIdentity(storedIdentity);
    await trust.addAuthorizedKey(identity.publicKeyRaw, 'owned download peer');
    async function client(
      extra: {
        private?: boolean;
        capability?: boolean;
        unsigned?: boolean;
        headers?: Record<string, string>;
      } = {},
    ) {
      const endpoint = extra.private
        ? JSON.parse(fs.readFileSync(join(files.home, 'local-endpoints', `${port}.json`), 'utf8'))
            .privatePort
        : port;
      const secure = !extra.private && options.tls !== false;
      const ws = new WebSocket(`${secure ? 'wss' : 'ws'}://127.0.0.1:${endpoint}/ws`, {
        ...(secure && { tls: { ca: files.ca } }),
        headers: { ...extra.headers, ...(extra.capability && { [CAPABILITY_HEADER]: capability }) },
      } as never);
      sockets.push(ws);
      const frames: FileDownloadMessage[] = [];
      const received: {
        type: string;
        code?: string;
        id?: string;
        requestId?: string;
        ack?: { messageId: string };
      }[] = [];
      const before = connectionIds.length;
      let failed = false;
      let helloId = '';
      const hello = () => {
        const request = createHello(randomUUID(), 'owned');
        helloId = request.id;
        ws.send(serialize(request));
      };
      ws.onopen = () => {
        if (extra.capability) hello();
      };
      ws.onmessage = async (event) => {
        try {
          const raw = String(event.data);
          const message = JSON.parse(raw);
          received.push(message);
          const frame = decodeFileDownloadFrame(raw);
          if (frame) frames.push(frame);
          if (message.type === 'auth_challenge' && !extra.unsigned) {
            if (message.serverPublicKey !== trust.load()?.publicKey)
              throw new Error('Owned TLS server pin mismatch');
            ws.send(
              serialize(
                createAuthResponse(
                  identity.publicKeyRaw,
                  await sign(identity.privateKey, fromBase64(message.challenge)),
                  identity.fingerprint,
                ),
              ),
            );
          } else if (message.type === 'auth_result' && message.success) hello();
          else if (message.type === 'ping') ws.send(serialize(createPong(message.id)));
        } catch {
          failed = true;
        }
      };
      ws.onerror = () => {
        failed = true;
      };
      await until(
        () =>
          failed ||
          (extra.unsigned
            ? received.some((m) => m.type === 'auth_challenge')
            : connectionIds.length > before &&
              connectionIds[before] !== undefined &&
              registry.getSessionForConnection(connectionIds[before] as string)?.sessionId ===
                sessionId &&
              received.some((m) => m.type === 'ack' && m.ack?.messageId === helloId)),
        'actual raw peer',
      );
      if (failed) throw new Error('Owned raw peer failed');
      const id = connectionIds[before];
      received.length = 0;
      const envelope = () => ({ id: randomUUID(), timestamp: new Date().toISOString(), sessionId });
      const begin = (path = 'sample.bin') => ({
        ...envelope(),
        type: 'file_fetch_begin' as const,
        binding,
        relativePath: path,
      });
      async function send<T extends { id: string }>(
        request: T,
        raw: string | Uint8Array = JSON.stringify(request),
        responseBudget: 3000 | 10000 = 3000,
      ) {
        const state = () => {
          const connection = id ? realAdapter.getDirectConnection(id) : undefined;
          const native = connection && Reflect.get(connection, 'ws');
          const records = Reflect.get(core, 'records') as Set<{
            terminal: boolean;
            reason: string;
            preparationDone: boolean;
            cleanupConfirmed: boolean;
            poisoned: boolean;
            reading: boolean;
            sentBytes: number;
          }>;
          return {
            readyState: ws.readyState,
            clientBuffered: ws.bufferedAmount,
            serverBuffered: native?.bufferedAmount,
            connected: connection?.isConnected,
            transport: connection?.connectionListenerTransport,
            signed: !!connection?.connectionClientPublicKey,
            attached:
              id !== undefined && registry.getSessionForConnection(id)?.sessionId === sessionId,
            callbacks: invocations.length,
            frames: received.slice(-4).map((m) => ({ type: m.type, code: m.code })),
            records: [...records].slice(-4).map((r) => ({
              terminal: r.terminal,
              reason: r.reason,
              preparationDone: r.preparationDone,
              cleanupConfirmed: r.cleanupConfirmed,
              poisoned: r.poisoned,
              reading: r.reading,
              sentBytes: r.sentBytes,
            })),
          };
        };
        const beforeState = state();
        ws.send(raw);
        let timeout = false;
        try {
          await until(
            () =>
              frames.some((frame) => 'requestId' in frame && frame.requestId === request.id) ||
              ws.readyState === WebSocket.CLOSED ||
              received.some((m) => m.code === 'INVALID_MESSAGE'),
            'actual raw download response',
            responseBudget,
          );
        } catch {
          timeout = true;
        }
        const response = frames.find(
          (frame) => 'requestId' in frame && frame.requestId === request.id,
        );
        if (!response)
          throw new Error(
            `Actual raw download response missing: ${JSON.stringify({ timeout, before: beforeState, after: state() })}`,
          );
        return response;
      }
      return { ws, id, frames, received, envelope, begin, send };
    }
    return {
      close,
      pty: ownedPTY,
      consumerExit,
      port,
      url: `${options.tls === false ? 'ws' : 'wss'}://127.0.0.1:${port}/ws`,
      files,
      trust,
      identity,
      storedIdentity,
      relayAuthority,
      registry,
      bindings,
      binding,
      sessionId,
      adapter: realAdapter,
      service: core,
      client,
      invocations,
      output,
      ledger: () => new Reservations(join(files.home, 'image-staging', 'ledger')),
      replaceContext() {
        context = { runtime: {}, protectedRootPaths: [protectedPath] };
      },
      write(bytes: Buffer | string) {
        fs.writeFileSync(join(files.work, 'sample.bin'), bytes, { mode: 0o600 });
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Owned raw construction failed');
    }
    throw error;
  }
}

export type FileDownloadIngressFixture = Awaited<ReturnType<typeof makeFileDownloadIngressFixture>>;

/** Actual strict file service child behind the same owned relay machine transport. */
export async function relayFileDownloadFixture(options: { harness?: 'claude' | 'codex' } = {}) {
  const f = await makeFileDownloadIngressFixture({ ...options, tls: false, relay: true });
  return relayMachineFixture(f);
}
