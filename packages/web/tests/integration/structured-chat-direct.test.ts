/** Opt-in actual signed WebSocket -> service -> CodexHarness -> installed accountless server.
 * The harness PTY runs inert cat; this does not prove fresh native TUI/hub startup or model completion.
 */
import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChatSubmitRequest,
  type ChatSubmitResult,
  type ProtocolMessage,
  type UUID,
  createAuthResponse,
  createHello,
  createHelloAck,
  createIdentity,
  createPong,
  deserialize,
  fromBase64,
  generateId,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter';
import { MessageAPI } from '../../../daemon/src/api/message-api';
import { Authenticator } from '../../../daemon/src/auth/authenticator';
import { loadOrCreateCapabilityToken } from '../../../daemon/src/auth/capability-token';
import { IdentityStore } from '../../../daemon/src/auth/identity-store';
import { StructuredChatService } from '../../../daemon/src/cli/handlers/structured-chat-events';
import { AppServerClient } from '../../../daemon/src/harness/codex/app-server-client';
import { CodexHarness } from '../../../daemon/src/harness/codex/codex';
import { connectUnixWebSocket } from '../../../daemon/src/harness/codex/unix-ws';
import type { HarnessSession } from '../../../daemon/src/harness/types';
import { SecurePushStore } from '../../../daemon/src/notifications/secure-push-store';
import { SessionBindingStore } from '../../../daemon/src/session/session-binding-store';
import { SessionRegistry } from '../../../daemon/src/session/session-registry';
import { SessionRegistryFile } from '../../../daemon/src/session/session-registry-file';
import { SessionStore } from '../../../daemon/src/session/session-store';
import {
  InterprocessFileLockError,
  withInterprocessFileLockNonblocking,
} from '../../../daemon/src/storage/interprocess-file-lock';
import { findTestPort, pollUntil } from '../../../daemon/tests/integration/hub-test-utils';
import { StructuredChatController } from '../../src/lib/structured-chat';
import { WebSocketClient } from '../../src/lib/websocket-client';
import { runRelayChatControl } from '../helpers/structured-chat-relay';

const cli = process.env['REMI_CODEX_ACCOUNTLESS_CLI'];
const relayControl = process.env['REMI_CODEX_RELAY_CONTROL'] === '1';
(cli ? test : test.skip)(
  `actual ${relayControl ? 'encrypted relay' : 'direct'} route correlates one RPC, guarded commit, replay, rotation and revocation`,
  async () => {
    if (!cli?.startsWith('/'))
      throw new Error('An absolute accountless native Codex path is required');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cdx-d-')));
    chmodSync(root, 0o700);
    const state = join(root, 'c');
    const home = join(root, 'h');
    const cwd = join(root, 'p');
    const bin = join(root, 'bin');
    const socket = join(root, 's');
    for (const directory of [state, home, cwd, bin]) mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(state, 'app-server-control'), { mode: 0o700 });
    if (Buffer.byteLength(socket) > 100) {
      rmSync(root, { recursive: true });
      throw new Error('Use a shorter TMPDIR');
    }
    writeFileSync(
      join(state, 'config.toml'),
      'cli_auth_credentials_store = "file"\nsandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n',
      { mode: 0o600 },
    );
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 });
    const native = Bun.spawn(
      [cli, 'app-server', '--strict-config', '--listen', `unix://${socket}`],
      {
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          CODEX_HOME: state,
          TMPDIR: root,
          LANG: 'en_US.UTF-8',
        },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    const receipt = {
      accountPresent: true,
      nativePid: native.pid,
      nativeReaped: false,
      modelCompletion: false,
      inertPty: true,
      checks: [] as string[],
      logs: [] as string[],
      socketKinds: [] as unknown[],
      effects: 0,
      lockedEffects: 0,
      state: 'failed',
    };
    const observer = new AppServerClient(
      { socketPath: () => socket, clientInfo: { name: 'remi', title: null, version: 'test' } },
      () => {},
    );
    const registry = new SessionRegistry();
    const sessionStore = new SessionStore(join(root, 'sessions.json'));
    const binding = new SessionBindingStore(sessionStore);
    const trust = new IdentityStore(join(root, 'auth'));
    let session: HarnessSession | undefined;
    let adapter: WebSocketAdapter | undefined;
    let service: StructuredChatService | undefined;
    const sockets: WebSocket[] = [];
    let webClient: WebSocketClient | undefined;
    let webChat: StructuredChatController | undefined;
    let afterMetadata: (() => void) | null = null;
    const effects: { method: string; params: Record<string, unknown> }[] = [];
    const originalPath = process.env['PATH'];
    try {
      observer.start();
      await pollUntil(() => observer.state === 'ready', 5000, 'native server');
      // The installed CLI itself makes --listen a symlink. Match its production
      // one-hop layout, rather than introducing a second link the resolver refuses.
      symlinkSync(
        lstatSync(socket).isSymbolicLink() ? readlinkSync(socket) : socket,
        join(state, 'app-server-control', 'app-server-control.sock'),
      );
      for (const file of [socket, join(state, 'app-server-control', 'app-server-control.sock')]) {
        const stat = lstatSync(file);
        receipt.socketKinds.push({
          file,
          socket: stat.isSocket(),
          link: stat.isSymbolicLink(),
          target: stat.isSymbolicLink() ? readlinkSync(file) : null,
        });
      }
      const account = await observer.request<{ account: unknown }>('account/read', {
        refreshToken: false,
      });
      receipt.accountPresent = account.account !== null;
      expect(account.account).toBeNull();
      const started = await observer.request<{ thread: { id: string } }>('thread/start', {
        cwd,
        ephemeral: false,
      });
      const threadId = started.thread.id;
      const sessionId = generateId();
      const port = await findTestPort();
      const liveSessions = new SessionRegistryFile(join(root, 'live'));
      mkdirSync(liveSessions.dirPath);
      await trust.generate();
      const identity = await createIdentity();
      const unlocked = await unlockIdentity(identity);
      await trust.addAuthorizedKey(identity.publicKey, 'isolated route');
      const grantPath = join(root, 'auth', 'authorized_keys.json');
      const pending = new Map<number, string>();
      const historyRequests: Array<{ itemsView: unknown; limit: unknown }> = [];
      const harness = new CodexHarness({
        sessionRegistry: registry,
        sessionStore,
        bindingStore: binding,
        liveSessionsRegistry: liveSessions,
        currentPort: () => port,
        wsPort: () => port,
        cleanup: () => new Promise<void>(() => {}),
        env: () => ({ CODEX_HOME: state }),
        legacyWriters: () => [],
        remiVersion: 'test',
        onQuestionResolved: () => {},
        log: (text) => {
          receipt.logs.push(text);
        },
        appServer: {
          connect: async (address, handlers, options) => {
            const wire = await connectUnixWebSocket(
              address,
              {
                ...handlers,
                onMessage(text) {
                  const frame = JSON.parse(text);
                  if (
                    typeof frame.id === 'number' &&
                    pending.get(frame.id) === 'thread/read' &&
                    frame.result
                  ) {
                    const callback = afterMetadata;
                    afterMetadata = null;
                    callback?.();
                  }
                  handlers.onMessage(text);
                },
              },
              options,
            );
            return {
              get isOpen() {
                return wire.isOpen;
              },
              ping: (data) => wire.ping(data),
              close: (code) => wire.close(code),
              send(text) {
                const frame = JSON.parse(text);
                if (frame.method === 'thread/turns/list' && frame.params?.sortDirection === 'asc')
                  historyRequests.push({
                    itemsView: frame.params.itemsView,
                    limit: frame.params.limit,
                  });
                if (typeof frame.id === 'number') pending.set(frame.id, frame.method);
                if (frame.method === 'turn/start' || frame.method === 'turn/steer') {
                  effects.push({ method: frame.method, params: frame.params });
                  expect(existsSync(`${grantPath}.lock`)).toBe(true);
                  expect(() => withInterprocessFileLockNonblocking(grantPath, () => {})).toThrow(
                    InterprocessFileLockError,
                  );
                  receipt.lockedEffects++;
                }
                wire.send(text);
              },
            };
          },
        },
      });
      session = harness.createSession({
        sessionId,
        workingDirectory: cwd,
        extraArgs: ['resume', threadId],
        passThrough: false,
        reservedRows: 0,
        messageApi: new MessageAPI({ sessionId }),
        sendAndRecord: () => {},
        sendMessage: () => {},
      });
      registry.registerSession(sessionId, cwd, session.pty, new MessageAPI({ sessionId }), true);
      process.env['PATH'] = `${bin}:/usr/bin:/bin`;
      await session.start();
      process.env['PATH'] = originalPath;
      await pollUntil(
        () => session?.structuredChat?.context() !== null,
        5000,
        'live writer context',
      );
      expect(await session.chat?.readHistory(() => {})).toBe(0);
      receipt.checks.push('actual installed empty first-thread history uses the current turns API');
      const authenticator = new Authenticator({
        identity: await trust.unlock(),
        identityStore: trust,
      });
      let connected = Promise.withResolvers<UUID>();
      adapter = new WebSocketAdapter(
        {
          host: '127.0.0.1',
          port,
          authenticator,
          ...(relayControl
            ? { capabilityToken: loadOrCreateCapabilityToken(join(root, 'auth', 'capability.key')) }
            : {}),
        },
        {
          onConnect(id) {
            expect(registry.attachConnection(sessionId, id).success).toBe(true);
            adapter?.sendRaw(
              id,
              createHelloAck('1.0.0', sessionId, {
                binding: {
                  identity: { harness: 'codex', harnessSessionId: threadId },
                  transcriptPath: null,
                },
                attachState: 'attached',
                capabilities: service?.isAvailable(id) ? ['structured_chat'] : [],
              }),
            );
            connected.resolve(id);
          },
          onDisconnect(id) {
            registry.detachConnection(id);
            service?.forgetConnection(id);
          },
          onStructuredChat: async (id, request) => {
            if (!service || !adapter) throw new Error('Service unavailable');
            await service.handle(id, request, (result) => adapter?.sendRaw(id, result));
          },
        },
      );
      service = new StructuredChatService({
        identityStore: trust,
        relayAuthority: new SecurePushStore(join(root, 'auth'), trust),
        sessions: registry,
        bindings: binding,
        harnessFor: (id) => (id === sessionId ? session : undefined),
        directAdapter: () => adapter,
      });
      await adapter.start();
      if (relayControl) {
        receipt.checks.push(
          ...(await runRelayChatControl({
            directory: join(root, 'auth'),
            trust,
            identity: unlocked,
            sessionId,
            threadId,
            cwd,
            port,
            liveSessions,
            registry,
            adapter,
            service,
            effects: () => effects.length,
            onMetadata: (operation) => {
              afterMetadata = operation;
            },
            nextChildConnection: () => {
              connected = Promise.withResolvers<UUID>();
              return connected.promise;
            },
          })),
        );
        receipt.effects = effects.length;
        expect(receipt.lockedEffects).toBe(effects.length);
        receipt.state = 'passed';
        return;
      }
      async function client() {
        connected = Promise.withResolvers<UUID>();
        const messages: ProtocolMessage[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        sockets.push(ws);
        ws.onmessage = async (event) => {
          const message = deserialize(String(event.data));
          if (!message) return;
          messages.push(message);
          if (message.type === 'auth_challenge')
            ws.send(
              serialize(
                createAuthResponse(
                  identity.publicKey,
                  await sign(unlocked.privateKey, fromBase64(message.challenge)),
                  identity.fingerprint,
                ),
              ),
            );
          else if (message.type === 'auth_result') {
            expect(message.success).toBe(true);
            ws.send(serialize(createHello(generateId(), 'test')));
          } else if (message.type === 'ping') ws.send(serialize(createPong(message.id)));
        };
        const id = await connected.promise;
        return { id, ws, messages };
      }
      const owner = await client();
      expect(service.isAvailable(owner.id)).toBe(true);
      const request = (seq: number): ChatSubmitRequest => ({
        type: 'chat_submit_request',
        id: generateId(),
        timestamp: new Date().toISOString(),
        sessionId,
        seq,
        binding: { harness: 'codex', harnessSessionId: threadId },
        content: 'Reply only REMI_LOCAL_ROUTE. Use no tools.',
      });
      async function send(value: ChatSubmitRequest, binary = false): Promise<ChatSubmitResult> {
        const start = owner.messages.length;
        const text = serialize(value);
        owner.ws.send(binary ? new TextEncoder().encode(text) : text);
        await pollUntil(
          () =>
            owner.messages
              .slice(start)
              .some((m) => m.type === 'chat_submit_result' && m.requestId === value.id),
          10000,
          'correlated result',
        );
        const result = owner.messages
          .slice(start)
          .find(
            (m): m is ChatSubmitResult =>
              m.type === 'chat_submit_result' && m.requestId === value.id,
          );
        if (!result) throw new Error('Missing result');
        expect(result.seq).toBe(value.seq);
        expect(result.sessionId).toBe(sessionId);
        return result;
      }
      const first = request(1);
      const accepted = await send(first, true);
      expect(accepted).toMatchObject({ outcome: 'accepted', method: 'turn/start' });
      expect(effects).toHaveLength(1);
      const history: import('@remi/shared').TranscriptContentMessage[] = [];
      let historyCount = 0;
      const historyDeadline = Date.now() + 3000;
      do {
        history.length = 0;
        historyCount = (await session.chat?.readHistory((message) => history.push(message))) ?? 0;
        if (historyCount) break;
        await Bun.sleep(50);
      } while (Date.now() < historyDeadline);
      expect(historyCount).toBeGreaterThanOrEqual(1);
      expect(
        history.some((message) => message.role === 'user' && message.content === first.content),
      ).toBe(true);
      receipt.checks.push(
        'actual installed materialized full-turn history recovers submitted user text',
      );
      expect(effects[0]?.params).toEqual({
        threadId,
        clientUserMessageId: first.id,
        input: [{ type: 'text', text: first.content }],
      });
      expect(await send(first)).toEqual(accepted);
      expect(effects).toHaveLength(1);
      expect(await send({ ...first, content: 'Changed content' })).toMatchObject({
        outcome: 'uncertain',
        code: 'conflict',
      });
      expect(owner.messages.some((m) => m.type === 'ack' && m.ack.messageId === first.id)).toBe(
        false,
      );
      receipt.checks.push(
        'actual binary signed route, exact start, cached receipt, conflict, no generic ACK',
      );
      const wrong = request(2);
      expect(
        await send({ ...wrong, binding: { harness: 'codex', harnessSessionId: generateId() } }),
      ).toMatchObject({ outcome: 'refused', code: 'binding_changed' });
      expect(effects).toHaveLength(1);
      expect(await send(request(4))).toMatchObject({ outcome: 'refused', code: 'sequence' });
      const beforeDetach = effects.length;
      afterMetadata = () => {
        registry.detachConnection(owner.id);
        registry.attachConnection(sessionId, owner.id);
      };
      expect(await send(request(3))).toMatchObject({ outcome: 'refused', code: 'unavailable' });
      expect(effects).toHaveLength(beforeDetach);
      expect(await send(first)).toMatchObject({ outcome: 'uncertain', code: 'receipt_expired' });
      receipt.checks.push(
        'wrong binding and gap refused; real detach/reattach cancels queued write and cannot reset sequence',
      );
      afterMetadata = () => {
        trust.removeAuthorizedKey(identity.fingerprint);
      };
      expect(await send(request(4))).toMatchObject({ outcome: 'refused', code: 'unavailable' });
      expect(effects).toHaveLength(beforeDetach);
      expect(service.isAvailable(owner.id)).toBe(false);
      await trust.addAuthorizedKey(identity.publicKey, 'restored isolated route');
      expect(await send(first)).toMatchObject({ outcome: 'uncertain', code: 'receipt_expired' });
      expect(await send(request(5))).toMatchObject({ outcome: 'accepted' });
      expect(effects).toHaveLength(beforeDetach + 1);
      receipt.checks.push(
        'actual grant revocation blocks pending write; reauthorization does not revive old input',
      );
      expect(receipt.lockedEffects).toBe(effects.length);
      expect(session.acceptsTypedChat).toBe(false);

      // The shipping web transport/controller make a new signed concrete connection.
      owner.ws.close();
      await pollUntil(() => !adapter?.getDirectConnection(owner.id), 3000, 'old socket cleanup');
      connected = Promise.withResolvers<UUID>();
      const genericChat: ProtocolMessage[] = [];
      webClient = new WebSocketClient(
        { url: `ws://127.0.0.1:${port}/ws`, autoReconnect: false, heartbeatInterval: 0 },
        {
          onMessage(message) {
            if (message.type === 'chat_submit_result') genericChat.push(message);
            if (message.type === 'auth_challenge')
              void sign(unlocked.privateKey, fromBase64(message.challenge)).then((signature) =>
                webClient?.send(
                  createAuthResponse(identity.publicKey, signature, identity.fingerprint),
                ),
              );
            else if (message.type === 'auth_result')
              webClient?.send(createHello(generateId(), 'web route'));
            else if (message.type === 'hello_ack') webClient?.setConnected();
          },
          onStructuredChatResult: (message) => webChat?.receive(message),
          onStatusChange: (status) => {
            if (status !== 'connected') webChat?.disconnect();
          },
        },
      );
      webChat = new StructuredChatController({
        context: () => {
          const generation = webClient?.imageUploadGeneration;
          return generation ? { generation, sessionId, threadId } : null;
        },
        send: (value) => webClient?.sendStructuredChat(value) ?? false,
      });
      webClient.connect();
      const webId = await connected.promise;
      await pollUntil(() => webClient?.isConnected === true, 3000, 'web hello');
      const beforeWeb = effects.length;
      expect(
        await webChat.submit(sessionId, threadId, 'Reply only REMI_WEB_CONTROL. Use no tools.'),
      ).toMatchObject({ outcome: 'accepted' });
      expect(effects).toHaveLength(beforeWeb + 1);
      expect(genericChat).toEqual([]);
      service.close();
      expect(service.isAvailable(webId)).toBe(false);
      expect(await webChat.submit(sessionId, threadId, 'Continue.')).toMatchObject({
        outcome: 'refused',
        code: 'unavailable',
      });
      expect(effects).toHaveLength(beforeWeb + 1);
      receipt.checks.push(
        'actual signed WebSocketClient/controller admits once, dedicated result bypasses generic delivery, closed service refuses next input',
      );
      receipt.checks.push(
        'every actual RPC send owns the real grant lock; close refuses; typed chat remains disabled',
      );
      receipt.effects = effects.length;
      expect(historyRequests.length).toBeGreaterThan(0);
      expect(
        historyRequests.every((request) => request.itemsView === 'full' && request.limit === 1),
      ).toBe(true);
      const raw = serialize(request(1));
      for (const invalid of [
        raw.replace('{', '{"type":"chat_submit_request",'),
        serialize(accepted),
        new Uint8Array([...new TextEncoder().encode('{"type":"chat_submit_request",'), 255]),
      ]) {
        const invalidClient = await client();
        invalidClient.ws.send(invalid);
        await pollUntil(
          () => invalidClient.ws.readyState === WebSocket.CLOSED,
          3000,
          'strict invalid input close',
        );
        expect(effects).toHaveLength(receipt.effects);
      }
      receipt.checks.push(
        'actual signed text/binary sockets close duplicate members, wrong direction and invalid UTF-8 without an RPC',
      );
      receipt.state = 'passed';
    } finally {
      process.env['PATH'] = originalPath;
      webChat?.dispose();
      webClient?.disconnect();
      service?.close();
      for (const ws of sockets) ws.close();
      await adapter?.stop();
      session?.dispose();
      await session?.pty.close();
      await registry.shutdown();
      observer.stop();
      if (native.exitCode === null) native.kill('SIGTERM');
      const kill = setTimeout(() => {
        if (native.exitCode === null) native.kill('SIGKILL');
      }, 2000);
      await native.exited;
      clearTimeout(kill);
      try {
        process.kill(native.pid, 0);
      } catch {
        receipt.nativeReaped = true;
      }
      const output = process.env['REMI_CODEX_ACCOUNTLESS_RECEIPT'];
      if (output) writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      rmSync(root, { recursive: true });
      expect(receipt.nativeReaped).toBe(true);
    }
  },
  45000,
);
