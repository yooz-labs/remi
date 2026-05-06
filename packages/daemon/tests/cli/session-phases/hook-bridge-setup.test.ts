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

/** PTYSession fake that tracks submitInput calls (drives the auto-approve inject assertions).
 *  When throws=true, submitInput rejects to exercise the inject() cancellation path. */
function fakePTY(submits: string[], opts: { throws?: boolean } = {}): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async (content: string) => {
      submits.push(content);
      if (opts.throws) {
        throw new Error('test: submitInput synthetic failure');
      }
    },
    close: async () => {},
  } as unknown as PTYSession;
}

interface MessageApiCallLog {
  resetCalls: { n: number };
  statusCalls: string[];
  questionCalls: number;
}

function fakeMessageAPI(
  log: MessageApiCallLog,
  opts: { throwOnQuestionTimes?: number } = {},
): MessageAPI {
  let throwsLeft = opts.throwOnQuestionTimes ?? 0;
  return {
    handleMessage: () => {},
    handleStatusChange: (status: string) => {
      log.statusCalls.push(status);
    },
    handleQuestion: () => {
      log.questionCalls += 1;
      if (throwsLeft > 0) {
        throwsLeft -= 1;
        throw new Error('test: handleQuestion synthetic failure');
      }
    },
    reset: () => {
      log.resetCalls.n += 1;
    },
  } as unknown as MessageAPI;
}

/** Poll a predicate until true or timeout. Used in lieu of fixed-duration
 *  setTimeout waits in async tests so we don't depend on CI scheduler luck. */
async function until(predicate: () => boolean, timeoutMs = 1000, pollMs = 5): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!predicate()) {
    throw new Error(`until() timed out after ${timeoutMs}ms`);
  }
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
      autoApproveThrows?: boolean;
      throwOnQuestionTimes?: number;
      injectAckTimeoutMs?: number;
      submitInputThrows?: boolean;
    } = {},
  ) {
    sessionRegistry.registerSession(
      SID,
      tmpDir,
      fakePTY(ptySubmits, opts.submitInputThrows ? { throws: true } : {}),
      fakeMessageAPI(
        messageApiLog,
        opts.throwOnQuestionTimes !== undefined
          ? { throwOnQuestionTimes: opts.throwOnQuestionTimes }
          : {},
      ),
    );

    // Minimal AutoApproveService stub. Only invoked when opts.autoApprove is
    // true; default decision is 'approve' (existing tests rely on this).
    // `autoApproveDelayMs` simulates LLM eval latency so dedup-window tests
    // can fire Notification while evaluate() is still in flight (#379).
    // `autoApproveThrows` exercises the outer .catch() handler.
    const autoApproveService = opts.autoApprove
      ? ({
          evaluate: async () => {
            if (opts.autoApproveDelayMs && opts.autoApproveDelayMs > 0) {
              await new Promise((r) => setTimeout(r, opts.autoApproveDelayMs));
            }
            if (opts.autoApproveThrows) {
              throw new Error('test: ollama down');
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
        messageApi: fakeMessageAPI(
          messageApiLog,
          opts.throwOnQuestionTimes !== undefined
            ? { throwOnQuestionTimes: opts.throwOnQuestionTimes }
            : {},
        ),
        sendAndRecord: () => {},
        ...(opts.injectAckTimeoutMs !== undefined
          ? { injectAckTimeoutMs: opts.injectAckTimeoutMs }
          : {}),
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
    await until(() => ptySubmits.length >= 1);

    // Approved: PTY received "1" once.
    expect(ptySubmits).toEqual(['1']);
    // Notification path must have been suppressed by the pre-emptive dedup.
    // Total questions emitted: zero (the auto-approve path is silent on success).
    expect(messageApiLog.questionCalls).toBe(0);
  });

  test('regression #379: slow auto-approve DENY does NOT leak a Notification question', async () => {
    // Mirror of the approve test; the deny path also injects (with "3")
    // and must benefit from the same pre-emptive dedup. Without it, the
    // mid-flight Notification would emit a phantom approve-style 3-option
    // question while the daemon was about to silently deny.
    build({ autoApprove: true, autoApproveDecision: 'deny', autoApproveDelayMs: 80 });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-379-deny',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-379-deny',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    hookServer.fire('Notification', {
      session_id: 'claude-locked-379-deny',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    await until(() => ptySubmits.length >= 1);

    expect(ptySubmits).toEqual(['3']);
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

    await until(() => messageApiLog.questionCalls >= 1);

    // No injection happened (escalate, main context).
    expect(ptySubmits).toEqual([]);
    // Exactly one question: the escalation, not the suppressed Notification.
    expect(messageApiLog.questionCalls).toBe(1);
  });

  test('regression #379: evaluate() throws -> escalates to user, Notification suppressed', async () => {
    // Outer .catch() runs when ollama dies mid-eval. Main-session context
    // hits escalateToUser -> handlePermissionRequest emits canonical Q. The
    // Notification fired during the eval window must still be suppressed.
    build({ autoApprove: true, autoApproveThrows: true, autoApproveDelayMs: 80 });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-379c',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-379c',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    hookServer.fire('Notification', {
      session_id: 'claude-locked-379c',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    await until(() => messageApiLog.questionCalls >= 1);

    expect(ptySubmits).toEqual([]);
    expect(messageApiLog.questionCalls).toBe(1);
  });

  test('regression #381 audit: escalate throws -> dedup mark cleared so Notification fallback fires', async () => {
    // Silent-failure-hunter B2: if escalateToUser() throws (push fan-out
    // failure, WS send on a half-closed adapter, etc.) the user used to be
    // left with NOTHING — pre-emptive dedup suppressed the trailing
    // Notification. Now the catch handler clears the dedup mark, so the
    // Notification fallback gets to surface a question.
    build({
      autoApprove: true,
      autoApproveDecision: 'escalate',
      autoApproveDelayMs: 30,
      throwOnQuestionTimes: 1, // first onQuestion (escalation) throws; Notification fallback succeeds
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-381a',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-381a',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // Wait until escalation has been attempted (questionCalls increments
    // even when the call throws — fakeMessageAPI counts on entry).
    await until(() => messageApiLog.questionCalls >= 1);

    // Now fire the Notification AFTER escalation has thrown. Without the
    // clearPermissionHandled() call in escalateToUser's catch, the dedup
    // mark would still be active and this Notification would be suppressed.
    hookServer.fire('Notification', {
      session_id: 'claude-locked-381a',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    await until(() => messageApiLog.questionCalls >= 2);

    // Two attempts: 1 escalation (threw), 1 Notification fallback (succeeded
    // for counting purposes; throwOnQuestion fires on every call but the
    // counter increments before the throw so we observe the call).
    expect(messageApiLog.questionCalls).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Issue #382: PTY inject ack timeout. submitInput is fire-and-forget, so a
  // stuck PTY can swallow the byte while inject() reports success. Combined
  // with the pre-emptive dedup mark (#379/#381), the user would see no
  // PTY answer, no question, and no APNS push -- a hard regression compared
  // to the pre-#381 phantom-Notification behaviour. The fix registers a
  // PendingAck around submitInput and escalates if no follow-up hook event
  // arrives within the timeout.
  // -------------------------------------------------------------------------

  test('regression #382: approve + PostToolUse arrives in time -> no escalation', async () => {
    // Happy path: the auto-approve injects "1", Claude proceeds with the
    // tool call, PostToolUse fires within the ack window. No timeout, no
    // escalation. questionCalls stays at 0.
    build({
      autoApprove: true,
      autoApproveDecision: 'approve',
      injectAckTimeoutMs: 100,
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-382a',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-382a',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await until(() => ptySubmits.length >= 1);
    expect(ptySubmits).toEqual(['1']);

    // Simulate Claude advancing past the prompt: PostToolUse for the tool.
    hookServer.fire('PostToolUse', {
      session_id: 'claude-locked-382a',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tool-use-382a',
      tool_input: { command: 'ls' },
      tool_output: { exit_code: 0 },
    });

    // Wait past 2.5x the ack timeout to leave headroom for CI scheduler
    // jitter (a Bun timer + microtask flush on a loaded macOS runner has
    // shown >40 ms drift). If a late timeout escalation slips through,
    // questionCalls becomes 1 and this assertion fails.
    await new Promise((r) => setTimeout(r, 250));
    expect(messageApiLog.questionCalls).toBe(0);
  });

  test('regression #382: approve + no follow-up event -> ack timeout escalates', async () => {
    // Silent PTY scenario: inject reports success but no PreToolUse /
    // PostToolUse / Stop arrives. The ack timer fires, clears the dedup
    // mark, and emits the canonical question via escalateToUser.
    build({
      autoApprove: true,
      autoApproveDecision: 'approve',
      injectAckTimeoutMs: 100,
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-382b',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-382b',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await until(() => ptySubmits.length >= 1);
    expect(ptySubmits).toEqual(['1']);

    // No follow-up event: ack timer should fire and emit a fallback Q.
    await until(() => messageApiLog.questionCalls >= 1, 1000);
    expect(messageApiLog.questionCalls).toBe(1);
  });

  test('regression #382: deny + Stop arrives in time -> no escalation', async () => {
    // Mirror of the approve happy path for the deny branch. Stop is the
    // expected ack signal when Claude abandons the requested tool.
    build({
      autoApprove: true,
      autoApproveDecision: 'deny',
      injectAckTimeoutMs: 100,
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-382c',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-382c',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    await until(() => ptySubmits.length >= 1);
    expect(ptySubmits).toEqual(['3']);

    hookServer.fire('Stop', {
      session_id: 'claude-locked-382c',
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(messageApiLog.questionCalls).toBe(0);
  });

  // (The previous "ack timeout AFTER Notification dedup expired" test was
  // dropped: the timeout path's explicit clearPermissionHandled() is
  // defensive -- handlePermissionRequest immediately re-arms
  // lastPermissionEmitAt when escalateToUser emits, so a late Notification
  // is correctly suppressed as a duplicate of the canonical escalation.
  // The meaningful "timeout -> escalation fires" behavior is covered by
  // the "approve + no follow-up event" test above.)

  test('regression #382: submitInput throws -> ack cancelled, single escalation only', async () => {
    // inject() catch path: cancel pendingAck before returning false so the
    // caller's escalateToUser fires once, not once + a stale timeout
    // escalation a second later.
    build({
      autoApprove: true,
      autoApproveDecision: 'approve',
      injectAckTimeoutMs: 100,
      submitInputThrows: true,
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-382e',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-382e',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // PTY recorded the byte (fakePTY pushes BEFORE throwing) but inject
    // returned false; caller escalates once via the inject-failure path.
    await until(() => messageApiLog.questionCalls >= 1, 500);
    expect(messageApiLog.questionCalls).toBe(1);

    // Wait past the ack timeout to confirm no SECOND escalation lands.
    await new Promise((r) => setTimeout(r, 250));
    expect(messageApiLog.questionCalls).toBe(1);
  });

  test('regression #382: default ack timeout is non-trivial (no override -> no fast escalation)', async () => {
    // Pins the args.injectAckTimeoutMs ?? 1000 fallback. If a refactor
    // dropped the default and the field became required (or undefined
    // -> setTimeout interpreted as 1ms), the timer would fire almost
    // immediately and escalate during this 200 ms quiet window.
    build({ autoApprove: true, autoApproveDecision: 'approve' }); // no injectAckTimeoutMs

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-382f',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-382f',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await until(() => ptySubmits.length >= 1);
    expect(ptySubmits).toEqual(['1']);

    // 200 ms is a fraction of the 1000 ms default; no escalation expected.
    await new Promise((r) => setTimeout(r, 200));
    expect(messageApiLog.questionCalls).toBe(0);
  });

  test('regression #382: Notification(idle_prompt) resolves the ack (Edit-style approve)', async () => {
    // When auto-approve approves an Edit (the same tool that triggered
    // the prompt), Claude doesn't fire a fresh PreToolUse. The next
    // signal that "Claude moved on" is often a Notification(idle_prompt).
    // Code-reviewer flagged this as a phantom-escalation gap; this test
    // pins ackAllPending() being called from the Notification handler
    // when the type is anything other than permission_prompt.
    build({
      autoApprove: true,
      autoApproveDecision: 'approve',
      injectAckTimeoutMs: 100,
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-382g',
      transcript_path: path.join(tmpDir, 't.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-382g',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts', old_str: 'a', new_str: 'b' },
    });

    await until(() => ptySubmits.length >= 1);
    expect(ptySubmits).toEqual(['1']);

    // idle_prompt is a "Claude moved on" signal -- must ack the pending
    // inject so the timer doesn't fire a phantom escalation.
    hookServer.fire('Notification', {
      session_id: 'claude-locked-382g',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: '',
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(messageApiLog.questionCalls).toBe(0);
  });
});
