import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { setupHookBridge } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import type { HookServer } from '../../../src/hooks/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import type { TranscriptWatcher } from '../../../src/transcript/transcript-watcher.ts';

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

function fakeMessageAPI(): MessageAPI {
  return {
    handleMessage: () => {},
    handleStatusChange: () => {},
    handleQuestion: () => {},
    reset: () => {},
  } as unknown as MessageAPI;
}

/**
 * Observation-only fake HookServer. Records every `.on()` registration so
 * tests can verify setupHookBridge wires the 7 expected events without
 * starting a real HTTP server. Follows the `capture calls` pattern already
 * used elsewhere in the test suite.
 */
class RecordingHookServer {
  readonly registrations: string[] = [];

  on(event: string, _listener: unknown): () => void {
    this.registrations.push(event);
    return () => {};
  }
}

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;

describe('setupHookBridge', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let hookServer: RecordingHookServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hook-bridge-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    liveSessionsRegistry = new SessionRegistryFile(tmpDir);
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    hookServer = new RecordingHookServer();
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function build() {
    // Seed the session so classifier + downstream lookups have something to match.
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(), fakeMessageAPI());

    setupHookBridge(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        transcriptWatchers,
        transcriptFallbackTimers,
        autoApproveService: null,
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: fakeMessageAPI(),
        sendAndRecord: () => {},
      },
    );
  }

  test('registers listeners for all 7 hook events', () => {
    build();

    // Order mirrors the cli.ts inline version so a regression that drops
    // a registration surfaces here rather than in production.
    expect(hookServer.registrations).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'PermissionRequest',
      'Stop',
      'SessionEnd',
    ]);
  });

  test('returns void (no handle exposed)', () => {
    const result: unknown = setupHookBridge(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        transcriptWatchers,
        transcriptFallbackTimers,
        autoApproveService: null,
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: fakeMessageAPI(),
        sendAndRecord: () => {},
      },
    );
    expect(result).toBeUndefined();
  });

  test('does not throw when autoApproveService is null (common case)', () => {
    expect(() => build()).not.toThrow();
  });

  test('each call produces an independent 7-listener registration set', () => {
    build();
    const first = hookServer.registrations.length;
    // Fresh server + fresh session
    hookServer = new RecordingHookServer();
    const sessionId2 = sessionRegistry.createSessionId();
    // Cannot register a 2nd session in the same registry; use a fresh one.
    const sessionRegistry2 = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionRegistry2.registerSession(sessionId2, tmpDir, fakePTY(), fakeMessageAPI());
    setupHookBridge(
      {
        sessionRegistry: sessionRegistry2,
        sessionStore,
        liveSessionsRegistry,
        transcriptWatchers,
        transcriptFallbackTimers,
        autoApproveService: null,
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: sessionId2,
        workingDirectory: tmpDir,
        messageApi: fakeMessageAPI(),
        sendAndRecord: (_: ProtocolMessage) => {},
      },
    );
    expect(first).toBe(7);
    expect(hookServer.registrations.length).toBe(7);
    void sessionRegistry2.shutdown();
  });
});
