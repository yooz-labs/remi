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

interface MessageApiCallLog {
  resetCalls: { n: number };
  statusCalls: string[];
  questionCalls: number;
}

function fakeMessageAPI(log: MessageApiCallLog): MessageAPI {
  return {
    handleMessage: () => {},
    handleStatusChange: (status: string) => {
      log.statusCalls.push(status);
    },
    handleQuestion: () => {
      log.questionCalls += 1;
    },
    reset: () => {
      log.resetCalls.n += 1;
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
  let messageApiLog: MessageApiCallLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hook-bridge-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    liveSessionsRegistry = new SessionRegistryFile(tmpDir);
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    hookServer = new RecordingHookServer();
    ptySubmits = [];
    messageApiLog = { resetCalls: { n: 0 }, statusCalls: [], questionCalls: 0 };
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function build(
    opts: {
      autoApprove?: boolean;
      autoApproveDecision?: 'approve' | 'deny' | 'escalate';
      autoApproveDelayMs?: number;
    } = {},
  ) {
    sessionRegistry.registerSession(
      SID,
      tmpDir,
      fakePTY(ptySubmits),
      fakeMessageAPI(messageApiLog),
    );

    // Minimal AutoApproveService stub. Only invoked when opts.autoApprove is
    // true; default decision is 'approve' (existing tests rely on this).
    // `autoApproveDelayMs` simulates LLM eval latency so dedup-window tests
    // can fire Notification while evaluate() is still in flight (#379).
    const autoApproveService = opts.autoApprove
      ? ({
          evaluate: async () => {
            if (opts.autoApproveDelayMs && opts.autoApproveDelayMs > 0) {
              await new Promise((r) => setTimeout(r, opts.autoApproveDelayMs));
            }
            return {
              decision: opts.autoApproveDecision ?? 'approve',
              reason: 'test-autoapprove',
            };
          },
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
        messageApi: fakeMessageAPI(messageApiLog),
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

  test('regression #321: sibling daemon dying re-enables hook lock acquisition AND filterBySession recovers', () => {
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
    // claude-A; events are deferred to the mtime fallback. PreToolUse during
    // this window must also be filtered out (the headline #321 symptom: no
    // [AutoApprove], no status updates).
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });
    expect(transcriptWatchers.has(SID)).toBe(false);

    hookServer.fire('PreToolUse', {
      session_id: 'claude-A',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    // filterBySession with no lock + sibling => drops everything; status
    // never advances. This was the user-visible failure in #321.
    expect(messageApiLog.statusCalls).toEqual([]);

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

    // And filterBySession must now accept further events. PreToolUse maps to
    // 'executing' via HookEventBridge.handleStatusChange.
    hookServer.fire('PreToolUse', {
      session_id: 'claude-A',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messageApiLog.statusCalls).toContain('executing');
  });

  test('regression #321: sibling appearing after lock acquisition does not re-engage the guard', () => {
    // Once we hold a session lock, a sibling daemon spinning up later must
    // not flip filterBySession into the pre-lock branch and start dropping
    // events. claudeSessionId-based filtering takes precedence.
    build();

    // Acquire the lock cleanly with no siblings present.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });
    expect(transcriptWatchers.has(SID)).toBe(true);

    // A sibling appears now (e.g. user opens another remi in the same dir).
    fs.writeFileSync(
      path.join(liveSessionsRegistry.dirPath, 'late-sibling.json'),
      JSON.stringify({
        sessionId: 'late-sibling-id',
        pid: process.pid,
        wsPort: 18999,
        hookPort: 18000,
        projectPath: tmpDir,
        name: 'late-sibling',
        startedAt: new Date().toISOString(),
      }),
    );

    // Our own Claude's events must still flow through filterBySession because
    // session_id matches claudeSessionId; the sibling guard never reads.
    hookServer.fire('PreToolUse', {
      session_id: 'claude-A',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messageApiLog.statusCalls).toContain('executing');
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
    expect(messageApiLog.resetCalls.n).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Regression #379 / #377: pre-emptive Notification dedup during slow
  // auto-approve evaluation. The PermissionRequest hook handler must mark
  // the bridge as "handling permission" BEFORE invoking aaService.evaluate,
  // so a Notification(permission_prompt) arriving while the LLM is still
  // running is suppressed instead of emitting a phantom Question (which
  // would fire a duplicate APNS push the user can't dismiss).
  // -------------------------------------------------------------------------

  test('regression #379: slow auto-approve approve does NOT leak a Notification question', async () => {
    // 80ms eval delay simulates ollama latency. Notification fires inside
    // the window; without the pre-emptive markPermissionHandled, this
    // Notification would emit a 3-option question and trigger a push.
    build({ autoApprove: true, autoApproveDecision: 'approve', autoApproveDelayMs: 80 });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-379',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-379',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // Notification fires ~10ms after PermissionRequest in real Claude Code;
    // schedule it well within the eval window so the race is exercised.
    await new Promise((resolve) => setTimeout(resolve, 10));
    hookServer.fire('Notification', {
      session_id: 'claude-locked-379',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    // Wait for evaluate() + inject() to fully resolve.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Approved: PTY received "1" once.
    expect(ptySubmits).toEqual(['1']);
    // Notification path must have been suppressed by the pre-emptive dedup.
    // Total questions emitted: zero (the auto-approve path is silent on success).
    expect(messageApiLog.questionCalls).toBe(0);
  });

  test('regression #379: escalate path emits the canonical Question exactly once', async () => {
    // When auto-approve cannot decide (e.g. 'escalate'), the user MUST see
    // a question. The Notification arriving during eval must still be
    // suppressed; the canonical question comes from handlePermissionRequest
    // via escalateToUser. Net: questionCalls === 1.
    build({ autoApprove: true, autoApproveDecision: 'escalate', autoApproveDelayMs: 80 });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-379b',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-379b',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    hookServer.fire('Notification', {
      session_id: 'claude-locked-379b',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    // No injection happened (escalate, main context).
    expect(ptySubmits).toEqual([]);
    // Exactly one question: the escalation, not the suppressed Notification.
    expect(messageApiLog.questionCalls).toBe(1);
  });
});
