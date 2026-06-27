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
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';
import type { DeliveryOutcome } from '../../src/notifications/notification-dispatcher.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

// Real test double for the PTY: records every submitInput so inject() is
// observable. `throws` exercises the inject() failure -> escalate fallback.
function fakePTY(submits: string[], opts: { throws?: boolean } = {}): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async (content: string) => {
      submits.push(content);
      if (opts.throws) throw new Error('test: submitInput synthetic failure');
    },
    close: async () => {},
  } as unknown as PTYSession;
}

// Real AutoApproveResult builders (no mock framework; plain domain objects).
const approve: AutoApproveResult = {
  decision: 'approve',
  reasoning: 't',
  durationMs: 0,
  model: 'm',
};
const deny: AutoApproveResult = { decision: 'deny', reasoning: 't', durationMs: 0, model: 'm' };
const escalate: AutoApproveResult = {
  decision: 'escalate',
  reasoning: 't',
  durationMs: 0,
  model: 'm',
};
const cancelled: AutoApproveResult = { decision: 'cancelled', reasoning: 't', durationMs: 0 };
const pick = (pickIndex: number): AutoApproveResult => ({
  decision: 'pick',
  pickIndex,
  reasoning: 't',
  durationMs: 0,
  model: 'm',
});

describe('AutoApproveGate', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let submits: string[];
  let escalations: PermissionRequestHookInput[];
  let cancels: string[];
  let tracker: QuestionPresenceTracker;
  let subagent: boolean;

  function evaluator(
    result: AutoApproveResult,
    opts: { throws?: boolean } = {},
  ): AutoApproveEvaluator {
    return {
      evaluate: async () => {
        if (opts.throws) throw new Error('test: llm provider down');
        return result;
      },
      cancel: (reason: string) => {
        cancels.push(reason);
        return true;
      },
    };
  }

  function gateWith(service: AutoApproveEvaluator | null, ptyThrows = false): AutoApproveGate {
    // (Re)register the session with the desired PTY behavior.
    registry.registerSession(SID, '/d', fakePTY(submits, { throws: ptyThrows }), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => subagent,
        escalate: (i) => {
          escalations.push(i);
          return generateId();
        },
      },
      SID,
    );
  }

  /** Gate whose PRIMARY model escalates but whose escalate_model ('big-model')
   *  returns `secondResult` (#522 second opinion). */
  function gateWithSecondOpinion(secondResult: AutoApproveResult): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY(submits), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    const service: AutoApproveEvaluator = {
      evaluate: async (_t, _i, _tag, _s, modelOverride) =>
        modelOverride === 'big-model' ? secondResult : escalate,
      cancel: () => true,
    };
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => subagent,
        escalate: (i) => {
          escalations.push(i);
          return generateId();
        },
        escalateModel: 'big-model',
      },
      SID,
    );
  }

  function pr(over: Partial<PermissionRequestHookInput> = {}): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      ...over,
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    submits = [];
    escalations = [];
    cancels = [];
    subagent = false;
    tracker = new QuestionPresenceTracker(() => {});
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('approve returns "allow" with NO inject (main context) (#496)', async () => {
    const d = await gateWith(evaluator(approve)).resolvePermission(pr());
    expect(d).toBe('allow');
    expect(submits).toHaveLength(0); // synchronous decision, no PTY inject
    expect(escalations).toHaveLength(0);
  });

  test('deny returns "deny" with NO inject (main context) (#496)', async () => {
    const d = await gateWith(evaluator(deny)).resolvePermission(pr());
    expect(d).toBe('deny');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('pick injects the 1-based index and returns passthrough (main context)', async () => {
    const d = await gateWith(evaluator(pick(2))).resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(submits).toEqual(['2']);
    expect(escalations).toHaveLength(0);
  });

  test('malformed pick (no pickIndex) escalates, never silently denies (#521 review)', async () => {
    const malformed = {
      decision: 'pick',
      reasoning: 't',
      durationMs: 0,
      model: 'm',
    } as unknown as AutoApproveResult;
    const d = await gateWith({
      evaluate: async () => malformed,
      cancel: () => true,
    }).resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(1);
  });

  test('escalate in main context escalates + passthrough, never injects', async () => {
    const d = await gateWith(evaluator(escalate)).resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.tool_name).toBe('Bash');
  });

  test('escalate that THROWS still fires onEscalate (buffer must not stick) (#484)', async () => {
    // The worst outcome is a stuck buffer that silently drops later prompts.
    // onEscalate is in a finally, so it runs even when the escalate target throws.
    let onEscalateCalls = 0;
    registry.registerSession(SID, '/d', fakePTY(submits), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    const gate = new AutoApproveGate(
      {
        service: evaluator(escalate),
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => false,
        escalate: () => {
          throw new Error('test: escalate target down');
        },
        onEscalate: () => {
          onEscalateCalls++;
        },
      },
      SID,
    );
    const d = await gate.resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(onEscalateCalls).toBe(1);
  });

  test('escalate in subagent context default-denies via the response, no inject (#496)', async () => {
    subagent = true;
    const d = await gateWith(evaluator(escalate)).resolvePermission(pr());
    expect(d).toBe('deny');
    expect(submits).toHaveLength(0); // the core fix: deny without touching the PTY
    expect(escalations).toHaveLength(0);
  });

  test('cancelled clears the tracker pending and returns passthrough; no inject/escalate', async () => {
    // Stash a pending hook so clearPending() is observable.
    tracker.recordPendingHook({
      id: generateId(),
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    expect(tracker.hasPendingForTest()).toBe(true);

    const d = await gateWith(evaluator(cancelled)).resolvePermission(pr());

    expect(d).toBe('passthrough');
    expect(tracker.hasPendingForTest()).toBe(false);
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('approve in a subagent returns "allow" with NO inject (no leak; #496)', async () => {
    // The headline fix: approve no longer needs the PTY, so a parallel subagent
    // read approves with no inject and no contention, regardless of presence.
    subagent = true;
    const d = await gateWith(evaluator(approve)).resolvePermission(pr());
    expect(d).toBe('allow');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('pick in a subagent without PTY presence is gated -> escalate (the only inject path)', async () => {
    subagent = true; // background subagent, prompt not on the main PTY
    const d = await gateWith(evaluator(pick(2))).resolvePermission(pr());
    expect(submits).toHaveLength(0); // PTY-presence gate blocked the pick inject
    expect(escalations).toHaveLength(1); // pick has a fallback -> escalate
    expect(d).toBe('passthrough');
  });

  test('pick in a subagent WITH PTY presence injects', async () => {
    subagent = true;
    tracker.onPTYPromptVisible({
      id: generateId(),
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    const d = await gateWith(evaluator(pick(2))).resolvePermission(pr());
    expect(submits).toEqual(['2']);
    expect(d).toBe('passthrough');
  });

  test('pick inject failure (PTY throws) falls back to escalate (main context)', async () => {
    const d = await gateWith(evaluator(pick(2)), /* ptyThrows */ true).resolvePermission(pr());
    expect(escalations).toHaveLength(1);
    expect(d).toBe('passthrough');
  });

  test('eval rejection in main context escalates + passthrough', async () => {
    const d = await gateWith(evaluator(approve, { throws: true })).resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(1);
  });

  test('eval rejection in subagent context default-denies via the response', async () => {
    subagent = true;
    const d = await gateWith(evaluator(approve, { throws: true })).resolvePermission(pr());
    expect(d).toBe('deny');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('no service + subagent: default-deny via the response', async () => {
    subagent = true;
    const d = await gateWith(null).resolvePermission(pr());
    expect(d).toBe('deny');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('no service + main context: escalate to user, passthrough', async () => {
    const d = await gateWith(null).resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(1);
  });

  test('escalate_model second opinion approves -> "allow" (no escalation) (#522)', async () => {
    const d = await gateWithSecondOpinion(approve).resolvePermission(pr());
    expect(d).toBe('allow');
    expect(escalations).toHaveLength(0);
    expect(submits).toHaveLength(0);
  });

  test('escalate_model second opinion denies -> "deny" (no escalation) (#522)', async () => {
    const d = await gateWithSecondOpinion(deny).resolvePermission(pr());
    expect(d).toBe('deny');
    expect(escalations).toHaveLength(0);
    expect(submits).toHaveLength(0);
  });

  test('escalate_model still unsure -> escalate to the user (#522)', async () => {
    const d = await gateWithSecondOpinion(escalate).resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(escalations).toHaveLength(1);
  });

  test('escalate_model cancelled -> passthrough, clears pending, no phantom escalation (#523 review)', async () => {
    tracker.recordPendingHook({
      id: generateId(),
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    const d = await gateWithSecondOpinion(cancelled).resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(escalations).toHaveLength(0); // no phantom question
    expect(tracker.hasPendingForTest()).toBe(false); // pending cleared
  });

  test('escalate_model is NOT consulted in a subagent context (denies via response) (#522)', async () => {
    subagent = true;
    const d = await gateWithSecondOpinion(approve).resolvePermission(pr());
    // Subagent escalate denies directly; the second opinion (which would allow)
    // must not run, since the user could not answer a subagent prompt anyway.
    expect(d).toBe('deny');
    expect(escalations).toHaveLength(0);
  });

  test('cancelStale forwards the reason to service.cancel', () => {
    gateWith(evaluator(approve)).cancelStale('PreToolUse');
    expect(cancels).toEqual(['PreToolUse']);
  });

  test('cancelStale is a no-op when no service is configured', () => {
    expect(() => gateWith(null).cancelStale('Stop')).not.toThrow();
    expect(cancels).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle callbacks that drive the terminal cue (#513). They must fire on the
// matching verdict and never cross-fire (a leaked spinner / missed notification
// would be the symptom).
// ---------------------------------------------------------------------------
describe('AutoApproveGate lifecycle callbacks (#513)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let submits: string[];
  let events: string[];
  let tracker: QuestionPresenceTracker;
  let subagent: boolean;

  function evaluator(result: AutoApproveResult): AutoApproveEvaluator {
    return { evaluate: async () => result, cancel: () => true };
  }

  function gate(service: AutoApproveEvaluator, ptyThrows = false): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY(submits, { throws: ptyThrows }), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => subagent,
        escalate: () => undefined,
        onEvalStart: () => events.push('start'),
        onEscalate: () => events.push('escalate'),
        onHandled: () => events.push('handled'),
        onCancelled: () => events.push('cancelled'),
      },
      SID,
    );
  }

  function pr(): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    submits = [];
    events = [];
    subagent = false;
    tracker = new QuestionPresenceTracker(() => {});
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('approve fires start then handled (never escalate/cancelled)', async () => {
    expect(await gate(evaluator(approve)).resolvePermission(pr())).toBe('allow');
    expect(events).toEqual(['start', 'handled']);
  });

  test('deny fires start then handled', async () => {
    expect(await gate(evaluator(deny)).resolvePermission(pr())).toBe('deny');
    expect(events).toEqual(['start', 'handled']);
  });

  test('escalate fires start then escalate (never handled)', async () => {
    expect(await gate(evaluator(escalate)).resolvePermission(pr())).toBe('passthrough');
    expect(events).toEqual(['start', 'escalate']);
  });

  test('cancelled fires start then cancelled (never handled/escalate)', async () => {
    expect(await gate(evaluator(cancelled)).resolvePermission(pr())).toBe('passthrough');
    expect(events).toEqual(['start', 'cancelled']);
  });

  test('pick whose inject fails escalates -> start then escalate (not handled)', async () => {
    // approve/deny no longer inject; the inject-failure->escalate path is now pick-only.
    expect(await gate(evaluator(pick(2)), /* ptyThrows */ true).resolvePermission(pr())).toBe(
      'passthrough',
    );
    expect(events).toEqual(['start', 'escalate']);
  });

  test('subagent escalate->deny still fires handled (buffer + cue close), no inject', async () => {
    subagent = true;
    expect(await gate(evaluator(escalate)).resolvePermission(pr())).toBe('deny');
    // Subagent escalate default-denies via the RESPONSE (no inject) -> markHandled.
    expect(submits).toHaveLength(0);
    expect(events).toEqual(['start', 'handled']);
  });

  test('a throwing cue callback is absorbed: decision not re-run, no re-escalation', async () => {
    // The cue is cosmetic. If onHandled throws it must NOT change the verdict
    // (approve stays 'allow') or trigger an escalation.
    registry.registerSession(SID, '/d', fakePTY(submits), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    let escalations = 0;
    const g = new AutoApproveGate(
      {
        service: evaluator(approve),
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => false,
        escalate: () => {
          escalations++;
          return undefined;
        },
        onHandled: () => {
          throw new Error('test: cue boom');
        },
      },
      SID,
    );
    expect(await g.resolvePermission(pr())).toBe('allow'); // approved once, verdict intact
    expect(escalations).toBe(0); // no re-escalation
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (#573): hold the hook (Model B) + resolve-on-answer + slow-eval push.
// All real objects (no mock framework): a plain evaluator literal returns real
// AutoApproveResult values, and the held hook is a real pending promise.
// ---------------------------------------------------------------------------
describe('AutoApproveGate hold + resolve (#573 Parts A/C)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let submits: string[];
  let escalations: PermissionRequestHookInput[];
  let lastQuestionId: UUID | undefined;
  // #625: every gate-driven push (binary createHold AND passthrough escalate) is
  // recorded here so a test can assert push <=> escalate and that approve/deny push
  // nothing. The held-push primitive is onHeldEscalate -> tracker.pushHeldHook.
  let heldPushes: UUID[];

  function evaluator(result: AutoApproveResult): AutoApproveEvaluator {
    return { evaluate: async () => result, cancel: () => true };
  }

  /** A gate that escalates (recording the created Question.id) and holds binary
   *  main-context hooks for `holdMs`. The created id is exposed via
   *  `lastQuestionId` so tests can resolve the hold. */
  function holdGate(
    service: AutoApproveEvaluator | null,
    opts: {
      holdMs?: number;
      subagent?: boolean;
      alwaysEscalateTools?: ReadonlySet<string>;
      /** PTY.submitInput throws — exercises inject() failure -> escalatePassthrough. */
      ptyThrows?: boolean;
      /** escalate() returns undefined (push creation failed) — exercises the
       *  escalatePassthrough `qid === undefined` skip-push branch (#625). */
      escalateUndefined?: boolean;
    } = {},
  ): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY(submits, { throws: opts.ptyThrows ?? false }), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    const tracker = new QuestionPresenceTracker(() => {});
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => opts.subagent ?? false,
        escalate: (i) => {
          escalations.push(i);
          if (opts.escalateUndefined) {
            lastQuestionId = undefined;
            return undefined;
          }
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        onHeldEscalate: (qid) => {
          heldPushes.push(qid);
        },
        holdMs: opts.holdMs ?? 60_000,
        alwaysEscalateTools:
          opts.alwaysEscalateTools ?? new Set(['AskUserQuestion', 'ExitPlanMode']),
      },
      SID,
    );
  }

  function pr(over: Partial<PermissionRequestHookInput> = {}): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      ...over,
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    submits = [];
    escalations = [];
    lastQuestionId = undefined;
    heldPushes = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('binary escalate WITHHOLDS the decision until resolveHeld -> allow', async () => {
    const gate = holdGate(evaluator(escalate));
    const pending = gate.resolvePermission(pr());
    // Give the eval + escalate a tick; the promise must still be pending (held).
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(escalations).toHaveLength(1);
    expect(lastQuestionId).toBeDefined();

    // The user answers Yes -> the held hook resolves 'allow'.
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(true);
    expect(await pending).toBe('allow');
  });

  test('binary escalate held -> deny when the user answers No', async () => {
    const gate = holdGate(evaluator(escalate));
    const pending = gate.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    expect(gate.resolveHeld(lastQuestionId as UUID, 'deny')).toBe(true);
    expect(await pending).toBe('deny');
  });

  test('resolveHeld for an unknown id returns false (non-held answer)', async () => {
    const gate = holdGate(evaluator(escalate));
    const pending = gate.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    expect(gate.resolveHeld(generateId() as UUID, 'allow')).toBe(false);
    // The real hold is still pending; resolve it to avoid a dangling promise.
    gate.resolveHeld(lastQuestionId as UUID, 'allow');
    await pending;
  });

  test('multi-choice escalate returns passthrough immediately (NO hold)', async () => {
    // 4+ string suggestions => multi-choice; the hook response cannot pick.
    const gate = holdGate(evaluator(escalate));
    const d = await gate.resolvePermission(
      pr({ permission_suggestions: ['Alpha', 'Beta', 'Gamma', 'Delta'] }),
    );
    expect(d).toBe('passthrough');
    expect(escalations).toHaveLength(1);
  });

  test('design question escalate returns passthrough immediately (NO hold)', async () => {
    const gate = holdGate(evaluator(escalate));
    // AskUserQuestion is in always_escalate_tools -> design -> not binary.
    const d = await gate.resolvePermission(
      pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'Which approach?' } }),
    );
    expect(d).toBe('passthrough');
    expect(escalations).toHaveLength(1);
  });

  // #625 single gate: the gate is the SOLE push trigger. A passthrough escalation
  // (design / AskUserQuestion / multi-choice) must push from the gate too — it can no
  // longer rely on the PTY render, which is suppressed for hooked sessions.
  test('#625 design (AskUserQuestion) escalate pushes from the gate (onHeldEscalate)', async () => {
    const gate = holdGate(evaluator(escalate));
    await gate.resolvePermission(
      pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'Which approach?' } }),
    );
    expect(escalations).toHaveLength(1);
    expect(heldPushes).toEqual([lastQuestionId as UUID]);
  });

  test('#625 multi-choice escalate pushes from the gate (onHeldEscalate)', async () => {
    const gate = holdGate(evaluator(escalate));
    await gate.resolvePermission(
      pr({ permission_suggestions: ['Alpha', 'Beta', 'Gamma', 'Delta'] }),
    );
    expect(heldPushes).toEqual([lastQuestionId as UUID]);
  });

  test('#625 binary escalate also pushes from the gate (createHold path)', async () => {
    const gate = holdGate(evaluator(escalate));
    const pending = gate.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    expect(heldPushes).toEqual([lastQuestionId as UUID]);
    gate.resolveHeld(lastQuestionId as UUID, 'allow');
    await pending;
  });

  test('#625 approve pushes NOTHING (no phantom)', async () => {
    const gate = holdGate(evaluator(approve));
    const d = await gate.resolvePermission(pr());
    expect(d).toBe('allow');
    expect(heldPushes).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('#625 deny pushes NOTHING (no phantom)', async () => {
    const gate = holdGate(evaluator(deny));
    const d = await gate.resolvePermission(pr());
    expect(d).toBe('deny');
    expect(heldPushes).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('#625 malformed pick (no pickIndex) escalates AND pushes from the gate', async () => {
    const malformedPick = {
      decision: 'pick',
      reasoning: 't',
      durationMs: 0,
      model: 'm',
    } as unknown as AutoApproveResult;
    const gate = holdGate(evaluator(malformedPick));
    const d = await gate.resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(escalations).toHaveLength(1);
    expect(heldPushes).toEqual([lastQuestionId as UUID]);
  });

  test('#625 pick inject failure (PTY throws) escalates AND pushes from the gate', async () => {
    const gate = holdGate(evaluator(pick(2)), { ptyThrows: true });
    const d = await gate.resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(submits).toEqual(['2']); // inject was attempted before it threw
    expect(escalations).toHaveLength(1);
    expect(heldPushes).toEqual([lastQuestionId as UUID]);
  });

  test('#625 passthrough escalate with no question id skips the push (no throw)', async () => {
    // escalate() returns undefined (push creation failed): escalatePassthrough must
    // not call onHeldEscalate(undefined), and must not throw — Claude still
    // passes through to its native terminal prompt.
    const gate = holdGate(evaluator(escalate), { escalateUndefined: true });
    const d = await gate.resolvePermission(
      pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'Which approach?' } }),
    );
    expect(d).toBe('passthrough');
    expect(escalations).toHaveLength(1);
    expect(heldPushes).toHaveLength(0);
  });

  test('hold timeout -> passthrough and the pending map is cleaned', async () => {
    const gate = holdGate(evaluator(escalate), { holdMs: 30 });
    const d = await gate.resolvePermission(pr());
    expect(d).toBe('passthrough'); // failed open after 30ms
    // The hold timed out; a late answer for the same id must report "no hold".
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(false);
  });

  test('holdMs <= 0 disables holding: binary escalate -> passthrough', async () => {
    const gate = holdGate(evaluator(escalate), { holdMs: 0 });
    const d = await gate.resolvePermission(pr());
    expect(d).toBe('passthrough');
    expect(escalations).toHaveLength(1);
  });

  test('releaseHeldAsPassthrough pops a held hook to passthrough (FIX 1)', async () => {
    const gate = holdGate(evaluator(escalate));
    const pending = gate.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    const qid = lastQuestionId as UUID;
    // The user picked "Yes, always": the binary response can't express it, so the
    // hook is released to passthrough (Claude renders its native prompt).
    expect(gate.releaseHeldAsPassthrough(qid)).toBe(true);
    expect(await pending).toBe('passthrough');
    // The hold is gone; a second release reports no hold.
    expect(gate.releaseHeldAsPassthrough(qid)).toBe(false);
  });

  test('releaseHeldAsPassthrough returns false when no hold exists', async () => {
    const gate = holdGate(evaluator(escalate));
    const pending = gate.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    expect(gate.releaseHeldAsPassthrough(generateId() as UUID)).toBe(false);
    // Resolve the real hold to avoid a dangling promise.
    gate.resolveHeld(lastQuestionId as UUID, 'allow');
    await pending;
  });

  test('cancelStale releases a pending hold to passthrough + cancels the eval', async () => {
    const cancels: string[] = [];
    registry.registerSession(SID, '/d', fakePTY(submits), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    const tracker = new QuestionPresenceTracker(() => {});
    const gate = new AutoApproveGate(
      {
        service: {
          evaluate: async () => escalate,
          cancel: (reason: string) => {
            cancels.push(reason);
            return true;
          },
        },
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => false,
        escalate: (i) => {
          escalations.push(i);
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        holdMs: 60_000,
        alwaysEscalateTools: new Set(),
      },
      SID,
    );
    const pending = gate.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    gate.cancelStale('SessionEnd');
    expect(await pending).toBe('passthrough'); // hold released by teardown
    expect(cancels).toContain('SessionEnd'); // eval also cancelled
    // The hold is gone.
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(false);
  });

  test('per-session isolation: resolving session A does not touch session B', async () => {
    const SID_B = generateId() as UUID;
    const registryB = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registryB.registerSession(SID_B, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    let qidB: UUID | undefined;
    const gateB = new AutoApproveGate(
      {
        service: { evaluate: async () => escalate, cancel: () => true },
        sessionRegistry: registryB,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => {
          qidB = generateId();
          return qidB;
        },
        holdMs: 60_000,
        alwaysEscalateTools: new Set(),
      },
      SID_B,
    );

    const gateA = holdGate(evaluator(escalate));
    const pendingA = gateA.resolvePermission(pr());
    const pendingB = gateB.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    const qidA = lastQuestionId as UUID;

    // Resolving A's question id on gate B finds no hold; A's own hold is intact.
    expect(gateB.resolveHeld(qidA, 'allow')).toBe(false);
    // Resolve each on its own gate.
    expect(gateA.resolveHeld(qidA, 'allow')).toBe(true);
    expect(gateB.resolveHeld(qidB as UUID, 'deny')).toBe(true);
    expect(await pendingA).toBe('allow');
    expect(await pendingB).toBe('deny');
    await registryB.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Part B (#573): slow-eval early push + hold. ISOLATED behind push_hold_timeout.
// A deferred eval lets the test control whether the eval or the push-hold timer
// wins the race deterministically.
// ---------------------------------------------------------------------------
describe('AutoApproveGate slow-eval push (#573 Part B)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let escalations: PermissionRequestHookInput[];
  let lastQuestionId: UUID | undefined;

  /** An evaluator whose verdict is delayed until `release(result)` is called,
   *  so the test decides when the eval finishes relative to push_hold_timeout. */
  function deferredEvaluator(): {
    service: AutoApproveEvaluator;
    release: (r: AutoApproveResult) => void;
  } {
    let resolveEval: (r: AutoApproveResult) => void = () => {};
    const pending = new Promise<AutoApproveResult>((res) => {
      resolveEval = res;
    });
    return {
      service: { evaluate: () => pending, cancel: () => true },
      release: (r) => resolveEval(r),
    };
  }

  function gate(
    service: AutoApproveEvaluator,
    opts: { holdMs?: number; pushHoldMs?: number } = {},
  ): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: (i) => {
          escalations.push(i);
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        holdMs: opts.holdMs ?? 60_000,
        pushHoldMs: opts.pushHoldMs ?? 0,
        alwaysEscalateTools: new Set(),
      },
      SID,
    );
  }

  function pr(): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    escalations = [];
    lastQuestionId = undefined;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('a slow eval pushes + holds early; a late approve resolves allow (no double push)', async () => {
    const { service, release } = deferredEvaluator();
    // push after 20ms; the eval has not finished yet -> early push + hold.
    const g = gate(service, { pushHoldMs: 20 });
    const pending = g.resolvePermission(pr());

    await new Promise((r) => setTimeout(r, 40)); // let the push-hold timer fire
    expect(escalations).toHaveLength(1); // pushed early exactly once
    expect(lastQuestionId).toBeDefined();

    // The late verdict arrives: approve -> the held hook resolves allow, and the
    // reconciliation must NOT push a second time.
    release(approve);
    expect(await pending).toBe('allow');
    expect(escalations).toHaveLength(1); // still one push (no double-push)
  });

  test('a slow eval whose late verdict is deny resolves the held hook deny', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40));
    expect(escalations).toHaveLength(1);
    release(deny);
    expect(await pending).toBe('deny');
    expect(escalations).toHaveLength(1);
  });

  test('a slow eval whose late verdict is escalate keeps the existing hold (no double push)', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20, holdMs: 60_000 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40));
    expect(escalations).toHaveLength(1);
    // Late escalate: already pushed + holding, so no second push; the hold stays
    // pending until the user answers.
    release(escalate);
    await new Promise((r) => setTimeout(r, 20));
    expect(escalations).toHaveLength(1);
    // The user then answers the (single) held question.
    expect(g.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(true);
    expect(await pending).toBe('allow');
  });

  test('a fast eval (verdict before push_hold_timeout) never pushes early', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 200 });
    const pending = g.resolvePermission(pr());
    // Verdict arrives well before the 200ms push-hold timer.
    release(approve);
    expect(await pending).toBe('allow');
    expect(escalations).toHaveLength(0); // no early push
  });

  test('push_hold_timeout = 0 disables Part B: a slow escalate just holds on verdict', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 0, holdMs: 60_000 });
    const pending = g.resolvePermission(pr());
    // No early push while the eval runs.
    await new Promise((r) => setTimeout(r, 30));
    expect(escalations).toHaveLength(0);
    // The eval escalates -> NOW it pushes + holds (Part A path), once.
    release(escalate);
    await new Promise((r) => setTimeout(r, 10));
    expect(escalations).toHaveLength(1);
    g.resolveHeld(lastQuestionId as UUID, 'allow');
    expect(await pending).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// #585 (P7): onResolved fires when a HELD question resolves WITHOUT a user
// answer, so the daemon can dismiss the pushed card on every client. It must NOT
// fire for a user-driven resolveHeld (the answer path broadcasts its own
// 'answered'), and a throw must be absorbed.
// ---------------------------------------------------------------------------
describe('AutoApproveGate onResolved cross-client dismissal (#585 P7)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let lastQuestionId: UUID | undefined;
  let resolved: Array<{ questionId: UUID; reason: string }>;

  function deferredEvaluator(): {
    service: AutoApproveEvaluator;
    release: (r: AutoApproveResult) => void;
  } {
    let resolveEval: (r: AutoApproveResult) => void = () => {};
    const pending = new Promise<AutoApproveResult>((res) => {
      resolveEval = res;
    });
    return {
      service: { evaluate: () => pending, cancel: () => true },
      release: (r) => resolveEval(r),
    };
  }

  function gate(
    service: AutoApproveEvaluator,
    opts: { holdMs?: number; pushHoldMs?: number; onResolvedThrows?: boolean } = {},
  ): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => {
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        holdMs: opts.holdMs ?? 60_000,
        pushHoldMs: opts.pushHoldMs ?? 0,
        alwaysEscalateTools: new Set(),
        onResolved: (questionId, reason) => {
          if (opts.onResolvedThrows) throw new Error('test: onResolved synthetic failure');
          resolved.push({ questionId, reason });
        },
      },
      SID,
    );
  }

  function pr(): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    lastQuestionId = undefined;
    resolved = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('Part-B late approve fires onResolved auto_approved', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40)); // early push + hold
    release(approve);
    expect(await pending).toBe('allow');
    expect(resolved).toEqual([{ questionId: lastQuestionId as UUID, reason: 'auto_approved' }]);
  });

  test('Part-B late deny fires onResolved auto_denied', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40));
    release(deny);
    expect(await pending).toBe('deny');
    expect(resolved).toEqual([{ questionId: lastQuestionId as UUID, reason: 'auto_denied' }]);
  });

  test('cancelStale on a held hook fires onResolved cancelled', async () => {
    const { service } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40)); // early push + hold
    g.cancelStale('SessionEnd');
    expect(await pending).toBe('passthrough');
    expect(resolved).toEqual([{ questionId: lastQuestionId as UUID, reason: 'cancelled' }]);
  });

  test('hold timeout fires onResolved cancelled', async () => {
    const { service } = deferredEvaluator();
    // Short hold so the timeout fail-open fires during the test.
    const g = gate(service, { pushHoldMs: 10, holdMs: 30 });
    const pending = g.resolvePermission(pr());
    expect(await pending).toBe('passthrough'); // failed open on hold timeout
    expect(resolved).toEqual([{ questionId: lastQuestionId as UUID, reason: 'cancelled' }]);
  });

  test('a user-driven resolveHeld does NOT fire onResolved (no double-broadcast)', async () => {
    // Part A: a normal binary escalate holds; the user answers via resolveHeld.
    // The answer path (input-events) broadcasts 'answered' itself, so the gate
    // must stay silent here.
    const service: AutoApproveEvaluator = { evaluate: async () => escalate, cancel: () => true };
    const g = gate(service, { holdMs: 60_000 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 20));
    expect(g.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(true);
    expect(await pending).toBe('allow');
    expect(resolved).toEqual([]);
  });

  test('a throwing onResolved never breaks the decision path', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20, onResolvedThrows: true });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40));
    release(approve);
    // Despite the throwing onResolved, the held hook still resolves allow.
    expect(await pending).toBe('allow');
  });

  // #585 P7 FIX 2: a Part-B held question is registered (pushHeldHook ->
  // addQuestion); the gate-side resolution must drop it from the registry so no
  // ghost card replays and a late handleAnswer can't find it "live".
  test('Part-B auto-approve removes the held question from sessionRegistry', async () => {
    const { service, release } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40)); // early push + hold
    // Simulate the real push having registered the question under the held id.
    const qid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: qid,
      text: 'proceed?',
      options: [{ value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false }],
      allowsFreeText: false,
      isAnswered: false,
    });
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    release(approve);
    expect(await pending).toBe('allow');
    // The held question is gone from the registry (no ghost card / misroute).
    expect(registry.getQuestion(SID, qid)).toBeNull();
  });

  test('hold timeout removes the held question from sessionRegistry', async () => {
    const { service } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 10, holdMs: 30 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 15)); // after the early push, before timeout
    const qid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: qid,
      text: 'proceed?',
      options: [{ value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false }],
      allowsFreeText: false,
      isAnswered: false,
    });
    expect(await pending).toBe('passthrough'); // failed open on hold timeout
    expect(registry.getQuestion(SID, qid)).toBeNull();
  });

  test('cancelStale removes the held question from sessionRegistry', async () => {
    const { service } = deferredEvaluator();
    const g = gate(service, { pushHoldMs: 20 });
    const pending = g.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 40));
    const qid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: qid,
      text: 'proceed?',
      options: [{ value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false }],
      allowsFreeText: false,
      isAnswered: false,
    });
    g.cancelStale('SessionEnd');
    expect(await pending).toBe('passthrough');
    expect(registry.getQuestion(SID, qid)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delivery gating (#603 Phase 1, R1/R2): a held hook is only worth blocking
// Claude for if the user can actually be notified. The gate races the held
// escalation's notification delivery against delivery_confirm_timeout; an
// undeliverable hold fails open FAST instead of stalling for hold_timeout.
// ---------------------------------------------------------------------------
describe('AutoApproveGate delivery gating (#603 Phase 1)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let escalations: PermissionRequestHookInput[];
  let lastQuestionId: UUID | undefined;

  function evaluator(result: AutoApproveResult): AutoApproveEvaluator {
    return { evaluate: async () => result, cancel: () => true };
  }

  function pr(over: Partial<PermissionRequestHookInput> = {}): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      ...over,
    };
  }

  /** A holding gate whose held escalation's delivery outcome and gating timeouts
   *  the test controls. `delivery` is what `awaitDelivery` resolves to (or
   *  undefined for "no delivery signal recorded"). `evalNeverSettles` + a
   *  `pushHoldMs` exercise the Part-B early-push path combined with the gate. */
  function deliveryGate(opts: {
    delivery: Promise<DeliveryOutcome> | undefined;
    deliveryConfirmMs?: number;
    holdUnconfirmedMs?: number;
    holdMs?: number;
    pushHoldMs?: number;
    evalNeverSettles?: boolean;
    onResolved?: (questionId: UUID, reason: 'auto_approved' | 'auto_denied' | 'cancelled') => void;
  }): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    const service: AutoApproveEvaluator = opts.evalNeverSettles
      ? { evaluate: () => new Promise<AutoApproveResult>(() => {}), cancel: () => true }
      : evaluator(escalate);
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: (i) => {
          escalations.push(i);
          lastQuestionId = generateId() as UUID;
          return lastQuestionId;
        },
        holdMs: opts.holdMs ?? 60_000,
        pushHoldMs: opts.pushHoldMs ?? 0,
        awaitDelivery: () => opts.delivery,
        deliveryConfirmMs: opts.deliveryConfirmMs ?? 0,
        holdUnconfirmedMs: opts.holdUnconfirmedMs ?? 0,
        ...(opts.onResolved ? { onResolved: opts.onResolved } : {}),
        alwaysEscalateTools: new Set(['AskUserQuestion', 'ExitPlanMode']),
      },
      SID,
    );
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    escalations = [];
    lastQuestionId = undefined;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('undelivered (failed push) fails the hold open fast, not after hold_timeout', async () => {
    const gate = deliveryGate({
      delivery: Promise.resolve('failed'),
      deliveryConfirmMs: 200,
      holdMs: 60_000,
    });
    // If the hold blocked for holdMs (60s) this await would hang the test; it
    // resolves promptly to passthrough because delivery was never confirmed.
    expect(await gate.resolvePermission(pr())).toBe('passthrough');
    // The hold is gone (failed open): a late answer reports "no hold".
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(false);
  });

  test('no_channel (no client, no token) fails the hold open fast', async () => {
    const gate = deliveryGate({ delivery: Promise.resolve('no_channel'), deliveryConfirmMs: 200 });
    expect(await gate.resolvePermission(pr())).toBe('passthrough');
  });

  test('a delivery probe that never resolves fails open after delivery_confirm_timeout', async () => {
    const gate = deliveryGate({
      delivery: new Promise<DeliveryOutcome>(() => {}),
      deliveryConfirmMs: 40,
      holdMs: 60_000,
    });
    expect(await gate.resolvePermission(pr())).toBe('passthrough');
  });

  test('confirmed delivery (pushed) keeps holding; the user answer resolves it', async () => {
    const gate = deliveryGate({
      delivery: Promise.resolve('pushed'),
      deliveryConfirmMs: 30,
      holdMs: 60_000,
    });
    const pending = gate.resolvePermission(pr());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 60)); // past delivery_confirm_timeout
    expect(settled).toBe(false); // still held — delivery was confirmed
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(true);
    expect(await pending).toBe('allow');
  });

  test('confirmed delivery (in_app) keeps holding', async () => {
    const gate = deliveryGate({
      delivery: Promise.resolve('in_app'),
      deliveryConfirmMs: 30,
      holdMs: 60_000,
    });
    const pending = gate.resolvePermission(pr());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(settled).toBe(false);
    gate.resolveHeld(lastQuestionId as UUID, 'allow');
    await pending;
  });

  test('gating disabled (delivery_confirm_timeout = 0) keeps the legacy hold even if delivery failed', async () => {
    const gate = deliveryGate({
      delivery: Promise.resolve('failed'),
      deliveryConfirmMs: 0,
      holdMs: 60_000,
    });
    const pending = gate.resolvePermission(pr());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);
    gate.resolveHeld(lastQuestionId as UUID, 'allow');
    expect(await pending).toBe('allow');
  });

  test('no recorded delivery signal (awaitDelivery undefined) keeps the legacy hold', async () => {
    const gate = deliveryGate({ delivery: undefined, deliveryConfirmMs: 50, holdMs: 60_000 });
    const pending = gate.resolvePermission(pr());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 70));
    expect(settled).toBe(false);
    gate.resolveHeld(lastQuestionId as UUID, 'allow');
    await pending;
  });

  test('hold_unconfirmed mode: an undelivered hold waits the short window, then fails open', async () => {
    const gate = deliveryGate({
      delivery: Promise.resolve('failed'),
      deliveryConfirmMs: 20,
      holdUnconfirmedMs: 150,
      holdMs: 60_000,
    });
    const pending = gate.resolvePermission(pr());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // It does NOT fail open immediately on the unconfirmed signal — it re-arms a
    // short 150ms hold.
    await new Promise((r) => setTimeout(r, 60));
    expect(settled).toBe(false);
    // ...which then fails open (well before the 60s holdMs).
    expect(await pending).toBe('passthrough');
  });

  test('hold_unconfirmed mode: the user can still answer during the short window', async () => {
    const gate = deliveryGate({
      delivery: Promise.resolve('failed'),
      deliveryConfirmMs: 20,
      holdUnconfirmedMs: 500,
      holdMs: 60_000,
    });
    const pending = gate.resolvePermission(pr());
    await new Promise((r) => setTimeout(r, 50)); // inside the short secondary window
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(true);
    expect(await pending).toBe('allow');
  });

  test('a delivery outcome that resolves AFTER the hold already failed open does not double-resolve', async () => {
    const resolved: Array<'auto_approved' | 'auto_denied' | 'cancelled'> = [];
    const gate = deliveryGate({
      // Resolves 'failed' well after the (short) holdMs timer has already fired.
      delivery: new Promise<DeliveryOutcome>((r) => {
        const t = setTimeout(() => r('failed'), 80);
        t.unref?.();
      }),
      deliveryConfirmMs: 500, // longer than holdMs -> the holdMs timeout wins the fail-open
      holdMs: 30,
      onResolved: (_q, reason) => resolved.push(reason),
    });
    expect(await gate.resolvePermission(pr())).toBe('passthrough'); // failed open via holdMs timeout
    // Let the slow delivery probe resolve, now that the hold is already gone.
    await new Promise((r) => setTimeout(r, 120));
    // Exactly ONE resolution broadcast (the timeout fail-open); the late probe
    // sees pendingHolds no longer has the id and no-ops (no spurious 2nd dismiss).
    expect(resolved).toEqual(['cancelled']);
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(false);
  });

  test('Part B early push + delivery gating: a slow eval whose push is undelivered fails open fast', async () => {
    const gate = deliveryGate({
      delivery: Promise.resolve('failed'),
      deliveryConfirmMs: 20,
      pushHoldMs: 15, // Part B pushes + holds early at ~15ms
      evalNeverSettles: true, // the eval never returns a verdict
      holdMs: 60_000,
    });
    // Part B holds early; delivery is 'failed', so the gate fails the hold open
    // fast (~deliveryConfirmMs) instead of waiting the 60s holdMs for a verdict
    // that never comes.
    expect(await gate.resolvePermission(pr())).toBe('passthrough');
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(false);
  });
});
