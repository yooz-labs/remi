import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { setupHookBridge } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import type { HookServer } from '../../../src/hooks/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

/**
 * Recording HookServer that captures `.on()` registrations AND lets tests
 * fire the registered listeners directly. Lets us exercise the 7 hook
 * callback bodies without starting a real Bun.serve HTTP listener.
 */
class RecordingHookServer {
  readonly listeners = new Map<string, (input: unknown) => void>();
  on(event: string, listener: (input: unknown) => void): () => void {
    // Only the last listener per event survives; for setupHookBridge this is
    // fine because it installs exactly one per event name.
    this.listeners.set(event, listener);
    return () => this.listeners.delete(event);
  }
  fire(event: string, input: unknown): void {
    const fn = this.listeners.get(event);
    if (!fn) throw new Error(`No listener registered for ${event}`);
    fn(input);
  }
}

/** PTYSession fake that tracks submitInput calls (drives the auto-approve inject assertions). */
function fakePTY(submits: string[]): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async (content: string) => {
      submits.push(content);
    },
    close: async () => {},
  } as unknown as PTYSession;
}

function fakeMessageAPI(resetCalls: { n: number }): MessageAPI {
  return {
    handleMessage: () => {},
    handleStatusChange: () => {},
    handleQuestion: () => {},
    reset: () => {
      resetCalls.n += 1;
    },
  } as unknown as MessageAPI;
}

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;

describe('setupHookBridge', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let liveSessionsRegistry: SessionRegistryFile;
  // Stored loosely so tests can inject a minimal fake watcher without
  // dragging in a real TranscriptWatcher instance.
  let transcriptWatchers: Map<UUID, { filePath: string; stop: () => void }>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let hookServer: RecordingHookServer;
  let ptySubmits: string[];
  let resetCalls: { n: number };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hook-bridge-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    liveSessionsRegistry = new SessionRegistryFile(tmpDir);
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    hookServer = new RecordingHookServer();
    ptySubmits = [];
    resetCalls = { n: 0 };
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function build(opts: { autoApprove?: boolean } = {}) {
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits), fakeMessageAPI(resetCalls));

    // Minimal AutoApproveService stub. Only invoked when opts.autoApprove is
    // true; then we hand back a service whose `.evaluate` resolves to
    // 'approve' so the auto-approve inject path exercises.
    const autoApproveService = opts.autoApprove
      ? ({
          evaluate: async () => ({ decision: 'approve', reason: 'test-autoapprove' }),
        } as unknown as import('../../../src/auto-approve/index.ts').AutoApproveService)
      : null;

    setupHookBridge(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        transcriptWatchers: transcriptWatchers as unknown as Map<
          UUID,
          import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
        >,
        transcriptFallbackTimers,
        autoApproveService,
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: fakeMessageAPI(resetCalls),
        sendAndRecord: () => {},
      },
    );
  }

  test('registers listeners for all 7 hook events', () => {
    build();
    const events = new Set(hookServer.listeners.keys());
    expect(events).toEqual(
      new Set([
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'Notification',
        'PermissionRequest',
        'Stop',
        'SessionEnd',
      ]),
    );
  });

  test('does not throw when autoApproveService is null (common case)', () => {
    expect(() => build()).not.toThrow();
  });

  test('PermissionRequest with agent_id is dropped before reaching inject', async () => {
    build({ autoApprove: true });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-123',
      agent_id: 'subagent-abc',
      agent_type: 'task',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    // Let any queued microtasks run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Subagent PermissionRequests must NOT inject into the main PTY.
    expect(ptySubmits).toEqual([]);
  });

  test('PermissionRequest with auto-approve APPROVE injects "1" (status: executing)', async () => {
    build({ autoApprove: true });

    // Fire SessionStart first so claudeSessionId locks; subsequent events
    // pass filterBySession.
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-123',
      transcript_path: path.join(tmpDir, 'does-not-matter.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-123',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // Auto-approve .evaluate() is async; wait for the inject promise chain.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ptySubmits).toEqual(['1']);
    expect(sessionRegistry.getSession(SID)?.currentStatus).toBe('executing');
  });

  test('regression #321: sibling daemon dying re-enables hook lock acquisition', () => {
    // Pre-seed a sibling entry so the first hook event sees siblings present.
    const siblingFile = path.join(liveSessionsRegistry.dirPath, 'sibling-1.json');
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    fs.writeFileSync(
      siblingFile,
      JSON.stringify({
        sessionId: 'sibling-session-id',
        pid: process.pid, // alive (must be a live pid so listLive doesn't drop it)
        wsPort: 18999, // different from currentPort()=8765
        hookPort: 18000,
        projectPath: tmpDir, // SAME directory as our session under test
        name: 'sibling',
        startedAt: new Date().toISOString(),
      }),
    );

    build();

    // First hook event arrives while sibling exists -> must NOT lock onto
    // claude-A; events are deferred to the mtime fallback.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });
    expect(transcriptWatchers.has(SID)).toBe(false);

    // Sibling daemon dies (file removed).
    fs.unlinkSync(siblingFile);

    // Next hook event must now lock onto claude-A and start the watcher.
    // Pre-#321-fix: the cached `hasSiblingInDir=true` from the first call
    // permanently blocked init even after the sibling was gone.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });
    expect(transcriptWatchers.has(SID)).toBe(true);
  });

  test('SessionStart with source=clear pre-empts classifier and tears down watcher', () => {
    build();

    // First lock onto claude-A via a normal SessionStart.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    // Simulate a live transcript watcher so teardown has something to act on.
    const stopCalls: number[] = [];
    transcriptWatchers.set(SID, {
      filePath: path.join(tmpDir, 'a.jsonl'),
      stop: () => {
        stopCalls.push(1);
      },
    } as never);

    // Fire SessionStart with source=clear and a DIFFERENT session id.
    // This pre-empts the classifier into 'restart', tearing down the watcher
    // and resetting claudeSessionId so the new claude-B can lock.
    hookServer.fire('SessionStart', {
      session_id: 'claude-B',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      hook_event_name: 'SessionStart',
      source: 'clear',
    });

    // teardown side effects: old watcher stopped, messageApi reset. A new
    // watcher MAY be registered immediately after (for claude-B), so we
    // assert only the tear-down signals, not the final map state.
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(resetCalls.n).toBeGreaterThanOrEqual(1);
  });
});
