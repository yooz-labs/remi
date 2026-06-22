/**
 * Tests for per-eval cancellation + force-release at the AutoApproveGate level
 * (#617). A REAL gate is driven with a controllable evaluator object (no mocks,
 * per the gate's seam contract): its `evaluate` hangs so Part B's early push +
 * hold fires WHILE the eval is still running — the one window where the user can
 * answer mid-eval — and its `cancel`/`drainQueue` record the calls the gate makes.
 *
 * Covers the user's critical "answer == GPU freed" contract: a manual answer for
 * question X cancels exactly X's eval and never another permission's, and the
 * force-release escape (`remi unstick`) releases holds + cancels + drains.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import {
  type AutoApproveEvaluator,
  AutoApproveGate,
} from '../../src/auto-approve/auto-approve-gate.ts';
import type { AutoApproveResult } from '../../src/auto-approve/types.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

/** A controllable evaluator whose eval hangs until cancelled, recording the
 *  eval ids it was handed and every cancel / drainQueue call. */
function controllableEvaluator() {
  const cancelCalls: Array<{ reason: string; evalId: number | undefined }> = [];
  const evalIds: Array<number | undefined> = [];
  let drainCount = 0;
  let resolveEval: ((r: AutoApproveResult) => void) | null = null;
  const evaluator: AutoApproveEvaluator = {
    evaluate: (_t, _i, _tag, _sugg, _model, evalId) => {
      evalIds.push(evalId);
      return new Promise<AutoApproveResult>((resolve) => {
        resolveEval = resolve;
      });
    },
    cancel: (reason, evalId) => {
      cancelCalls.push({ reason, evalId });
      // Mimic the abort surfacing as a cancelled verdict so the eval settles.
      resolveEval?.({ decision: 'cancelled', reasoning: reason, durationMs: 0 });
      return true;
    },
    drainQueue: () => {
      drainCount++;
      return 0;
    },
  };
  return { evaluator, cancelCalls, evalIds, drainCount: () => drainCount };
}

function permission(over: Record<string, unknown> = {}): never {
  return {
    session_id: 'claude-test',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/d',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    ...over,
  } as never;
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('per-eval cancellation + force-release (#617)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let lastQuestionId: UUID | undefined;
  let harness: ReturnType<typeof controllableEvaluator>;
  let gate: AutoApproveGate;

  beforeEach(() => {
    configureLogger({ writeLog: () => {} });
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    lastQuestionId = undefined;
    harness = controllableEvaluator();
    gate = new AutoApproveGate(
      {
        service: harness.evaluator,
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => {
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        onHeldEscalate: () => {},
        holdMs: 60_000,
        // Tiny window so the early push + hold fires while the eval still hangs.
        pushHoldMs: 10,
        alwaysEscalateTools: new Set(['AskUserQuestion', 'ExitPlanMode']),
      },
      SID,
    );
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('a manual answer cancels EXACTLY the held question’s eval (the eval id Part B captured)', async () => {
    const decision = gate.resolvePermission(permission());
    await waitFor(() => lastQuestionId !== undefined);
    const qid = lastQuestionId as UUID;
    // Part B handed the eval an id; that exact id must be the cancel target.
    const evalId = harness.evalIds[0];
    expect(typeof evalId).toBe('number');

    gate.cancelEvalForQuestion(qid, 'user-answered');

    expect(harness.cancelCalls).toEqual([{ reason: 'user-answered', evalId }]);
    // The hold reconciles to passthrough once the eval settles cancelled.
    expect(await decision).toBe('passthrough');
  });

  test('cancelEvalForQuestion is a no-op for a question with no tracked eval (never wrong-victim)', async () => {
    gate.resolvePermission(permission());
    await waitFor(() => lastQuestionId !== undefined);
    // A different/unknown question id must not cancel the running eval.
    gate.cancelEvalForQuestion(generateId() as UUID, 'user-answered');
    expect(harness.cancelCalls).toEqual([]);
  });

  test('forceRelease releases the hold to passthrough, cancels the eval, and drains the queue', async () => {
    const decision = gate.resolvePermission(permission());
    await waitFor(() => lastQuestionId !== undefined);

    const summary = gate.forceRelease('force-release (remi unstick)');

    expect(summary.holds).toBe(1);
    expect(summary.cancelled).toBe(true);
    // The held hook fails open to the native terminal prompt.
    expect(await decision).toBe('passthrough');
    // cancel was called WITHOUT an eval id (abort whatever runs), and the queue drained.
    expect(harness.cancelCalls).toEqual([
      { reason: 'force-release (remi unstick)', evalId: undefined },
    ]);
    expect(harness.drainCount()).toBe(1);
  });

  test('forceRelease with no holds / no service is a safe no-op summary', () => {
    const idle = new AutoApproveGate(
      {
        service: null,
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => generateId(),
      },
      SID,
    );
    expect(idle.forceRelease('unstick')).toEqual({ holds: 0, cancelled: false, drained: 0 });
  });
});
