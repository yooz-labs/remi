/** Real signed socket, identity/binding stores, registry and CodexHarness; upstream is an owned replay server. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
import { WebSocketAdapter } from '../../../src/adapters/websocket-adapter';
import { MessageAPI } from '../../../src/api/message-api';
import { Authenticator } from '../../../src/auth/authenticator';
import { IdentityStore } from '../../../src/auth/identity-store';
import { createInputHandlers } from '../../../src/cli/handlers/input-events';
import { StructuredChatService } from '../../../src/cli/handlers/structured-chat-events';
import { CodexHarness } from '../../../src/harness/codex/codex';
import { AnswerDeliveryUncertainError } from '../../../src/harness/decision';
import { SessionBindingStore } from '../../../src/session/session-binding-store';
import { SessionRegistry } from '../../../src/session/session-registry';
import { SessionRegistryFile } from '../../../src/session/session-registry-file';
import { SessionStore } from '../../../src/session/session-store';
import { withInterprocessFileLockNonblocking } from '../../../src/storage/interprocess-file-lock';
import { FakeAppServer } from '../../helpers/fake-app-server';
import { findTestPort, pollUntil } from '../../integration/hub-test-utils';

test('an async-answer commit owns the current signed grant, attachment, binding and runtime at its exact effect', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'remi-question-auth-')));
  const server = FakeAppServer.start();
  const registry = new SessionRegistry();
  const store = new SessionStore(join(root, 'sessions.json'));
  const bindings = new SessionBindingStore(store);
  const trust = new IdentityStore(join(root, 'auth'));
  const sessionId = generateId();
  const threadId = generateId();
  const port = await findTestPort();
  const live = new SessionRegistryFile(join(root, 'live'));
  const api = new MessageAPI(
    { sessionId },
    { onQuestion: (q) => registry.addQuestion(sessionId, q) },
  );
  mkdirSync(live.dirPath);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'codex'), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 });
  const session = new CodexHarness({
    sessionRegistry: registry,
    sessionStore: store,
    bindingStore: bindings,
    liveSessionsRegistry: live,
    currentPort: () => port,
    wsPort: () => port,
    cleanup: () => new Promise<void>(() => {}),
    env: () => ({ CODEX_HOME: server.codexHome }),
    legacyWriters: () => [],
    remiVersion: 'test',
    onQuestionResolved: () => {},
    log: () => {},
  }).createSession({
    sessionId,
    workingDirectory: root,
    extraArgs: ['resume', threadId],
    passThrough: false,
    reservedRows: 0,
    messageApi: api,
    sendAndRecord: () => {},
    sendMessage: () => {},
  });
  registry.registerSession(sessionId, root, session.pty, api, true);
  const originalPath = process.env['PATH'];
  let adapter: WebSocketAdapter | undefined;
  let service: StructuredChatService | undefined;
  const sockets: WebSocket[] = [];
  try {
    process.env['PATH'] = `${join(root, 'bin')}:/usr/bin:/bin`;
    server.createRollout(threadId);
    await session.start();
    process.env['PATH'] = originalPath;
    await pollUntil(() => session.structuredChat?.context() != null, 5000, 'owned Codex context');
    await trust.generate();
    const device = await createIdentity();
    const unlocked = await unlockIdentity(device);
    await trust.addAuthorizedKey(device.publicKey, 'owned question control');
    const admitted = Promise.withResolvers<UUID>();
    adapter = new WebSocketAdapter(
      {
        host: '127.0.0.1',
        port,
        authenticator: new Authenticator({ identity: await trust.unlock(), identityStore: trust }),
      },
      {
        onConnect(id) {
          registry.attachConnection(sessionId, id);
          admitted.resolve(id);
        },
        onDisconnect(id) {
          registry.detachConnection(id);
        },
      },
    );
    service = new StructuredChatService({
      identityStore: trust,
      sessions: registry,
      bindings,
      harnessFor: (id) => (id === sessionId ? session : undefined),
      directAdapter: () => adapter,
    });
    await adapter.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    ws.onmessage = async (event) => {
      const message = deserialize(String(event.data));
      if (message?.type === 'auth_challenge')
        ws.send(
          serialize(
            createAuthResponse(
              device.publicKey,
              await sign(unlocked.privateKey, fromBase64(message.challenge)),
              device.fingerprint,
            ),
          ),
        );
      else if (message?.type === 'auth_result') {
        expect(message.success).toBe(true);
        ws.send(serialize(createHello(generateId(), 'test')));
      } else if (message?.type === 'ping') ws.send(serialize(createPong(message.id)));
    };
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    let id: UUID;
    try {
      id = await Promise.race([
        admitted.promise,
        new Promise<never>((_, reject) => {
          admissionTimer = setTimeout(() => reject(new Error('Signed admission deadline')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(admissionTimer);
    }
    let effects = 0;
    const effect = () => {
      effects++;
      return 'sent';
    };
    const initial = service.decisionCommit(id, sessionId);
    expect(initial).not.toBeNull();
    expect(
      initial?.(() => {
        expect(() =>
          withInterprocessFileLockNonblocking(join(root, 'auth', 'authorized_keys.json'), () => {}),
        ).toThrow();
        return effect();
      }),
    ).toEqual({ kind: 'committed', value: 'sent' });

    const detached = service.decisionCommit(id, sessionId);
    registry.detachConnection(id);
    registry.attachConnection(sessionId, id);
    expect(detached?.(effect)).toEqual({ kind: 'refused' });

    const rotated = service.decisionCommit(id, sessionId);
    bindings.updateHarnessIdentity(sessionId, 'codex', generateId());
    expect(rotated?.(effect)).toEqual({ kind: 'refused' });
    bindings.updateHarnessIdentity(sessionId, 'codex', threadId);

    const revoked = service.decisionCommit(id, sessionId);
    trust.removeAuthorizedKey(device.fingerprint);
    await trust.addAuthorizedKey(device.publicKey, 'new grant');
    expect(revoked?.(effect)).toEqual({ kind: 'refused' });

    const busy = service.decisionCommit(id, sessionId);
    withInterprocessFileLockNonblocking(join(root, 'auth', 'authorized_keys.json'), () => {
      expect(busy?.(effect)).toEqual({ kind: 'refused' });
    });
    const throwing = service.decisionCommit(id, sessionId);
    expect(() =>
      throwing?.(() => {
        throw new Error('possible effect');
      }),
    ).toThrow('possible effect');
    expect(service.decisionCommit(generateId(), sessionId)).toBeNull();

    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore: bindings,
      send: () => true,
      answerHeld: (_sid, qid, answer, commit) => session.decisions.answerHeld(qid, answer, commit),
      prepareAnswerCommit: (cid, sid) => service?.decisionCommit(cid, sid) ?? null,
    });
    server.onRequest('thread/read', () => ({
      thread: {
        id: threadId,
        ephemeral: false,
        parentThreadId: null,
        status: { type: 'active', activeFlags: [] },
      },
    }));
    const turnId = generateId();
    server.onRequest('thread/turns/list', () => ({
      data: [{ id: turnId, status: 'inProgress' }],
      nextCursor: null,
    }));
    server.ignore('turn/steer');
    server.emit(
      {
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: {
            type: 'agentMessage',
            id: 'call_authority_question',
            delivery: 'async',
            text: 'input',
            phase: 'commentary',
            questions: [{ title: 'Which route?', options: ['Local', 'Relay'] }],
          },
        },
      },
      { broadcast: true },
    );
    await pollUntil(
      () => registry.getSession(sessionId)?.currentQuestions.size === 1,
      5000,
      'real harness question card',
    );
    const questionId = [...(registry.getSession(sessionId)?.currentQuestions.keys() ?? [])][0];
    if (!questionId) throw new Error('Missing owned question');
    const ended = service.decisionCommit(id, sessionId);
    const selection = { selections: [{ questionIndex: 0, optionIndices: [0] }] };
    const pending = Promise.allSettled([
      handlers.onAnswer(id, sessionId, questionId, '', undefined, selection),
      handlers.onAnswer(id, sessionId, questionId, '', undefined, selection),
    ]);
    await server.waitFor(
      () => server.received.some((row) => row.frame['method'] === 'turn/steer'),
      'submitted answer before link loss',
    );
    for (const client of server.clientIds()) server.dropClient(client);
    const lost = await pending;
    expect(lost).toHaveLength(2);
    for (const result of lost) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(AnswerDeliveryUncertainError);
    }
    expect(registry.getQuestion(sessionId, questionId)).toBeNull();
    expect(await handlers.onAnswer(id, sessionId, questionId, '', undefined, selection)).toBe(
      'stale',
    );
    expect(server.received.filter((row) => row.frame['method'] === 'turn/steer')).toHaveLength(1);
    session.dispose();
    expect(ended?.(effect)).toEqual({ kind: 'refused' });
    expect(effects).toBe(1);
  } finally {
    process.env['PATH'] = originalPath;
    service?.close();
    for (const ws of sockets) ws.close();
    await adapter?.stop();
    session.dispose();
    if (session.pty.isRunning) session.pty.signal('SIGKILL');
    await registry.shutdown();
    await server.stop();
    await pollUntil(() => !session.pty.isRunning, 5000, 'owned inert child exit');
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
