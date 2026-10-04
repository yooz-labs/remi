/**
 * Turn events and chat through a real Codex session (#1180, Phase 6 of the Codex epic #1175).
 *
 * `codex-turns.test.ts` and `codex-chat.test.ts` pin the two mappings on their own; this file pins
 * that `createCodexSession` wires them to what the daemon actually has: a real `CodexHarness`
 * session with its real PTY (a fake `codex`), the real `AppServerClient` and `ThreadTracker`
 * against the `FakeAppServer`, the real `MessageAPI`, and a recording `TurnEventSink` (the sink is
 * the interface the harness is written against; the real sink, with the real dispatcher, is the
 * subject of `notifications/turn-events.test.ts`). A frame sent by the app-server reaches the
 * sink or the phone only through the session's own client, tracker roles and handlers.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, TranscriptContentMessage, UUID } from '@remi/shared';
import { MessageAPI } from '../../../src/api/message-api.ts';
import type { CodexLaunchDeps } from '../../../src/harness/codex/codex-session.ts';
import { CodexHarness } from '../../../src/harness/codex/codex.ts';
import type { HarnessSession } from '../../../src/harness/types.ts';
import type { TurnEventSink } from '../../../src/notifications/turn-events.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import {
  agentMessageItem,
  itemCompletedFrame,
  itemsListPage,
  threadStartedFrame,
  turnCompletedFrame,
  turnError,
  userMessageItem,
} from '../../helpers/codex-threads.ts';
import { FakeAppServer } from '../../helpers/fake-app-server.ts';

/** A fake `codex` that just waits to be released (it types nothing and reads nothing here). */
const FAKE_CODEX = `#!/bin/sh
d="$FAKE_CODEX_DIR"
i=0
while [ ! -e "$d/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
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

describe('a Codex session: turn events and chat', () => {
  let tmpDir: string;
  let workDir: string;
  let fakeDir: string;
  let originalPath: string | undefined;
  let servers: FakeAppServer[];
  let launched: HarnessSession[];
  let registries: SessionRegistry[];

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-codex-turns-chat-')));
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
  });

  afterEach(async () => {
    fs.writeFileSync(path.join(fakeDir, 'release'), '');
    for (const session of launched) {
      if (session.pty.isRunning) session.pty.signal('SIGKILL');
      session.dispose();
    }
    for (const server of servers) await server.stop();
    for (const registry of registries) await registry.shutdown();
    process.env['PATH'] = originalPath ?? '/usr/bin:/bin';
    Reflect.deleteProperty(process.env, 'FAKE_CODEX_DIR');
    // The PTY's exit handler writes under `tmpDir`, so the child must be gone before it is removed.
    await until(
      () => launched.every((session) => !session.pty.isRunning),
      'the fake codex children to exit',
      10000,
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  type Recorded = string;

  interface Rig {
    server: FakeAppServer;
    session: HarnessSession;
    /** What the session told the sink, one line per event. */
    turns: Recorded[];
    /** What the session sent every client through `sendAndRecord`. */
    sent: ProtocolMessage[];
    logs: string[];
    tuiId: string;
    sessionId: UUID;
  }

  /** The sink as a list of lines, so an expectation reads as what happened. */
  function recordingSink(into: Recorded[]): TurnEventSink {
    return {
      turnCompleted: (e) =>
        into.push(
          `completed ${e.elapsedMs ?? 'unknown'} ${JSON.stringify(e.lastAssistantMessage ?? null)} ${e.reentry}`,
        ),
      turnFailed: (e) =>
        into.push(
          `failed ${e.agentName} ${e.error ?? '-'} ${JSON.stringify(e.errorDetails ?? null)}`,
        ),
      turnSucceeded: () => into.push('succeeded'),
    };
  }

  /** A launched, started session attached to the TUI's thread (or to `resumeId`'s, with no `thread/started`). */
  async function launch(
    opts: { sink?: TurnEventSink | null; resumeId?: string; noThread?: boolean } = {},
  ): Promise<Rig> {
    const server = FakeAppServer.start();
    servers.push(server);
    const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registries.push(registry);
    const sessionId = registry.createSessionId();
    const sent: ProtocolMessage[] = [];
    const logs: string[] = [];
    const turns: Recorded[] = [];
    const messageApi = new MessageAPI({ sessionId });
    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    const sink = opts.sink === undefined ? recordingSink(turns) : opts.sink;
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
      onQuestionResolved: () => {},
      log: (m) => logs.push(m),
      appServer: { backoff: { initialMs: 10, maxMs: 40 } },
      tracker: { retryMs: 40, ambiguityMs: 100 },
      ...(sink === null ? {} : { turnEvents: sink }),
    };
    const session = new CodexHarness(deps).createSession({
      sessionId,
      workingDirectory: workDir,
      extraArgs: opts.resumeId === undefined ? [] : ['resume', opts.resumeId],
      passThrough: false,
      reservedRows: 0,
      messageApi,
      sendAndRecord: (message) => sent.push(message),
      sendMessage: () => {},
    });
    launched.push(session);
    registry.registerSession(sessionId, workDir, session.pty, messageApi);
    await session.start();
    await until(() => server.clientIds().length === 1, 'the client to connect');

    // A session that is never shown a thread: its client is connected and nothing else happens.
    if (opts.noThread === true) return { server, session, turns, sent, logs, tuiId: '', sessionId };

    const tuiId = opts.resumeId ?? crypto.randomUUID();
    if (opts.resumeId === undefined) {
      server.emit(threadStartedFrame('tui', { id: tuiId, cwd: workDir, createdAtSec: nowSec() }), {
        broadcast: true,
      });
    }
    server.createRollout(tuiId);
    await until(() => logs.some((l) => l.includes('attached to thread')), 'the attach');
    return { server, session, turns, sent, logs, tuiId, sessionId };
  }

  const transcripts = (r: Rig): TranscriptContentMessage[] =>
    r.sent.filter((m): m is TranscriptContentMessage => m.type === 'transcript_content');

  describe('turn events', () => {
    test('a turn that completes on the tracked thread reaches the sink as completed, then succeeded', async () => {
      const r = await launch();

      r.server.emit(turnCompletedFrame(r.tuiId, { durationMs: 90_000 }), { threadId: r.tuiId });
      await until(() => r.turns.length === 2, 'the turn events');

      expect(r.turns).toEqual(['completed 90000 "done" false', 'succeeded']);
    });

    test('a failed turn reaches the sink as a Codex failure with the code and the words', async () => {
      const r = await launch();

      r.server.emit(
        turnCompletedFrame(r.tuiId, {
          status: 'failed',
          items: [],
          error: turnError('You have hit your usage limit.', 'usageLimitExceeded'),
        }),
        { threadId: r.tuiId },
      );
      await until(() => r.turns.length === 1, 'the turn event');

      expect(r.turns).toEqual(['failed Codex usageLimitExceeded "You have hit your usage limit."']);
    });

    test('an interrupted turn only clears a stale failure', async () => {
      const r = await launch();

      r.server.emit(turnCompletedFrame(r.tuiId, { status: 'interrupted', items: [] }), {
        threadId: r.tuiId,
      });
      await until(() => r.turns.length === 1, 'the turn event');

      expect(r.turns).toEqual(['succeeded']);
    });

    test('a resumed session (no thread/started) counts its own thread’s turns from the attach on', async () => {
      const r = await launch({ resumeId: crypto.randomUUID() });

      r.server.emit(turnCompletedFrame(r.tuiId), { threadId: r.tuiId });
      await until(() => r.turns.length === 2, 'the turn events');

      expect(r.turns[1]).toBe('succeeded');
    });

    test("a subagent's turn is not the session's, but its parent's still is", async () => {
      const r = await launch();
      const subId = crypto.randomUUID();
      // The subagent's thread names the tracked thread as its parent (a descendant, the tracker's role).
      r.server.emit(
        threadStartedFrame('tui', { id: subId, cwd: workDir, createdAtSec: nowSec() }, (thread) => {
          thread['parentThreadId'] = r.tuiId;
          thread['threadSource'] = 'subagent';
        }),
        { broadcast: true },
      );

      // One socket delivers in order: by the time the main turn's events are in, the subagent's
      // frame (sent first) has been handled, and it made none.
      r.server.emit(turnCompletedFrame(subId, { durationMs: 90_000 }), { broadcast: true });
      r.server.emit(turnCompletedFrame(r.tuiId, { durationMs: 91_000 }), { threadId: r.tuiId });
      await until(() => r.turns.length >= 2, 'the main turn events');

      expect(r.turns).toEqual(['completed 91000 "done" false', 'succeeded']);
    });

    test("another window's thread is ignored", async () => {
      const r = await launch();

      r.server.emit(turnCompletedFrame(crypto.randomUUID()), { broadcast: true });
      r.server.emit(turnCompletedFrame(r.tuiId, { durationMs: 91_000 }), { threadId: r.tuiId });
      await until(() => r.turns.length >= 2, 'the main turn events');

      expect(r.turns).toEqual(['completed 91000 "done" false', 'succeeded']);
    });

    test('a session built with no sink ignores turns, and its chat still works', async () => {
      const r = await launch({ sink: null });

      r.server.emit(turnCompletedFrame(r.tuiId, { durationMs: 90_000 }), { threadId: r.tuiId });
      r.server.emit(itemCompletedFrame(r.tuiId, userMessageItem('u1', 'still delivered')), {
        threadId: r.tuiId,
      });
      await until(() => transcripts(r).length === 1, 'the live item');

      expect(r.turns).toEqual([]);
      expect(r.logs.join('\n')).not.toMatch(/Error|throw/i);
    });
  });

  describe('chat', () => {
    test('the session has a chat, and typed chat from a client is still refused', async () => {
      const r = await launch();

      expect(r.session.chat).toBeDefined();
      expect(typeof r.session.chat?.readHistory).toBe('function');
      expect(r.session.acceptsTypedChat).toBe(false);
    });

    test('an item that completes on the tracked thread goes to every client as transcript_content', async () => {
      const r = await launch();

      r.server.emit(
        itemCompletedFrame(r.tuiId, agentMessageItem('a1', 'All done.', 'final_answer')),
        {
          threadId: r.tuiId,
        },
      );
      await until(() => transcripts(r).length === 1, 'the live item');

      const [m] = transcripts(r);
      expect(m?.entryUuid).toBe('a1');
      expect(m?.role).toBe('assistant');
      expect(m?.content).toBe('All done.');
      expect(m?.sessionId).toBe(r.sessionId);
    });

    test("another window's items never reach the phone", async () => {
      const r = await launch();

      r.server.emit(
        itemCompletedFrame(crypto.randomUUID(), userMessageItem('u-other', 'not ours')),
        {
          broadcast: true,
        },
      );
      r.server.emit(itemCompletedFrame(r.tuiId, userMessageItem('u-ours', 'ours')), {
        threadId: r.tuiId,
      });
      await until(() => transcripts(r).length >= 1, 'the live item');

      expect(transcripts(r).map((m) => m.entryUuid)).toEqual(['u-ours']);
    });

    test('the history is read from the thread the session is attached to', async () => {
      const r = await launch();
      const calls: unknown[] = [];
      r.server.onRequest('thread/items/list', (p) => {
        calls.push(p);
        return itemsListPage(
          [
            { item: userMessageItem('u1', 'Run it') },
            { item: agentMessageItem('a1', 'Ran.', 'final_answer') },
          ],
          null,
        );
      });
      const emitted: string[] = [];

      const count = await (r.session.chat as NonNullable<HarnessSession['chat']>).readHistory((m) =>
        emitted.push(`${m.role}:${m.content}`),
      );

      expect(count).toBe(2);
      expect(emitted).toEqual(['user:Run it', 'assistant:Ran.']);
      expect(calls).toEqual([{ threadId: r.tuiId, sortDirection: 'asc', limit: 100 }]);
    });

    test('a session that resumed a thread reads that thread’s history at once', async () => {
      const resumeId = crypto.randomUUID();
      const r = await launch({ resumeId });
      const calls: Array<{ threadId?: string }> = [];
      r.server.onRequest('thread/items/list', (p) => {
        calls.push(p as { threadId?: string });
        return itemsListPage([], null);
      });

      await (r.session.chat as NonNullable<HarnessSession['chat']>).readHistory(() => {});

      expect(calls.map((c) => c.threadId)).toEqual([resumeId]);
    });

    test('a session that has not learned its thread has no history yet, and asks the app-server nothing', async () => {
      const r = await launch({ noThread: true });

      const count = await (r.session.chat as NonNullable<HarnessSession['chat']>).readHistory(
        () => {},
      );

      expect(count).toBe(0);
      expect(r.server.received.filter((f) => f.frame['method'] === 'thread/items/list')).toEqual(
        [],
      );
    });
  });
});
