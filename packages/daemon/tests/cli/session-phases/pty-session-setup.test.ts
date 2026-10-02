import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import {
  CLAUDE_INLINE_RENDERER_ENV,
  buildClaudeChildEnv,
  computeTermSize,
  createPtySessionForSession,
} from '../../../src/cli/session-phases/pty-session-setup.ts';
import {
  __resetWrapperStateForTests,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../../../src/cli/wrapper-state.ts';
import { OutputProcessor } from '../../../src/parser/output-processor.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;
const fakeMessageAPI = {
  handleMessage: () => {},
  handleQuestion: () => {},
  handleStatusChange: () => {},
  reset: () => {},
} as unknown as MessageAPI;

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

  test('onExit continues cleanup when session-store persistence is locked', async () => {
    const fakeBin = path.join(tmpDir, 'locked-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeClaude, 0o755);

    liveSessionsRegistry.register({
      sessionId: SID,
      pid: process.pid,
      wsPort: 9999,
      hookPort: 9998,
      projectPath: tmpDir,
      name: 'locked-store-exit-test',
      startedAt: new Date().toISOString(),
      claudeChildPid: process.pid,
    });
    const lockPath = path.join(tmpDir, 'sessions.json.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: 'live-owner',
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: Date.now(),
      }),
      'utf-8',
    );

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
    sessionRegistry.registerSession(SID, tmpDir, pty, fakeMessageAPI);

    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${fakeBin}:${originalPath ?? ''}`;
    try {
      await pty.start();
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && exitCalls.length === 0) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(exitCalls).toEqual([0]);
      expect(liveSessionsRegistry.findBySessionId(SID)?.claudeChildExited).toBe(true);
    } finally {
      process.env['PATH'] = originalPath ?? '';
      try {
        await pty.close();
      } catch {
        /* already exited */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* cleanup */
      }
    }
  });
});

// #932 review finding 3: the wrapper's onRawData wiring (observeLocalPtyOutput)
// does NOT require spawning a real `claude` to test -- createPtySessionForSession
// never calls .start() (PTYSession's constructor only stores config; Bun.spawn
// happens in start(), see the "returns a PTYSession whose sessionState starts in
// created" test above), so the `events` object passed to `new PTYSession(...)`
// is fully populated and reachable: TypeScript's `private` is compile-time only,
// not a runtime guarantee, so a cast reaches it directly, exactly as the review
// did in its own 16ms counter-example.
describe('createPtySessionForSession onRawData wiring (#932)', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let outputProcessor: OutputProcessor;
  let outPath: string;
  let outFd: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pty-rawdata-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    outputProcessor = new OutputProcessor(
      { sessionId: SID, streamStatusOnly: true },
      { onMessage: () => {}, onQuestion: () => {}, onStatusChange: () => {} },
    );
    configureLogger({ writeLog: () => {} });
    outPath = path.join(tmpDir, 'local-terminal-out');
    fs.writeFileSync(outPath, '');
    outFd = fs.openSync(outPath, 'w');
    setPtyStdoutFd(outFd);
    setWrapperDetached(false);
  });

  afterEach(async () => {
    __resetLoggerForTests();
    __resetWrapperStateForTests();
    await sessionRegistry.shutdown();
    try {
      fs.closeSync(outFd);
    } catch {
      // may already be closed by a test that exercises the write-failure path
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Reach the real onRawData callback without starting a PTY (no `claude`
   *  spawned) -- see this describe block's doc comment. */
  function rawDataHandlerOf(pty: ReturnType<typeof createPtySessionForSession>) {
    const events = (pty as unknown as { events: { onRawData?: (d: Uint8Array) => void } }).events;
    const handler = events.onRawData;
    if (!handler) throw new Error('onRawData was not wired');
    return handler;
  }

  /** Invoke onRawData the way `PTYSession.handleData` actually does in
   *  production -- wrapped in a try/catch that routes any throw to
   *  `onError` (pty-session.ts) rather than letting it escape. The write-
   *  failure path's stdin cleanup (`process.stdin.unref()` etc.) assumes a
   *  real interactive terminal that this test runner's stdin does not
   *  provide; production never calls onRawData bare either, so this
   *  matches the real invocation context rather than papering over it. */
  function invokeOnRawData(
    pty: ReturnType<typeof createPtySessionForSession>,
    data: Uint8Array,
  ): void {
    try {
      rawDataHandlerOf(pty)(data);
    } catch {
      // See doc comment: mirrors PTYSession.handleData's own onError routing.
    }
  }

  test('onRawData writes the real chunk to the local terminal and calls observeLocalPtyOutput with the exact bytes', () => {
    const observedChunks: Uint8Array[] = [];
    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: () => {},
        cleanup: async () => {},
        observeLocalPtyOutput: (data) => observedChunks.push(data),
      },
      { sessionId: SID, workingDirectory: tmpDir, extraArgs: [], passThrough: true },
    );

    const chunk = new TextEncoder().encode('hello from claude');
    invokeOnRawData(pty, chunk);

    expect(fs.readFileSync(outPath, 'utf-8')).toBe('hello from claude');
    expect(observedChunks).toHaveLength(1);
    expect(observedChunks[0]).toEqual(chunk);
  });

  // #932 review finding 2, proven at the wrapper level (the review noted this
  // test would have caught it directly): the real chunk must land on the wire
  // BEFORE anything observeLocalPtyOutput itself writes to the same fd, never
  // after -- an immediate bar repaint triggered by an observed ESC[r would
  // otherwise be undone by the very reset that triggered it.
  test('observeLocalPtyOutput fires strictly AFTER the real chunk is written to the same fd', () => {
    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: () => {},
        cleanup: async () => {},
        observeLocalPtyOutput: () => {
          // Simulate StatusBar.notifyScrollRegionReset's synchronous write
          // to the SAME shared fd.
          fs.writeSync(outFd, 'MARKER');
        },
      },
      { sessionId: SID, workingDirectory: tmpDir, extraArgs: [], passThrough: true },
    );

    invokeOnRawData(pty, new TextEncoder().encode('\x1b[r'));

    const written = fs.readFileSync(outPath, 'utf-8');
    const chunkIndex = written.indexOf('\x1b[r');
    const markerIndex = written.indexOf('MARKER');
    expect(chunkIndex).toBe(0); // the real chunk is written first, at offset 0
    expect(markerIndex).toBeGreaterThan(chunkIndex);
  });

  test('observeLocalPtyOutput is NOT called when the local write fails', () => {
    // Close the writable fd and reopen the same path read-only so the write
    // throws EBADF -- a real, not simulated, write failure.
    fs.closeSync(outFd);
    outFd = fs.openSync(outPath, 'r');
    setPtyStdoutFd(outFd);

    let observed = false;
    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: () => {},
        cleanup: async () => {},
        observeLocalPtyOutput: () => {
          observed = true;
        },
      },
      { sessionId: SID, workingDirectory: tmpDir, extraArgs: [], passThrough: true },
    );

    invokeOnRawData(pty, new TextEncoder().encode('data that cannot be written'));

    expect(observed).toBe(false);
  });

  test('onRawData does not write or observe when passThrough is false', () => {
    const observedChunks: Uint8Array[] = [];
    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        outputProcessor,
        wsPort: 9999,
        sendMessage: () => {},
        cleanup: async () => {},
        observeLocalPtyOutput: (data) => observedChunks.push(data),
      },
      { sessionId: SID, workingDirectory: tmpDir, extraArgs: [], passThrough: false },
    );

    invokeOnRawData(pty, new TextEncoder().encode('daemon-mode chunk'));

    expect(fs.readFileSync(outPath, 'utf-8')).toBe('');
    expect(observedChunks).toHaveLength(0);
  });
});

describe('buildClaudeChildEnv inline renderer policy (#1124)', () => {
  test('forces the inline renderer when the incoming env does not define it', () => {
    const env = buildClaudeChildEnv(9999, 0, {});
    expect(env[CLAUDE_INLINE_RENDERER_ENV]).toBe('1');
    expect(CLAUDE_INLINE_RENDERER_ENV).toBe('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN');
  });

  test('"0", the documented opt-out, and any other non-empty value are preserved', () => {
    // Nothing is emitted for the key, so PTYSession's `{...process.env, ...env}`
    // spread keeps the user's value and `=0` reaches Claude untouched.
    for (const value of ['0', '1', 'false']) {
      const env = buildClaudeChildEnv(9999, 0, { [CLAUDE_INLINE_RENDERER_ENV]: value });
      expect(CLAUDE_INLINE_RENDERER_ENV in env).toBe(false);
    }
  });

  test('an empty value counts as unset and is forced to 1', () => {
    const env = buildClaudeChildEnv(9999, 0, { [CLAUDE_INLINE_RENDERER_ENV]: '' });
    expect(env[CLAUDE_INLINE_RENDERER_ENV]).toBe('1');
  });

  test('a whitespace-only value counts as unset and is forced to 1', () => {
    const env = buildClaudeChildEnv(9999, 0, { [CLAUDE_INLINE_RENDERER_ENV]: '  ' });
    expect(env[CLAUDE_INLINE_RENDERER_ENV]).toBe('1');
  });

  test('a key present with an undefined value counts as unset and is forced to 1', () => {
    const env = buildClaudeChildEnv(9999, 0, { [CLAUDE_INLINE_RENDERER_ENV]: undefined });
    expect(env[CLAUDE_INLINE_RENDERER_ENV]).toBe('1');
  });

  test('keeps REMI_PORT and the reserved-row REMI_STATUS_BAR flag unchanged', () => {
    expect(buildClaudeChildEnv(1234, 0, {})).toEqual({
      REMI_PORT: '1234',
      [CLAUDE_INLINE_RENDERER_ENV]: '1',
    });
    expect(buildClaudeChildEnv(1234, 1, {})).toEqual({
      REMI_PORT: '1234',
      REMI_STATUS_BAR: '1',
      [CLAUDE_INLINE_RENDERER_ENV]: '1',
    });
  });

  test('defaults the incoming env to process.env', () => {
    const saved = process.env[CLAUDE_INLINE_RENDERER_ENV];
    try {
      delete process.env[CLAUDE_INLINE_RENDERER_ENV];
      expect(buildClaudeChildEnv(9999)[CLAUDE_INLINE_RENDERER_ENV]).toBe('1');
      process.env[CLAUDE_INLINE_RENDERER_ENV] = '0';
      expect(CLAUDE_INLINE_RENDERER_ENV in buildClaudeChildEnv(9999)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[CLAUDE_INLINE_RENDERER_ENV];
      else process.env[CLAUDE_INLINE_RENDERER_ENV] = saved;
    }
  });
});

// End-to-end through the real spawn path: a genuine PTY child (a fake `claude`
// script on PATH, same pattern as the onExit test above) reports the value of
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN it actually received, merged exactly
// the way PTYSession.start() merges process.env with the factory's env.
describe('createPtySessionForSession spawned child env (#1124)', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let savedPath: string | undefined;
  let savedVar: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-child-env-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    savedPath = process.env['PATH'];
    savedVar = process.env[CLAUDE_INLINE_RENDERER_ENV];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    process.env['PATH'] = savedPath ?? '';
    if (savedVar === undefined) delete process.env[CLAUDE_INLINE_RENDERER_ENV];
    else process.env[CLAUDE_INLINE_RENDERER_ENV] = savedVar;
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Spawn the fake claude and return what it saw ('UNSET' when absent). */
  async function spawnedValue(): Promise<string> {
    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const outFile = path.join(tmpDir, 'seen.txt');
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh\nprintf '%s' "\${${CLAUDE_INLINE_RENDERER_ENV}-UNSET}" > "${outFile}.tmp"\nmv "${outFile}.tmp" "${outFile}"\n`,
    );
    fs.chmodSync(fakeClaude, 0o755);

    const pty = createPtySessionForSession(
      {
        sessionRegistry,
        sessionStore: new SessionStore(path.join(tmpDir, 'sessions.json')),
        liveSessionsRegistry: new SessionRegistryFile(path.join(tmpDir, 'live-sessions')),
        outputProcessor: new OutputProcessor(
          { sessionId: SID, streamStatusOnly: true },
          { onMessage: () => {}, onQuestion: () => {}, onStatusChange: () => {} },
        ),
        wsPort: 9999,
        sendMessage: () => {},
        cleanup: async () => {},
        exitProcess: () => {},
      },
      { sessionId: SID, workingDirectory: tmpDir, extraArgs: [], passThrough: false },
    );
    sessionRegistry.registerSession(SID, tmpDir, pty, fakeMessageAPI);

    process.env['PATH'] = `${fakeBin}:${savedPath ?? ''}`;
    try {
      await pty.start();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !fs.existsSync(outFile)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fs.existsSync(outFile)).toBe(true);
      return fs.readFileSync(outFile, 'utf8');
    } finally {
      try {
        await pty.close();
      } catch {
        /* already exited */
      }
    }
  }

  test('the child receives CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 when the user set nothing', async () => {
    delete process.env[CLAUDE_INLINE_RENDERER_ENV];
    expect(await spawnedValue()).toBe('1');
  });

  test('the child receives the user value when one was set explicitly', async () => {
    process.env[CLAUDE_INLINE_RENDERER_ENV] = '0';
    expect(await spawnedValue()).toBe('0');
  });

  test('the child receives 1 when the user set the variable to empty', async () => {
    process.env[CLAUDE_INLINE_RENDERER_ENV] = '';
    expect(await spawnedValue()).toBe('1');
  });
});
