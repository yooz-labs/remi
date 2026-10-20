/**
 * Approvals end to end through the Codex session (epic #1175, phase 4 #1178):
 * the first answer wins, and the card follows what Codex says.
 *
 * Nothing between the phone and the app-server is replaced: a real
 * `CodexHarness` session (`createCodexSession`) with its real PTY (a fake `codex`
 * that counts every byte on its stdin), the real `AppServerClient`,
 * `ThreadTracker` and `CodexDecisions`, a real `SessionRegistry`, the daemon's
 * own `createMessageApiForSession`, the real input handlers wired as `cli.ts`
 * wires them, and the `FakeAppServer` (a real WebSocket server replaying the
 * spike's frames) as the Codex peer. The whole daemon, with a real websocket
 * phone, is `integration/codex-launch-characterization.test.ts`.
 *
 * What is modeled, not verified: the fake keeps a request pending when a
 * subscriber drops (plan risk R1, live step LV-3(d)), replays it to the next
 * subscriber (spike: `expB3.jsonl:51`), and resolves it for everyone at the first
 * answer (spike: `expA-accept.jsonl:51` to `:53`). That Codex does the same is what
 * LV-3 checks; a passing test here is a claim about remi's client.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ProtocolMessage,
  type Question,
  type UUID,
  createQuestionResolved,
} from '@remi/shared';
import type {
  ErrorMessage,
  QuestionMessage,
  QuestionResolvedMessage,
} from '@remi/shared/protocol.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
  trackerScreenDeps,
} from '../../../src/cli/handlers/input-events.ts';
import { promptUpDeps } from '../../../src/cli/handlers/prompt-up.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { createMessageApiForSession } from '../../../src/cli/session-phases/message-api-setup.ts';
import type { CodexLaunchDeps } from '../../../src/harness/codex/codex-session.ts';
import { CodexHarness } from '../../../src/harness/codex/codex.ts';
import type { HarnessSession } from '../../../src/harness/types.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { CID } from '../../cli/handlers/menu-test-helpers.ts';
import {
  type Json,
  commandApprovalRequest,
  fileChangeRequest,
  threadStartedFrame,
  threadStatusFrame,
} from '../../helpers/codex-threads.ts';
import { FakeAppServer } from '../../helpers/fake-app-server.ts';

/** A fake `codex` that counts every byte on its stdin (raw mode, so a lone byte is seen at once). */
const FAKE_CODEX = `#!/bin/sh
d="$FAKE_CODEX_DIR"
exec 3<&0
stty raw -echo <&3 2>/dev/null
: > "$d/stdin"
cat <&3 >> "$d/stdin" &
reader=$!
i=0
while [ ! -e "$d/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
kill $reader 2>/dev/null
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('a Codex approval, from the app-server to the phone and back', () => {
  let tmpDir: string;
  let workDir: string;
  let fakeDir: string;
  let originalPath: string | undefined;
  let servers: FakeAppServer[];
  let launched: HarnessSession[];
  let registries: SessionRegistry[];

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-codex-approvals-')));
    workDir = path.join(tmpDir, 'work');
    fakeDir = path.join(tmpDir, 'fake');
    fs.mkdirSync(workDir);
    fs.mkdirSync(fakeDir);
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin', 'codex'), FAKE_CODEX);
    fs.chmodSync(path.join(tmpDir, 'bin', 'codex'), 0o755);
    // No real `codex` can resolve: the PATH is the fake plus the system directories.
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${path.join(tmpDir, 'bin')}:/usr/bin:/bin`;
    process.env['FAKE_CODEX_DIR'] = fakeDir;
    servers = [];
    launched = [];
    registries = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    fs.writeFileSync(path.join(fakeDir, 'release'), '');
    for (const session of launched) {
      if (session.pty.isRunning) session.pty.signal('SIGKILL');
      session.dispose();
    }
    for (const server of servers) await server.stop();
    for (const registry of registries) await registry.shutdown();
    __resetLoggerForTests();
    process.env['PATH'] = originalPath ?? '/usr/bin:/bin';
    Reflect.deleteProperty(process.env, 'FAKE_CODEX_DIR');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  interface Rig {
    server: FakeAppServer;
    session: HarnessSession;
    registry: SessionRegistry;
    sessionId: UUID;
    /** Everything the daemon sent to clients: cards, resolutions. */
    sent: ProtocolMessage[];
    /** What the real answer handler sent back to the phone over its connection. */
    errors: ErrorMessage[];
    logs: string[];
    handlers: ReturnType<typeof createInputHandlers>;
    /** The TUI's thread. */
    tuiId: string;
  }

  /** A launched, started and attached Codex session with a phone connected to it. */
  async function attached(over: Partial<CodexLaunchDeps> = {}): Promise<Rig> {
    const server = FakeAppServer.start();
    servers.push(server);
    const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registries.push(registry);
    const sessionId = registry.createSessionId();
    const sent: ProtocolMessage[] = [];
    const errors: ErrorMessage[] = [];
    const logs: string[] = [];
    const { messageApi } = createMessageApiForSession(
      {
        sessionRegistry: registry,
        transcriptWatchers: new Map(),
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:9' }),
        updateRemiStatus: () => {},
        maxBulletLength: 500,
        sendMessage: (_sid, message) => sent.push(message),
      },
      sessionId,
    );
    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    const deps: CodexLaunchDeps = {
      sessionRegistry: registry,
      sessionStore,
      bindingStore: new SessionBindingStore(sessionStore),
      liveSessionsRegistry,
      currentPort: () => 19999,
      wsPort: () => 19999,
      cleanup: () => new Promise<void>(() => {}),
      env: () => ({ CODEX_HOME: server.codexHome }),
      legacyWriters: () => [],
      remiVersion: 'test',
      onQuestionResolved: (sid, qid, reason, resolvedBy) =>
        sent.push(createQuestionResolved(sid, qid, reason, resolvedBy)),
      log: (m) => logs.push(m),
      appServer: { backoff: { initialMs: 10, maxMs: 40 } },
      tracker: { retryMs: 40, ambiguityMs: 100 },
      decisions: { replayWindowMs: 200, disconnectGraceMs: 800 },
      ...over,
    };
    const session = new CodexHarness(deps).createSession({
      sessionId,
      workingDirectory: workDir,
      extraArgs: [],
      passThrough: false,
      reservedRows: 0,
      messageApi,
      sendAndRecord: () => {},
      sendMessage: () => {},
    });
    launched.push(session);
    registry.registerSession(sessionId, workDir, session.pty, messageApi);
    registry.attachConnection(sessionId, CID);
    // The same wiring cli.ts builds for the input handlers.
    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore: deps.bindingStore,
      send: (_connectionId, message) => {
        if (message.type === 'error') errors.push(message);
        return true;
      },
      ...gateAnswerDeps(() => session.decisions),
      ...promptUpDeps(
        () => session.decisions,
        () => session.decisions.screen,
      ),
      acceptsTypedChat: () => session.acceptsTypedChat,
      // As cli.ts wires it (#1235): the handler says whether the answer applied, and from where.
      onQuestionResolved: (sid, qid, resolution) =>
        sent.push(createQuestionResolved(sid, qid, resolution.reason, resolution.resolvedBy)),
      ...trackerScreenDeps(() => session.decisions.screen),
    });
    await session.start();
    // The fake codex creates its stdin counter when it starts; wait for it so a count can be read.
    await until(() => fs.existsSync(path.join(fakeDir, 'stdin')), 'the fake codex to start');

    const tuiId = crypto.randomUUID();
    await until(() => server.clientIds().length === 1, 'the client to connect');
    server.emit(threadStartedFrame('tui', { id: tuiId, cwd: workDir, createdAtSec: nowSec() }), {
      broadcast: true,
    });
    server.createRollout(tuiId);
    await until(() => logs.some((l) => l.includes('attached to thread')), 'the attach');
    return { server, session, registry, sessionId, sent, errors, logs, handlers, tuiId };
  }

  /** A command approval of the TUI thread, running in the session's own directory (as Codex's would). */
  const commandRequest = (r: Rig, command: string, over: Record<string, unknown> = {}) =>
    commandApprovalRequest(r.tuiId, command, { cwd: workDir, ...over });
  const cards = (r: Rig): QuestionMessage[] =>
    r.sent.filter((m): m is QuestionMessage => m.type === 'question');
  const resolved = (r: Rig): QuestionResolvedMessage[] =>
    r.sent.filter((m): m is QuestionResolvedMessage => m.type === 'question_resolved');
  const pending = (r: Rig): Question[] => [
    ...(r.registry.getSession(r.sessionId)?.currentQuestions.values() ?? []),
  ];
  /** The answers the daemon's client sent to the app-server, with the connection that carried each. */
  const answersSent = (r: Rig): Array<{ client: number; frame: Json }> =>
    r.server.received.filter((f) => f.frame['method'] === undefined && 'id' in f.frame);
  /** The system messages the daemon sent the clients, as text (a notice is a structured message). */
  const systemNotices = (r: Rig): string[] =>
    r.sent
      .filter((m) => m.type === 'structured_agent_output')
      .map((m) => JSON.stringify((m as { message: unknown }).message))
      .filter((text) => text.includes('"sender":"system"'));
  const stdinBytes = (): number => fs.statSync(path.join(fakeDir, 'stdin')).size;
  /**
   * Nothing was typed so far, and the counter can move: a person's raw keystroke does reach the
   * fake codex (a zero count alone would also read zero for a counter that is stuck, or checked
   * before a late write).
   */
  async function expectNothingTyped(r: Rig): Promise<void> {
    expect(stdinBytes()).toBe(0);
    await r.handlers.onUserInput(CID, r.sessionId, 'q', true);
    await until(() => stdinBytes() === 1, 'the raw control byte to reach the fake codex');
  }
  const answer = (r: Rig, q: Question, text: string) =>
    r.handlers.onAnswer(CID, r.sessionId, q.id, text, undefined, undefined);
  const cancel = (r: Rig, q: Question) =>
    r.handlers.onAnswer(CID, r.sessionId, q.id, '', undefined, { cancel: true });

  test('the phone accepts first: the app-server gets accept, resolves the request, and the card is gone with nothing typed', async () => {
    const r = await attached();
    await until(() => fs.existsSync(path.join(fakeDir, 'stdin')), 'the fake codex');
    const id = r.server.request(commandRequest(r, 'touch phone-first'), r.tuiId);
    // The real app-server's first request id is 0 (verified live), and the card and its answer carry it.
    expect(id).toBe(0);
    await until(() => pending(r).length === 1, 'the card');
    const card = pending(r)[0] as Question;
    expect(card.held).toBe(true);
    // The command runs in the session's own directory, so the card does not name one.
    expect(card.text).toBe('Allow Codex to run: touch phone-first');
    expect(card.detail).toBeUndefined();
    expect(cards(r)).toHaveLength(1);

    await answer(r, card, 'Yes');
    await until(() => !r.server.isPending(r.tuiId, id), 'the request to be resolved');
    expect(answersSent(r).map((a) => a.frame)).toEqual([
      { jsonrpc: '2.0', id, result: { decision: 'accept' } },
    ]);
    // The app-server's own `serverRequest/resolved` reaches the session; nothing is dismissed twice.
    await sleep(150);
    expect(pending(r)).toEqual([]);
    expect(resolved(r).map((m) => [m.questionId, m.reason])).toEqual([[card.id, 'answered']]);
    expect(r.errors).toEqual([]);
    await expectNothingTyped(r);
  });

  test('a pending card keeps its id across many ping cycles when the server answers every ping with two pongs, and its answer still works (Q1)', async () => {
    // Codex 0.160.0 answers every ping with two pongs (verified live, 2026-10-04). With the
    // client's old keepalive the link dropped about every 70 s and a pending card was re-created
    // with a new id each time.
    const r = await attached({
      appServer: {
        backoff: { initialMs: 10, maxMs: 40 },
        keepalive: { intervalMs: 40, timeoutMs: 160 },
      },
    });
    r.server.doublePong();
    const connections = r.server.clientIds();
    expect(connections).toHaveLength(1);
    const id = r.server.request(commandRequest(r, 'touch idle-marker'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    const card = pending(r)[0] as Question;
    await until(() => r.server.pingsReceived() >= 8, 'eight ping cycles');
    // Past the timeout of a leaked pong timer.
    await sleep(350);
    expect(r.server.clientIds(), 'the same connection, never a reconnect').toEqual(connections);
    expect(r.logs.some((l) => l.includes('link lost') || l.includes('no pong'))).toBe(false);
    expect(pending(r).map((q) => q.id)).toEqual([card.id]);
    expect(cards(r)).toHaveLength(1);
    expect(resolved(r)).toEqual([]);
    expect(r.server.isPending(r.tuiId, id)).toBe(true);
    await answer(r, card, 'Yes');
    await until(() => !r.server.isPending(r.tuiId, id), 'the request to be resolved');
    expect(answersSent(r).map((a) => a.frame)).toEqual([
      { jsonrpc: '2.0', id, result: { decision: 'accept' } },
    ]);
  });

  test('an answer Codex never confirms tells the person to check the session (this one has no terminal: remi attach), and the card is already gone', async () => {
    const r = await attached({
      decisions: { replayWindowMs: 200, disconnectGraceMs: 800, confirmMs: 300 },
    });
    const id = r.server.request(commandRequest(r, 'touch never-confirmed'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    const card = pending(r)[0] as Question;
    r.server.ignoreAnswers();

    await answer(r, card, 'Yes');
    // Delivered: the phone reads "answered" and the card is gone, as it must for a real answer.
    await until(() => answersSent(r).length === 1, 'the answer to reach the server');
    expect(pending(r)).toEqual([]);
    expect(systemNotices(r)).toEqual([]);
    await until(() => systemNotices(r).length === 1, 'the notice that Codex has not confirmed');
    expect(systemNotices(r)[0]).toContain(
      'Codex has not confirmed the answer; check the session with `remi attach <host>:',
    );
    // Codex never resolved it: the request is still waiting, and remi did not claim otherwise twice.
    expect(r.server.isPending(r.tuiId, id)).toBe(true);
    await expectNothingTyped(r);
    expect(systemNotices(r)).toHaveLength(1);
  });

  test('a confirmed answer sends no notice', async () => {
    const r = await attached({
      decisions: { replayWindowMs: 200, disconnectGraceMs: 800, confirmMs: 300 },
    });
    const id = r.server.request(commandRequest(r, 'touch confirmed'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    await answer(r, pending(r)[0] as Question, 'Yes');
    await until(() => !r.server.isPending(r.tuiId, id), 'the request to be resolved');
    // Longer than the confirmation delay: a timer that survived the resolved would have fired.
    await sleep(900);
    expect(systemNotices(r)).toEqual([]);
  });

  test('a command that runs in another directory says so on its card, and the app is where it is approved', async () => {
    const r = await attached();
    r.server.request(
      commandRequest(r, 'touch elsewhere-marker', { cwd: '/somewhere/else' }),
      r.tuiId,
    );
    await until(() => pending(r).length === 1, 'the card');
    const card = pending(r)[0] as Question;
    expect(card.text).toBe(
      'Allow Codex to run: touch elsewhere-marker\nIn directory: /somewhere/else',
    );
    expect(card.detail).toBe('touch elsewhere-marker\nIn directory: /somewhere/else');
    await expectNothingTyped(r);
  });

  test('the TUI answers first: the card clears with question_resolved, and a late phone answer is STALE_ANSWER and sends nothing', async () => {
    const r = await attached();
    const id = r.server.request(commandRequest(r, 'touch tui-first'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    const card = pending(r)[0] as Question;

    r.server.resolve(r.tuiId, id);
    await until(() => pending(r).length === 0, 'the card to clear');
    expect(resolved(r).map((m) => [m.questionId, m.reason])).toEqual([[card.id, 'cancelled']]);

    await answer(r, card, 'Yes');
    expect(r.errors.map((e) => e.code)).toEqual(['STALE_ANSWER']);
    expect(r.errors[0]?.details?.['questionId']).toBe(card.id);
    expect(answersSent(r)).toEqual([]);
    await expectNothingTyped(r);
  });

  test('two requests in a row have two ids: each card answers its own request, and one resolved clears only its own card', async () => {
    const r = await attached();
    const first = r.server.request(commandRequest(r, 'touch first'), r.tuiId);
    const second = r.server.request(commandRequest(r, 'touch second'), r.tuiId);
    expect(second).toBe(first + 1);
    await until(() => pending(r).length === 2, 'both cards');
    const [one, two] = pending(r) as [Question, Question];
    expect([one.text, two.text]).toEqual([
      'Allow Codex to run: touch first',
      'Allow Codex to run: touch second',
    ]);

    r.server.resolve(r.tuiId, first);
    await until(() => pending(r).length === 1, 'the first card to clear');
    expect(pending(r)[0]?.id).toBe(two.id);
    await answer(r, two, 'No');
    await until(() => !r.server.isPending(r.tuiId, second), 'the second request');
    expect(answersSent(r).map((a) => a.frame)).toEqual([
      { jsonrpc: '2.0', id: second, result: { decision: 'cancel' } },
    ]);
  });

  test("another thread's request on this very connection is no card and is never answered, and its resolved does not touch our card", async () => {
    const r = await attached();
    const client = r.server.clientIds()[0] as number;
    const stranger = crypto.randomUUID();
    r.server.emitTo(client, { id: 900, ...commandApprovalRequest(stranger, 'touch elsewhere') });
    const id = r.server.request(commandRequest(r, 'touch ours'), r.tuiId);
    await until(() => pending(r).length === 1, 'our card');
    expect(pending(r)[0]?.text).toBe('Allow Codex to run: touch ours');
    expect(cards(r)).toHaveLength(1);

    // A resolved for the same id on another thread is another request's.
    r.server.emitTo(client, {
      method: 'serverRequest/resolved',
      params: { threadId: stranger, requestId: id },
    });
    // Frames on one connection arrive in order: this one is handled before the next.
    r.server.emitTo(client, { method: 'serverRequest/resolved', params: 'not an object' });
    r.server.emitTo(client, { method: 'serverRequest/resolved', params: { threadId: r.tuiId } });
    await sleep(150);
    expect(pending(r)).toHaveLength(1);
    expect(r.server.isPending(r.tuiId, id)).toBe(true);
    expect(answersSent(r)).toEqual([]);
  });

  test("a subagent's request is a terminalOnly card with its agent; every answer is refused, Cancel clears it, nothing is sent or typed", async () => {
    const r = await attached();
    const child = crypto.randomUUID();
    r.server.emit(
      threadStartedFrame('tui', { id: child, cwd: workDir, createdAtSec: nowSec() }, (t) => {
        t['parentThreadId'] = r.tuiId;
      }),
      { broadcast: true },
    );
    await sleep(100);
    // The server addresses it to this connection (whether Codex does is LV-3's business).
    r.server.emitTo(r.server.clientIds()[0] as number, {
      id: 77,
      ...commandApprovalRequest(child, 'touch by-subagent'),
    });
    await until(() => pending(r).length === 1, 'the subagent card');
    const card = pending(r)[0] as Question;
    expect(card.terminalOnly).toBe(true);
    expect(card.agentId).toBe(child);

    await answer(r, card, 'Yes');
    await answer(r, card, 'accept');
    expect(r.errors.map((e) => e.code)).toEqual(['STALE_ANSWER', 'STALE_ANSWER']);
    expect(pending(r)).toHaveLength(1);
    await cancel(r, card);
    expect(pending(r)).toEqual([]);
    expect(answersSent(r)).toEqual([]);
    await expectNothingTyped(r);
  });

  test('a card only the terminal can answer refuses every answer, and Cancel clears it without an answer or an Esc', async () => {
    const r = await attached();
    const id = r.server.request(fileChangeRequest(r.tuiId, 'edit the config'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    const card = pending(r)[0] as Question;
    expect(card.terminalOnly).toBe(true);

    await answer(r, card, 'Yes');
    await answer(r, card, 'free text');
    await r.handlers.onAnswer(CID, r.sessionId, card.id, '', undefined, {
      selections: [{ questionIndex: 0, optionIndices: [0] }],
    });
    expect(r.errors.map((e) => e.code)).toEqual(['STALE_ANSWER', 'STALE_ANSWER', 'STALE_ANSWER']);
    expect(pending(r)).toHaveLength(1);

    await cancel(r, card);
    expect(pending(r)).toEqual([]);
    // The request is still pending for the TUI: remi answered nothing.
    expect(r.server.isPending(r.tuiId, id)).toBe(true);
    expect(answersSent(r)).toEqual([]);
    await expectNothingTyped(r);
  });

  describe('the link drops in the middle of an approval', () => {
    test('the card is retired, the replay makes a new card with a new id whose answer works, and the old one cannot be answered', async () => {
      const r = await attached();
      const id = r.server.request(commandRequest(r, 'touch survive'), r.tuiId);
      await until(() => pending(r).length === 1, 'the card');
      const old = pending(r)[0] as Question;
      const firstClient = r.server.clientIds()[0] as number;

      r.server.dropClient(firstClient);
      // The replay on the new connection brings the same request back as a new card.
      await until(
        () => pending(r).some((q) => q.id !== old.id && r.session.decisions.isHeld(q.id)),
        'the replayed card',
      );
      const fresh = pending(r).find((q) => q.id !== old.id) as Question;
      expect(fresh.text).toBe(old.text);
      // The retired card is dismissed in its place, for every client.
      expect(resolved(r).map((m) => [m.questionId, m.reason])).toContainEqual([
        old.id,
        'cancelled',
      ]);
      expect(pending(r).some((q) => q.id === old.id)).toBe(false);

      // The old card is not answerable, even on the new connection; nothing is sent.
      await answer(r, old, 'Yes');
      expect(answersSent(r)).toEqual([]);
      expect(r.errors.map((e) => e.code)).toEqual(['STALE_ANSWER']);

      // The new card answers, on the new connection, with the same request id.
      await answer(r, fresh, 'Yes');
      await until(() => answersSent(r).length === 1, 'the answer');
      const sentAnswer = answersSent(r)[0] as { client: number; frame: Json };
      expect(sentAnswer.client).not.toBe(firstClient);
      expect(sentAnswer.frame).toStrictEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'accept' },
      });
      await until(() => !r.server.isPending(r.tuiId, id), 'the request to be resolved');
      await expectNothingTyped(r);
    });

    test('a request resolved while the link was down is not replayed: its retired card is swept after the replay window', async () => {
      // The grace period is ten minutes, so only the replay window after the re-attach can sweep it.
      const r = await attached({ decisions: { replayWindowMs: 200, disconnectGraceMs: 600_000 } });
      const id = r.server.request(commandRequest(r, 'touch gone'), r.tuiId);
      await until(() => pending(r).length === 1, 'the card');
      const old = pending(r)[0] as Question;
      r.server.dropClient(r.server.clientIds()[0] as number);
      // The TUI answered while remi was away: in the same tick, before the client can reconnect.
      r.server.resolve(r.tuiId, id);
      await until(() => pending(r).length === 0, 'the sweep');
      expect(resolved(r).map((m) => [m.questionId, m.reason])).toEqual([[old.id, 'cancelled']]);
      expect(cards(r)).toHaveLength(1);
      expect(answersSent(r)).toEqual([]);
    });

    test('a link that does not come back dismisses the retired card after the grace period', async () => {
      const r = await attached({ decisions: { replayWindowMs: 100, disconnectGraceMs: 300 } });
      r.server.request(commandRequest(r, 'touch dead-link'), r.tuiId);
      await until(() => pending(r).length === 1, 'the card');
      const old = pending(r)[0] as Question;
      // The server goes away for good: stop it, so no reconnect can succeed.
      await r.server.stop();
      await until(() => pending(r).length === 0, 'the grace sweep');
      expect(resolved(r).map((m) => [m.questionId, m.reason])).toEqual([[old.id, 'cancelled']]);
      expect(answersSent(r)).toEqual([]);
    });
  });

  test('cards of a thread the session moved off are dismissed at the rotation, and its requests make no card afterwards', async () => {
    const r = await attached();
    const id = r.server.request(commandRequest(r, 'touch old-thread'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    const old = pending(r)[0] as Question;

    // `/new` in the TUI: another user thread in this directory, while the first is not active
    // (a tracker never follows a thread that is; an idle report with a card up is the case where
    // a status and a request disagree, and the card must still not outlive the move).
    r.server.emit(threadStatusFrame(r.tuiId, { type: 'idle' }), { broadcast: true });
    await sleep(100);
    const next = crypto.randomUUID();
    r.server.emit(threadStartedFrame('tui', { id: next, cwd: workDir, createdAtSec: nowSec() }), {
      broadcast: true,
    });
    await until(() => pending(r).length === 0, "the old thread's card to be dismissed");
    expect(resolved(r).map((m) => [m.questionId, m.reason])).toEqual([[old.id, 'cancelled']]);
    // The harness moved to a new thread (#1235).
    expect(resolved(r)[0]?.resolvedBy).toBe('harness');

    // The old thread's request, delivered again, is not this session's any more.
    r.server.emitTo(r.server.clientIds()[0] as number, {
      id,
      ...commandRequest(r, 'touch old-thread'),
    });
    await sleep(150);
    expect(pending(r)).toEqual([]);
    expect(answersSent(r)).toEqual([]);
  });

  test('every rotation tells the person that approvals now come from another thread, once per rotation and not once per session (S3)', async () => {
    const r = await attached();
    // The first binding is not a rotation: nothing is said.
    expect(systemNotices(r)).toEqual([]);
    const notice = 'remi now follows a new Codex thread; approvals come from it';
    let current = r.tuiId;
    for (let n = 1; n <= 2; n++) {
      r.server.emit(threadStatusFrame(current, { type: 'idle' }), { broadcast: true });
      await sleep(100);
      current = crypto.randomUUID();
      r.server.emit(
        threadStartedFrame('tui', { id: current, cwd: workDir, createdAtSec: nowSec() }),
        {
          broadcast: true,
        },
      );
      await until(() => systemNotices(r).length === n, `the notice of rotation ${n}`);
      expect(systemNotices(r)[n - 1]).toContain(notice);
      expect(r.logs.filter((l) => l.includes('rotated from'))).toHaveLength(n);
    }
    // Nothing more is said, and the new thread's approvals are the ones that become cards.
    await sleep(200);
    expect(systemNotices(r)).toHaveLength(2);
    r.server.emitTo(r.server.clientIds()[0] as number, {
      id: 900,
      ...commandApprovalRequest(current, 'touch new-thread', { cwd: workDir }),
    });
    await until(() => pending(r).length === 1, 'the new thread card');
  });

  test('the pending-question cap evicts an older card nobody is held for, and never a pending approval', async () => {
    const r = await attached();
    const warn = console.warn;
    console.warn = () => {};
    try {
      // One terminalOnly card first: nothing is held for it, so nothing pins it.
      r.server.request(fileChangeRequest(r.tuiId, 'older unpinned card'), r.tuiId);
      await until(() => cards(r).length === 1, 'the unpinned card');
      const unpinned = pending(r)[0] as Question;
      // Then ten pending approvals: the cap is eight, every approval is pinned.
      for (let i = 0; i < 10; i++) {
        r.server.request(commandRequest(r, `touch pinned-${i}`), r.tuiId);
      }
      await until(() => cards(r).length === 11, 'eleven cards');
      // The cap took the unpinned card and none of the approvals (it goes past eight rather than
      // evict one of them).
      expect(pending(r).some((q) => q.id === unpinned.id)).toBe(false);
      expect(pending(r)).toHaveLength(10);
      expect(pending(r).every((q) => r.session.decisions.isHeld(q.id))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  test('disposing the session dismisses its cards, and nothing is answered afterwards', async () => {
    const r = await attached();
    r.server.request(commandRequest(r, 'touch at-exit'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    const card = pending(r)[0] as Question;
    r.session.dispose();
    expect(resolved(r).map((m) => [m.questionId, m.reason])).toEqual([[card.id, 'cancelled']]);
    await answer(r, card, 'Yes');
    expect(answersSent(r)).toEqual([]);
  });

  test('typed chat is refused while a card is up, and raw input is the one thing that reaches the terminal', async () => {
    const r = await attached();
    await until(() => fs.existsSync(path.join(fakeDir, 'stdin')), 'the fake codex');
    r.server.request(commandRequest(r, 'touch chat'), r.tuiId);
    await until(() => pending(r).length === 1, 'the card');
    await r.handlers.onUserInput(CID, r.sessionId, 'typed chat', false);
    expect(r.errors.map((e) => e.code)).toEqual(['PROMPT_WAITING']);
    // Nothing was typed, and the counter moves for exactly the one raw byte.
    await expectNothingTyped(r);
  });
});
