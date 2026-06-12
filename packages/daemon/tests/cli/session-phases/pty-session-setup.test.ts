import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import {
  computeTermSize,
  createPtySessionForSession,
} from '../../../src/cli/session-phases/pty-session-setup.ts';
import { __resetWrapperStateForTests } from '../../../src/cli/wrapper-state.ts';
import { OutputProcessor } from '../../../src/parser/output-processor.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;

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

    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: (sid, message) => sendCalls.push({ sessionId: sid, message }),
        cleanup: async () => {},
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
        if (entry?.claudeChildExited === true) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(liveSessionsRegistry.findBySessionId(SID)?.claudeChildExited).toBe(true);
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
