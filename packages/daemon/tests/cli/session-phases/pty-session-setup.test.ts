import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, Question, UUID } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import {
  computeTermSize,
  createPtySessionForSession,
  detectAuqTerminalAnswers,
} from '../../../src/cli/session-phases/pty-session-setup.ts';
import { __resetWrapperStateForTests } from '../../../src/cli/wrapper-state.ts';
import { OutputProcessor } from '../../../src/parser/output-processor.ts';
import { appendPtyOutput, clearPtyOutput } from '../../../src/pty/output-buffer.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;
const QID = 'b2c3d4e5-f6a7-8901-bcde-f01234567890' as UUID;

const CLOSED_MARKER = "⏺ User answered Claude's questions:  ⎿ · Color → Green";

const fakeMessageAPI = {
  handleMessage: () => {},
  handleQuestion: () => {},
  handleStatusChange: () => {},
  reset: () => {},
} as unknown as MessageAPI;

function auqQuestion(id: UUID): Question {
  return {
    id,
    text: 'Color: What is your favorite color?',
    options: [{ value: '2', label: 'Green', isRecommended: false, isYes: false, isNo: false }],
    allowsFreeText: false,
    isAnswered: false,
    kind: 'multi_question',
    questions: [
      {
        header: 'Color',
        text: 'What is your favorite color?',
        multiSelect: false,
        options: [{ value: '2', label: 'Green', isRecommended: false, isYes: false, isNo: false }],
      },
    ],
  };
}

/**
 * These tests don't actually start the PTY (ptySession.start() would spawn a
 * real `claude` process). They cover the factory-construction surface plus
 * the `computeTermSize` helper. Runtime callback behavior is exercised by
 * the Docker integration suite (`tests/integration/run-tests.sh`) where a
 * real shell stands in for Claude.
 */
describe('computeTermSize', () => {
  test('returns deterministic 120x40 for headless (non-passThrough) mode', () => {
    expect(computeTermSize(false)).toEqual({ cols: 120, rows: 40 });
  });

  test('pass-through mode reads process.stdout dims with 120x40 fallback', () => {
    const size = computeTermSize(true);
    // process.stdout.columns/rows may be defined or undefined depending on
    // where tests run. Either way, the function must return finite numbers
    // and fall back to 120x40 when the TTY dims are unavailable.
    expect(size.cols).toBeGreaterThan(0);
    expect(size.rows).toBeGreaterThan(0);
    if (process.stdout.columns) {
      expect(size.cols).toBe(process.stdout.columns);
    } else {
      expect(size.cols).toBe(120);
    }
    if (process.stdout.rows) {
      expect(size.rows).toBe(process.stdout.rows);
    } else {
      expect(size.rows).toBe(40);
    }
  });

  test('reservedRows shrinks the pass-through height by one row (#565)', () => {
    const full = computeTermSize(true, 0);
    const reserved = computeTermSize(true, 1);
    expect(reserved.cols).toBe(full.cols);
    expect(reserved.rows).toBe(full.rows - 1);
  });

  test('reservedRows never affects the headless deterministic size', () => {
    // Headless PTYs must stay a reproducible 120x40 regardless of reservedRows.
    expect(computeTermSize(false, 1)).toEqual({ cols: 120, rows: 40 });
  });
});

describe('createPtySessionForSession', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let outputProcessor: OutputProcessor;
  let sendCalls: Array<{ sessionId: UUID; message: ProtocolMessage }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pty-setup-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    outputProcessor = new OutputProcessor(
      { sessionId: SID, streamStatusOnly: true },
      { onMessage: () => {}, onQuestion: () => {}, onStatusChange: () => {} },
    );
    sendCalls = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    __resetWrapperStateForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function build(passThrough: boolean) {
    return createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: (sid, message) => sendCalls.push({ sessionId: sid, message }),
        cleanup: async () => {},
      },
      {
        sessionId: SID,
        workingDirectory: tmpDir,
        extraArgs: ['--verbose'],
        passThrough,
      },
    );
  }

  test('returns a PTYSession whose sessionState starts in created', () => {
    const pty = build(false);
    expect(pty.sessionState).toBe('created');
    // The factory does NOT call .start(), so no child process has spawned.
    expect(pty.isRunning).toBe(false);
    expect(pty.childPid).toBeNull();
  });

  test('rejects a non-positive wsPort at factory entry', () => {
    expect(() =>
      createPtySessionForSession(
        {
          sessionRegistry,
          sessionStore,
          liveSessionsRegistry,
          outputProcessor,
          wsPort: 0,
          sendMessage: () => {},
          cleanup: async () => {},
        },
        {
          sessionId: SID,
          workingDirectory: tmpDir,
          extraArgs: [],
          passThrough: false,
        },
      ),
    ).toThrow(/wsPort/);
  });

  test('distinct PTY instances carry distinct ids', () => {
    const a = build(false);
    const b = build(false);
    expect(a.id).not.toBe(b.id);
  });

  // Real-PTY wiring for #451 Part 2: when the Claude child exits, onExit must
  // mark the live-sessions entry's child as exited so co-located daemons stop
  // counting us as a live sibling. Drives a genuine PTY by putting a fake,
  // immediately-exiting `claude` on PATH (no mocks).
  test('onExit marks the live-sessions child as exited (#451 Part 2)', async () => {
    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeClaude, 0o755);

    // Pre-register the live-sessions entry with a (currently alive) child pid,
    // mirroring the post-spawn setClaudeChildPid state.
    liveSessionsRegistry.register({
      sessionId: SID,
      pid: process.pid,
      wsPort: 9999,
      hookPort: 9998,
      projectPath: tmpDir,
      name: 'pty-exit-test',
      startedAt: new Date().toISOString(),
      claudeChildPid: process.pid,
    });

    // Capture the daemon-shutdown call instead of actually exiting the test
    // runner (#641): a daemon-mode session that exits must terminate the daemon.
    const exitCalls: number[] = [];
    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: (sid, message) => sendCalls.push({ sessionId: sid, message }),
        cleanup: async () => {},
        exitProcess: (code) => exitCalls.push(code),
      },
      { sessionId: SID, workingDirectory: tmpDir, extraArgs: [], passThrough: false },
    );
    // Register so handlePTYExit in onExit resolves the session.
    sessionRegistry.registerSession(SID, tmpDir, pty, {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
      reset: () => {},
    } as unknown as import('../../../src/api/message-api.ts').MessageAPI);

    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${fakeBin}:${originalPath ?? ''}`;
    try {
      await pty.start();
      // Wait for the fake claude to exit and onExit to fire.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const entry = liveSessionsRegistry.findBySessionId(SID);
        if (entry?.claudeChildExited === true && exitCalls.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(liveSessionsRegistry.findBySessionId(SID)?.claudeChildExited).toBe(true);
      // #641: a daemon-mode session ending must shut the daemon down (exit 0).
      expect(exitCalls).toEqual([0]);
    } finally {
      // Restore PATH (originalPath is effectively always defined in practice).
      process.env['PATH'] = originalPath ?? '';
      try {
        await pty.close();
      } catch {
        /* already exited */
      }
    }
  });
});

// #538/#661: an AskUserQuestion the auq-runner ESCALATED (gave up auto-driving)
// can still be answered directly in the terminal; nothing watched for that
// closure before this fix, leaving the phone-side card registered forever.
describe('detectAuqTerminalAnswers', () => {
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
  });

  afterEach(async () => {
    clearPtyOutput(SID);
    await sessionRegistry.shutdown();
  });

  function registerWithQuestion(question: Question | null) {
    const pty = { id: 'fake-pty', write: () => {}, close: async () => {} } as unknown as Parameters<
      typeof sessionRegistry.registerSession
    >[2];
    sessionRegistry.registerSession(SID, '/test/dir', pty, fakeMessageAPI);
    if (question) sessionRegistry.addQuestion(SID, question);
  }

  test('removes a pending AUQ + broadcasts resolved when the closure marker is buffered', () => {
    registerWithQuestion(auqQuestion(QID));
    appendPtyOutput(SID, CLOSED_MARKER);
    const resolved: Array<[UUID, UUID]> = [];
    const cancelled: Array<[UUID, UUID, string]> = [];

    detectAuqTerminalAnswers(
      SID,
      sessionRegistry,
      (sid, qid) => resolved.push([sid, qid]),
      (sid, qid, reason) => cancelled.push([sid, qid, reason]),
    );

    expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
    expect(resolved).toEqual([[SID, QID]]);
    expect(cancelled).toEqual([[SID, QID, 'user-answered-auq-terminal']]);
  });

  test('does nothing when no AUQ question is pending (no session, no throw)', () => {
    expect(() => detectAuqTerminalAnswers(SID, sessionRegistry)).not.toThrow();
  });

  test('does nothing when a question is pending but the closure marker never appeared', () => {
    registerWithQuestion(auqQuestion(QID));
    appendPtyOutput(SID, 'still ❯ 1. Red  2. Green  3. Blue');
    detectAuqTerminalAnswers(SID, sessionRegistry);
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);
  });

  test('leaves a non-AUQ (plain permission) question alone even if the marker appears', () => {
    registerWithQuestion({
      id: QID,
      text: 'proceed?',
      options: [{ value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false }],
      allowsFreeText: false,
      isAnswered: false,
      // no `kind` -> defaults to a plain permission prompt, not AUQ.
    });
    appendPtyOutput(SID, CLOSED_MARKER);
    detectAuqTerminalAnswers(SID, sessionRegistry);
    // A plain permission prompt is answered by a PTY digit submit, not this
    // marker; it must stay pending (never cleared by the wrong signal).
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);
  });

  test('missing callbacks are a safe no-op beyond the registry cleanup', () => {
    registerWithQuestion(auqQuestion(QID));
    appendPtyOutput(SID, CLOSED_MARKER);
    expect(() => detectAuqTerminalAnswers(SID, sessionRegistry)).not.toThrow();
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
  });

  // End-to-end through the real onData wiring: a genuine PTY (a fake `claude`
  // script standing in, same pattern as the onExit test above) prints the
  // closure marker to its stdout; createPtySessionForSession's onData callback
  // must pick it up via detectAuqTerminalAnswers and clear the card.
  test('fires through the real onData callback when a live PTY prints the marker', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-auq-terminal-'));
    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    const outputProcessor = new OutputProcessor(
      { sessionId: SID, streamStatusOnly: true },
      { onMessage: () => {}, onQuestion: () => {}, onStatusChange: () => {} },
    );
    configureLogger({ writeLog: () => {} });

    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // Print the closure marker once, then idle so onExit isn't racing our assert.
    fs.writeFileSync(fakeClaude, `#!/bin/sh\nprintf "%s\\n" "${CLOSED_MARKER}"\nsleep 5\n`);
    fs.chmodSync(fakeClaude, 0o755);

    const resolved: Array<[UUID, UUID]> = [];
    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: () => {},
        cleanup: async () => {},
        onQuestionResolved: (sid, qid) => resolved.push([sid, qid]),
        // Capture instead of the real default (process.exit) — the fake claude
        // eventually exits (after its sleep), and the real default would kill
        // the whole test runner (#641's onExit path is exercised elsewhere).
        exitProcess: () => {},
      },
      { sessionId: SID, workingDirectory: tmpDir, extraArgs: [], passThrough: false },
    );
    sessionRegistry.registerSession(SID, tmpDir, pty, fakeMessageAPI);
    sessionRegistry.addQuestion(SID, auqQuestion(QID));

    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${fakeBin}:${originalPath ?? ''}`;
    try {
      await pty.start();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (sessionRegistry.getSession(SID)?.currentQuestions.size === 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
      expect(resolved).toEqual([[SID, QID]]);
    } finally {
      process.env['PATH'] = originalPath ?? '';
      try {
        await pty.close();
      } catch {
        /* already exited */
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
