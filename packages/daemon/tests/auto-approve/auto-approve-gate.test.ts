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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

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
        escalate: (i) => escalations.push(i),
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

  test('approve injects "1" and sets status executing (main context)', async () => {
    gateWith(evaluator(approve)).handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['1']);
    expect(registry.getSession(SID)?.currentStatus).toBe('executing');
    expect(escalations).toHaveLength(0);
  });

  test('deny injects "3" and sets status thinking (main context)', async () => {
    gateWith(evaluator(deny)).handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['3']);
    expect(registry.getSession(SID)?.currentStatus).toBe('thinking');
    expect(escalations).toHaveLength(0);
  });

  test('pick injects the 1-based index (main context)', async () => {
    gateWith(evaluator(pick(2))).handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['2']);
    expect(escalations).toHaveLength(0);
  });

  test('escalate in main context calls escalate, never injects', async () => {
    gateWith(evaluator(escalate)).handlePermissionRequest(pr());
    await flush();
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
    gate.handlePermissionRequest(pr());
    await flush();
    expect(onEscalateCalls).toBe(1);
  });

  test('escalate in subagent context default-denies ("3"), never escalates', async () => {
    subagent = true;
    gateWith(evaluator(escalate)).handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['3']);
    expect(escalations).toHaveLength(0);
  });

  test('cancelled clears the tracker pending; no inject, no escalate', async () => {
    // Stash a pending hook so clearPending() is observable.
    tracker.recordPendingHook({
      id: generateId(),
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    expect(tracker.hasPendingForTest()).toBe(true);

    gateWith(evaluator(cancelled)).handlePermissionRequest(pr());
    await flush();

    expect(tracker.hasPendingForTest()).toBe(false);
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('subagent + no PTY presence: inject is gated; approve falls back to escalate', async () => {
    subagent = true; // background subagent, prompt not on the main PTY
    gateWith(evaluator(approve)).handlePermissionRequest(pr());
    await flush();
    expect(submits).toHaveLength(0); // PTY-presence gate blocked the inject
    expect(escalations).toHaveLength(1); // approve has a fallback -> escalate
  });

  test('subagent + PTY prompt visible: inject proceeds', async () => {
    subagent = true;
    tracker.onPTYPromptVisible({
      id: generateId(),
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    gateWith(evaluator(approve)).handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['1']);
  });

  test('explicit agent_id (no isInSubagentContext) also gates inject by PTY presence', async () => {
    subagent = false; // gate must rely on input.agent_id alone
    gateWith(evaluator(approve)).handlePermissionRequest(pr({ agent_id: 'agent-xyz' }));
    await flush();
    expect(submits).toHaveLength(0); // no PTY presence -> gated
    expect(escalations).toHaveLength(1);
  });

  test('inject failure (PTY throws) falls back to escalate (main context)', async () => {
    gateWith(evaluator(approve), /* ptyThrows */ true).handlePermissionRequest(pr());
    await flush();
    expect(escalations).toHaveLength(1);
  });

  test('eval rejection in main context escalates (the outer .catch)', async () => {
    gateWith(evaluator(approve, { throws: true })).handlePermissionRequest(pr());
    await flush();
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(1);
  });

  test('eval rejection in subagent context default-denies', async () => {
    subagent = true;
    gateWith(evaluator(approve, { throws: true })).handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['3']);
    expect(escalations).toHaveLength(0);
  });

  test('no service + subagent: default-deny "3"', async () => {
    subagent = true;
    gateWith(null).handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['3']);
    expect(escalations).toHaveLength(0);
  });

  test('no service + main context: escalate to user', async () => {
    gateWith(null).handlePermissionRequest(pr());
    await flush();
    expect(submits).toHaveLength(0);
    expect(escalations).toHaveLength(1);
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
        escalate: () => {},
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
    gate(evaluator(approve)).handlePermissionRequest(pr());
    await flush();
    expect(events).toEqual(['start', 'handled']);
  });

  test('deny fires start then handled', async () => {
    gate(evaluator(deny)).handlePermissionRequest(pr());
    await flush();
    expect(events).toEqual(['start', 'handled']);
  });

  test('escalate fires start then escalate (never handled)', async () => {
    gate(evaluator(escalate)).handlePermissionRequest(pr());
    await flush();
    expect(events).toEqual(['start', 'escalate']);
  });

  test('cancelled fires start then cancelled (never handled/escalate)', async () => {
    gate(evaluator(cancelled)).handlePermissionRequest(pr());
    await flush();
    expect(events).toEqual(['start', 'cancelled']);
  });

  test('approve whose inject fails escalates -> start then escalate (not handled)', async () => {
    gate(evaluator(approve), /* ptyThrows */ true).handlePermissionRequest(pr());
    await flush();
    expect(events).toEqual(['start', 'escalate']);
  });

  test('subagent default-deny still fires handled (buffer + cue close)', async () => {
    subagent = true;
    gate(evaluator(escalate)).handlePermissionRequest(pr());
    await flush();
    // Subagent escalate default-denies via inject "3" -> markHandled.
    expect(submits).toEqual(['3']);
    expect(events).toEqual(['start', 'handled']);
  });

  test('a throwing cue callback is absorbed: decision not re-run, no re-escalation', async () => {
    // The cue is cosmetic. If onHandled throws it must NOT propagate into the
    // .then()/.catch() chain (where the catch would re-run the decision and
    // could re-open the #484 buffer). The permission stays approved-once.
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
        },
        onHandled: () => {
          throw new Error('test: cue boom');
        },
      },
      SID,
    );
    g.handlePermissionRequest(pr());
    await flush();
    expect(submits).toEqual(['1']); // approved exactly once
    expect(escalations).toBe(0); // the catch did NOT re-escalate
  });
});
