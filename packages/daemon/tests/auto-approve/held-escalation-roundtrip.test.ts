/**
 * End-to-end round-trip for the Model B held-escalation push gap (#573).
 *
 * THE BUG (found by two holistic reviewers, hidden by the gap in this very
 * suite): when the gate HOLDS a binary escalation's PermissionRequest hook,
 * Claude blocks on the hook response and never renders its native numbered
 * prompt, so the tracker's `onPTYPromptVisible` push trigger NEVER fires. With
 * the pre-#573 wiring the question was only STASHED via `recordPendingHook` —
 * never registered in `sessionRegistry` and never pushed — so it was
 * unanswerable: the shared `handleAnswer` looked it up via `getQuestion`, got
 * null, and returned `'stale'` before ever reaching `resolveHeld`. The hold sat
 * in `pendingHolds` for the full `hold_timeout` then failed open.
 *
 * The pre-existing `hold-hook.test.ts` missed this because its `escalate` stub
 * synthesised a question id WITHOUT going through the bridge -> tracker ->
 * registry chain, and its push sink was a no-op; it then called `resolveHeld`
 * DIRECTLY, bypassing the `getQuestion` round-trip that was actually broken.
 *
 * This test assembles the REAL gate + tracker + sessionRegistry + the REAL
 * shared `handleAnswer` (the input-events core used by both the WebSocket
 * `onAnswer` and the HTTP `/answer` relay), wires the tracker's push sink to
 * `sessionRegistry.addQuestion` exactly as production's `onQuestion` callback
 * does, and proves the question is REGISTERED + PUSHED on a held escalation and
 * that the shared answer path resolves the hold to allow/deny (not 'stale').
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@remi/shared';
import type { Question, UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import {
  type AutoApproveEvaluator,
  AutoApproveGate,
} from '../../src/auto-approve/auto-approve-gate.ts';
import type { AutoApproveResult } from '../../src/auto-approve/types.ts';
import { createInputHandlers } from '../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';

/** Real-enough PTY that records every submitInput so the test can assert the
 *  held path does NOT type into the PTY (Claude is blocked on the hook). */
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

const escalate: AutoApproveResult = {
  decision: 'escalate',
  reasoning: 'test',
  durationMs: 0,
  model: 'm',
};

function evaluator(result: AutoApproveResult, delayMs = 0): AutoApproveEvaluator {
  return {
    evaluate: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return result;
    },
    cancel: () => true,
  };
}

/** A binary (Bash) PermissionRequest — no multi-choice suggestions, so the gate
 *  classifies it as holdable. */
function binaryPermission(over: Record<string, unknown> = {}): PermissionRequestHookInput {
  return {
    session_id: 'claude-test',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/d',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    ...over,
  } as unknown as PermissionRequestHookInput;
}

/** Default 3-option permission set (Yes / Yes always / No) with the binary
 *  flags the answer-mapper reads. Mirrors the bridge's DEFAULT_PERMISSION_OPTIONS
 *  shape closely enough for the round-trip. */
function defaultOptions() {
  return [
    { label: 'Yes', value: '1', isRecommended: true, isYes: true, isNo: false },
    { label: 'Yes, always', value: '2', isRecommended: false, isYes: true, isNo: false },
    { label: 'No', value: '3', isRecommended: false, isYes: false, isNo: true },
  ];
}

describe('Held escalation round-trip — register + push + shared answer (#573)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let tmpDir: string;
  let tracker: QuestionPresenceTracker;
  let pushes: Question[];
  let ptySubmits: string[];

  beforeEach(() => {
    configureLogger({ writeLog: () => {} });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-held-roundtrip-'));
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    ptySubmits = [];
    registry.registerSession(SID, '/d', fakePTY(ptySubmits), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);

    // Production push sink: push -> messageApi.handleQuestion -> onQuestion ->
    // sessionRegistry.addQuestion (+ maybePush). We collapse that into the sink
    // here: record the push (the APNS/in-app signal) AND register the question
    // in the registry, exactly as message-api-setup's onQuestion does.
    pushes = [];
    tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      registry.addQuestion(SID, q);
    });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a gate wired EXACTLY like hook-bridge-setup.ts:
   *   - escalate -> a real Question is built (with a stable id), stashed via
   *     tracker.recordPendingHook (NO push, like the real bridge), and the id
   *     returned;
   *   - onHeldEscalate -> tracker.pushHeldHook (the #573 fix).
   * Captures the id the escalate produced so the test can answer it.
   */
  function makeGate(
    service: AutoApproveEvaluator | null,
    pushHoldMs = 0,
  ): {
    gate: AutoApproveGate;
    lastQid: () => UUID | undefined;
  } {
    let lastQid: UUID | undefined;
    const gate = new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => false,
        escalate: (input) => {
          const qid = generateId() as UUID;
          // Mirror HookEventBridge.handlePermissionRequest: build the question,
          // stash it (recordPendingHook = onQuestion), return the id. No push.
          tracker.recordPendingHook({
            id: qid,
            text: `Allow Bash: ${(input.tool_input as { command?: string }).command ?? ''}`,
            options: defaultOptions(),
            allowsFreeText: false,
            isAnswered: false,
            source: 'permission_request',
          });
          lastQid = qid;
          return qid;
        },
        onHeldEscalate: (qid) => tracker.pushHeldHook(qid),
        holdMs: 60_000,
        pushHoldMs,
        alwaysEscalateTools: new Set(['AskUserQuestion', 'ExitPlanMode']),
      },
      SID,
    );
    return { gate, lastQid: () => lastQid };
  }

  /** Input handlers wired to resolve/release the gate's held hook, mirroring
   *  cli.ts's session-keyed gate handles. */
  function makeHandlers(gate: AutoApproveGate, sendCalls: unknown[] = []) {
    return createInputHandlers({
      sessionRegistry: registry,
      bindingStore,
      send: ((_c: UUID, m: unknown) => {
        sendCalls.push(m);
        return true;
      }) as never,
      resolveHeldPermission: (_s, q, d) => gate.resolveHeld(q, d),
      releaseHeldAsPassthrough: (_s, q) => gate.releaseHeldAsPassthrough(q),
      cancelAutoApprove: (_s, reason) => gate.cancelStale(reason),
    });
  }

  test('binary escalate (no service) REGISTERS + PUSHES, then "No" -> deny via shared handleAnswer', async () => {
    const { gate, lastQid } = makeGate(null); // no-service main escalates

    // The hook server blocks on this promise; the gate holds it.
    const decisionPromise = gate.resolvePermission(binaryPermission());

    // Let the synchronous escalate + onHeldEscalate run.
    await Promise.resolve();
    const qid = lastQid();
    expect(qid).toBeDefined();

    // (a) REGISTERED — this is what was broken: getQuestion must find it.
    const registered = registry.getQuestion(SID, qid as UUID);
    expect(registered).not.toBeNull();
    expect(registered?.id).toBe(qid as UUID);

    // (b) the push sink fired for that exact qid.
    expect(pushes.map((p) => p.id)).toContain(qid as UUID);

    // The hook is still HELD (no decision yet) and nothing typed into the PTY.
    let resolved = false;
    void decisionPromise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(ptySubmits).toEqual([]);

    // Answer "No" through the SHARED handleAnswer (WS onAnswer / relay core).
    const handlers = makeHandlers(gate);
    const outcome = await handlers.relayAnswer(SID, qid as UUID, 'No', undefined);
    expect(outcome).toBe('delivered'); // NOT 'stale'

    // The held hook resolved to 'deny' (the value Claude is unblocked with).
    await expect(decisionPromise).resolves.toBe('deny');
    // No PTY submit — Claude was blocked on the hook, not rendering a prompt.
    expect(ptySubmits).toEqual([]);
    // The answered question was consumed.
    expect(registry.getQuestion(SID, qid as UUID)).toBeNull();
  });

  test('"Yes" -> allow via shared handleAnswer (no PTY submit)', async () => {
    const { gate, lastQid } = makeGate(evaluator(escalate));
    const decisionPromise = gate.resolvePermission(binaryPermission());

    // Wait for the (async) eval to resolve escalate and the hold to register.
    await waitFor(
      () => lastQid() !== undefined && registry.getQuestion(SID, lastQid() as UUID) !== null,
    );
    const qid = lastQid() as UUID;
    expect(pushes.map((p) => p.id)).toContain(qid);

    const handlers = makeHandlers(gate);
    const outcome = await handlers.relayAnswer(SID, qid, 'Yes', undefined);
    expect(outcome).toBe('delivered');
    await expect(decisionPromise).resolves.toBe('allow');
    expect(ptySubmits).toEqual([]);
  });

  test('pushHeldHook is idempotent: a second call for the same qid does not double-register/push', async () => {
    const { gate, lastQid } = makeGate(null);
    void gate.resolvePermission(binaryPermission());
    await Promise.resolve();
    const qid = lastQid() as UUID;

    expect(pushes.filter((p) => p.id === qid).length).toBe(1);
    // Re-invoke the tracker method directly (simulating a stray re-fire): no-op.
    expect(tracker.pushHeldHook(qid)).toBe(false);
    expect(pushes.filter((p) => p.id === qid).length).toBe(1);
  });

  test('Part B early push (slow eval) also REGISTERS + PUSHES the held question', async () => {
    // Eval is slower (50ms) than push_hold_timeout (10ms): the slow-eval path
    // fires createHold early, which must push + register via onHeldEscalate.
    const { gate, lastQid } = makeGate(evaluator(escalate, 50), 10);
    const decisionPromise = gate.resolvePermission(binaryPermission());

    // The early push fires after ~10ms, before the 50ms eval settles.
    await waitFor(
      () => lastQid() !== undefined && registry.getQuestion(SID, lastQid() as UUID) !== null,
    );
    const qid = lastQid() as UUID;
    expect(pushes.map((p) => p.id)).toContain(qid);
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    // The user answers before / around the late verdict; the shared path resolves
    // the held hook to deny regardless of the late escalate verdict.
    const handlers = makeHandlers(gate);
    const outcome = await handlers.relayAnswer(SID, qid, 'No', undefined);
    expect(outcome).toBe('delivered');
    await expect(decisionPromise).resolves.toBe('deny');
    expect(ptySubmits).toEqual([]);
  });
});

/** Poll `cond` up to ~1s; throw if it never becomes true (real timing, no mock). */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: condition not met within 1s');
}
