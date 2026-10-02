/**
 * AutoApproveGate after #1125 (ADR 0030): the gate decides nothing. Every
 * main-agent prompt escalates (a binary one is pushed on its render, a
 * multi-choice / design one at once), every subagent prompt parks for its PTY
 * render, and every hook answer is 'passthrough'. What remains to pin is the
 * routing, the push triggers, and the external-resolution bookkeeping that
 * clears cards nobody will answer through remi.
 *
 * Real gate, real `SessionRegistry`, real `QuestionPresenceTracker`. The deps
 * are recording sinks for the gate's outward calls (escalate, park, push),
 * not replacements for any decision logic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { AutoApproveGate } from '../../src/auto-approve/auto-approve-gate.ts';
import type { AutoApproveGateDeps } from '../../src/auto-approve/auto-approve-gate.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

// Transport double for the PTY: the gate never types into it any more, which
// several tests below assert by checking `submits` stays empty.
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

describe('AutoApproveGate routing (#1125: nothing is decided, everything is relayed)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let submits: string[];
  let escalated: PermissionRequestHookInput[];
  let escalatedIds: UUID[];
  let parks: PermissionRequestHookInput[];
  let pushOnRenderIds: UUID[];
  let pushNowIds: UUID[];
  let subagentAlerts: PermissionRequestHookInput[];
  let resets: number;
  let subagentContext: boolean;

  function gate(over: Partial<AutoApproveGateDeps> = {}): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY(submits), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => undefined),
        isInSubagentContext: () => subagentContext,
        resetSubagentContext: () => {
          resets++;
        },
        escalate: (i) => {
          escalated.push(i);
          const id = generateId() as UUID;
          escalatedIds.push(id);
          return id;
        },
        parkForPTY: (i) => {
          parks.push(i);
          return generateId() as UUID;
        },
        pushOnRender: (id) => {
          pushOnRenderIds.push(id);
        },
        onHeldEscalate: (id) => {
          pushNowIds.push(id);
        },
        onSubagentPassthrough: (i) => {
          subagentAlerts.push(i);
        },
        alwaysEscalateTools: new Set(['AskUserQuestion', 'ExitPlanMode']),
        ...over,
      },
      SID,
    );
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    submits = [];
    escalated = [];
    escalatedIds = [];
    parks = [];
    pushOnRenderIds = [];
    pushNowIds = [];
    subagentAlerts = [];
    resets = 0;
    subagentContext = false;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('a binary main prompt escalates, answers passthrough, and is marked to push on render (#1121)', async () => {
    expect(await gate().resolvePermission(pr())).toBe('passthrough');
    expect(escalated).toHaveLength(1);
    expect(pushOnRenderIds).toEqual(escalatedIds);
    // Not pushed now: the card waits for the render that carries the
    // on-screen option numbering a phone answer is typed as.
    expect(pushNowIds).toEqual([]);
    expect(parks).toEqual([]);
    expect(submits).toEqual([]);
  });

  test('a design prompt (AskUserQuestion) escalates and is pushed immediately (#625)', async () => {
    const d = await gate().resolvePermission(
      pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'Which approach?' } }),
    );
    expect(d).toBe('passthrough');
    expect(pushNowIds).toEqual(escalatedIds);
    expect(pushNowIds).toHaveLength(1);
    expect(pushOnRenderIds).toEqual([]);
  });

  test('a multi-choice prompt (ExitPlanMode) is pushed immediately, even with no configured tools', async () => {
    const d = await gate({ alwaysEscalateTools: new Set() }).resolvePermission(
      pr({ tool_name: 'ExitPlanMode', tool_input: {}, permission_mode: 'plan' }),
    );
    expect(d).toBe('passthrough');
    expect(pushNowIds).toEqual(escalatedIds);
    expect(pushOnRenderIds).toEqual([]);
  });

  test('a string-label multi-choice permission_suggestions set is pushed immediately', async () => {
    const d = await gate().resolvePermission(
      pr({ permission_suggestions: ['Option A', 'Option B', 'Option C'] }),
    );
    expect(d).toBe('passthrough');
    expect(pushNowIds).toEqual(escalatedIds);
    expect(pushOnRenderIds).toEqual([]);
  });

  test('an escalate that throws still answers passthrough and pushes nothing', async () => {
    const g = gate({
      escalate: () => {
        throw new Error('test: escalate failed');
      },
    });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    expect(
      await g.resolvePermission(
        pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'q' } }),
      ),
    ).toBe('passthrough');
    expect(pushOnRenderIds).toEqual([]);
    expect(pushNowIds).toEqual([]);
  });

  test('an escalate that creates no question pushes nothing', async () => {
    const g = gate({ escalate: () => undefined });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    expect(
      await g.resolvePermission(
        pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'q' } }),
      ),
    ).toBe('passthrough');
    expect(pushOnRenderIds).toEqual([]);
    expect(pushNowIds).toEqual([]);
  });

  test('a throwing push trigger is absorbed: the hook is still answered passthrough', async () => {
    const g = gate({
      pushOnRender: () => {
        throw new Error('test: push failed');
      },
      onHeldEscalate: () => {
        throw new Error('test: push failed');
      },
    });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    expect(
      await g.resolvePermission(
        pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'q' } }),
      ),
    ).toBe('passthrough');
  });

  test('#751: a subagent-tagged prompt parks for its render, answers passthrough, never escalates', async () => {
    const input = pr({ agent_id: 'agent-1', agent_type: 'general-purpose' });
    expect(await gate().resolvePermission(input)).toBe('passthrough');
    expect(parks).toEqual([input]);
    expect(escalated).toEqual([]);
    expect(pushOnRenderIds).toEqual([]);
    expect(pushNowIds).toEqual([]);
    expect(submits).toEqual([]);
    expect(resets).toBe(0);
  });

  test('#751: the tag on the event decides, not the subagent-context tracker', async () => {
    subagentContext = true;
    const input = pr({ agent_id: 'agent-1', agent_type: 'task' });
    expect(await gate().resolvePermission(input)).toBe('passthrough');
    expect(parks).toEqual([input]);
    expect(escalated).toEqual([]);
    // A genuine subagent event never resets the tracker (that is #710's
    // leak-recovery path, for MAIN-tagged events only).
    expect(resets).toBe(0);
  });

  test('#710: a MAIN-tagged prompt with the tracker stuck true resets it and escalates as main', async () => {
    subagentContext = true;
    expect(await gate().resolvePermission(pr())).toBe('passthrough');
    expect(resets).toBe(1);
    expect(escalated).toHaveLength(1);
    expect(parks).toEqual([]);
    expect(pushOnRenderIds).toEqual(escalatedIds);
  });

  test('#807: onSubagentPassthrough reports a parked subagent call, never a main one', async () => {
    const g = gate();
    const sub = pr({ agent_id: 'agent-1', agent_type: 'general-purpose' });
    await g.resolvePermission(sub);
    await g.resolvePermission(pr());
    expect(subagentAlerts).toEqual([sub]);
  });

  test('#807: a throwing onSubagentPassthrough cannot break the hook answer', async () => {
    const g = gate({
      onSubagentPassthrough: () => {
        throw new Error('test: alert sink failed');
      },
    });
    expect(await g.resolvePermission(pr({ agent_id: 'agent-1' }))).toBe('passthrough');
    expect(parks).toHaveLength(1);
  });

  test('#751: a parkForPTY throw is absorbed; the passthrough still stands', async () => {
    const g = gate({
      parkForPTY: () => {
        throw new Error('test: park failed');
      },
    });
    expect(await g.resolvePermission(pr({ agent_id: 'agent-1' }))).toBe('passthrough');
    expect(escalated).toEqual([]);
  });
});

describe('AutoApproveGate external resolution (#673)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let escalatedIds: UUID[];
  let resolved: Array<{ qid: UUID; reason: string }>;

  function gate(over: Partial<AutoApproveGateDeps> = {}): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => undefined),
        isInSubagentContext: () => false,
        escalate: () => {
          const id = generateId() as UUID;
          escalatedIds.push(id);
          // Register the card the way the render push would, so removal is
          // observable in the real store.
          registry.addQuestion(SID, {
            id,
            text: 'Allow Bash',
            options: [],
            allowsFreeText: false,
            isAnswered: false,
          });
          return id;
        },
        onResolved: (qid, reason) => {
          resolved.push({ qid, reason });
        },
        ...over,
      },
      SID,
    );
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    escalatedIds = [];
    resolved = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('a matching (tool_name, tool_input) removes the card and fires onResolved(cancelled)', async () => {
    const g = gate();
    await g.resolvePermission(pr({ tool_input: { command: 'git push' } }));
    const qid = escalatedIds[0] as UUID;
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' } },
      'PreToolUse',
    );

    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolved).toEqual([{ qid, reason: 'cancelled' }]);
  });

  test('same tool_name but a DIFFERENT tool_input does not match', async () => {
    const g = gate();
    await g.resolvePermission(pr({ tool_input: { command: 'git push' } }));
    g.cancelExternallyResolved({ toolName: 'Bash', toolInput: { command: 'ls' } }, 'PreToolUse');
    expect(registry.getQuestion(SID, escalatedIds[0] as UUID)).not.toBeNull();
    expect(resolved).toEqual([]);
  });

  test('a different tool_name with the SAME tool_input does not match', async () => {
    const g = gate();
    await g.resolvePermission(pr({ tool_input: { command: 'git push' } }));
    g.cancelExternallyResolved(
      { toolName: 'Terminal', toolInput: { command: 'git push' } },
      'PreToolUse',
    );
    expect(resolved).toEqual([]);
  });

  test('key order in tool_input does not defeat the signature match', async () => {
    const g = gate();
    await g.resolvePermission(pr({ tool_input: { command: 'git push', description: 'push' } }));
    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { description: 'push', command: 'git push' } },
      'PostToolUse',
    );
    expect(resolved).toEqual([{ qid: escalatedIds[0] as UUID, reason: 'cancelled' }]);
  });

  test('when both sides carry a tool_use_id it must agree as well', async () => {
    const g = gate();
    await g.resolvePermission(pr({ tool_use_id: 'use-a' }));
    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' }, toolUseId: 'use-b' },
      'PreToolUse',
    );
    expect(resolved).toEqual([]);
    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' }, toolUseId: 'use-a' },
      'PreToolUse',
    );
    expect(resolved).toEqual([{ qid: escalatedIds[0] as UUID, reason: 'cancelled' }]);
  });

  test('a duplicate re-request for the SAME signature resolves the earlier, now-stale card', async () => {
    const g = gate();
    await g.resolvePermission(pr());
    await g.resolvePermission(pr());
    const [first, second] = escalatedIds as [UUID, UUID];
    expect(resolved).toEqual([{ qid: first, reason: 'cancelled' }]);
    expect(registry.getQuestion(SID, first)).toBeNull();
    expect(registry.getQuestion(SID, second)).not.toBeNull();
  });

  test('retireQuestion: a card answered through remi is not resolved again by its tool run', async () => {
    const g = gate();
    await g.resolvePermission(pr());
    const qid = escalatedIds[0] as UUID;
    // The answer path removes + dismisses the card itself, then retires it.
    registry.removeQuestion(SID, qid, 'user_answer');
    g.retireQuestion(qid);

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' } },
      'PreToolUse',
    );

    expect(resolved).toEqual([]);
  });

  test('retireQuestion is a no-op for an id the gate never tracked', () => {
    const g = gate();
    expect(() => g.retireQuestion(generateId() as UUID)).not.toThrow();
  });

  test('no open escalation: a tool event is a harmless no-op', () => {
    const g = gate();
    expect(() =>
      g.cancelExternallyResolved({ toolName: 'Bash', toolInput: { command: 'ls' } }, 'PreToolUse'),
    ).not.toThrow();
    expect(resolved).toEqual([]);
  });

  test('a throwing onResolved is absorbed and the card is still removed', async () => {
    const g = gate({
      onResolved: () => {
        throw new Error('test: broadcast failed');
      },
    });
    await g.resolvePermission(pr());
    const qid = escalatedIds[0] as UUID;
    expect(() =>
      g.cancelExternallyResolved(
        { toolName: 'Bash', toolInput: { command: 'git push' } },
        'PreToolUse',
      ),
    ).not.toThrow();
    expect(registry.getQuestion(SID, qid)).toBeNull();
  });

  test('forceRelease resolves every open card and reports how many', async () => {
    const g = gate();
    await g.resolvePermission(pr({ tool_input: { command: 'a' } }));
    await g.resolvePermission(pr({ tool_input: { command: 'b' } }));
    expect(g.forceRelease('remi unstick')).toEqual({ resolved: 2 });
    expect(resolved.map((r) => r.qid).sort()).toEqual([...escalatedIds].sort());
    // Nothing left to resolve a second time.
    expect(g.forceRelease('remi unstick')).toEqual({ resolved: 0 });
  });
});

// ---------------------------------------------------------------------------
// #799: a subagent/teammate permission question answered IN THE TERMINAL had
// NO removal path from sessionRegistry.currentQuestions -- parkSubagentForPTY
// never registered an openQuestionSignatures entry (only main-context
// escalateToUser did), so a matching subagent PreToolUse/PostToolUse could
// never find it to clean up. These tests exercise the fix: parkSubagentForPTY
// now registers an agent-scoped signature too.
// ---------------------------------------------------------------------------
describe('AutoApproveGate subagent external-resolution (#799)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let parkedIds: UUID[];

  function gate(
    opts: {
      onResolved?: (questionId: UUID, reason: 'cancelled') => void;
    } = {},
  ): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => undefined),
        isInSubagentContext: () => false,
        // Unused by these subagent-only tests (no main escalation is ever
        // driven), but AutoApproveGateDeps requires it.
        escalate: () => generateId(),
        parkForPTY: () => {
          const id = generateId() as UUID;
          parkedIds.push(id);
          return id;
        },
        ...(opts.onResolved ? { onResolved: opts.onResolved } : {}),
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
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
      ...over,
    };
  }

  function stashQuestion(id: UUID, agentId: string): void {
    registry.addQuestion(SID, {
      id,
      text: 'proceed?',
      options: [{ value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false }],
      allowsFreeText: false,
      isAnswered: false,
      agentId,
    });
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    parkedIds = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('(a) a matching subagent tool signature resolves the parked/pushed question', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    const qid = parkedIds[0] as UUID;
    stashQuestion(qid, 'agent-1');
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    // The user answered directly in the terminal: Claude now runs the tool.
    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' }, agentId: 'agent-1' },
      'PreToolUse-subagent',
    );

    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolvedLog).toEqual([{ qid, reason: 'cancelled' }]);
  });

  test('(a) the same signature match also works from the PostToolUse side', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    const qid = parkedIds[0] as UUID;
    stashQuestion(qid, 'agent-1');

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' }, agentId: 'agent-1' },
      'PostToolUse-subagent',
    );

    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolvedLog).toEqual([{ qid, reason: 'cancelled' }]);
  });

  test('(b) a non-matching tool_input for the SAME agent leaves the parked question open', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    const qid = parkedIds[0] as UUID;
    stashQuestion(qid, 'agent-1');

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'rm -rf /' }, agentId: 'agent-1' },
      'PreToolUse-subagent',
    );

    expect(registry.getQuestion(SID, qid)).not.toBeNull();
    expect(resolvedLog).toHaveLength(0);
  });

  test('(b) a matching signature from a DIFFERENT agent does not resolve this one', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr({ agent_id: 'agent-1' }))).toBe('passthrough');
    const qid = parkedIds[0] as UUID;
    stashQuestion(qid, 'agent-1');

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' }, agentId: 'agent-OTHER' },
      'PreToolUse-subagent',
    );

    expect(registry.getQuestion(SID, qid)).not.toBeNull();
    expect(resolvedLog).toHaveLength(0);
  });

  test('(b) a MAIN tool event (no agentId) never resolves a subagent-parked question with an identical signature', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    const qid = parkedIds[0] as UUID;
    stashQuestion(qid, 'agent-1');

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' } }, // no agentId -> main
      'PreToolUse',
    );

    expect(registry.getQuestion(SID, qid)).not.toBeNull();
    expect(resolvedLog).toHaveLength(0);
  });

  test('a duplicate park for the SAME agent + signature cancels the stale earlier parked record', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    const firstQid = parkedIds[0] as UUID;
    // Claude re-issues the IDENTICAL PermissionRequest for the same agent.
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    const secondQid = parkedIds[1] as UUID;
    expect(secondQid).not.toBe(firstQid);

    expect(resolvedLog).toEqual([{ qid: firstQid, reason: 'cancelled' }]);
  });
});

// ---------------------------------------------------------------------------
// #799 part 2: a question REJECTED in the terminal never produces a matching
// tool call, so the signature-match funnel above can never catch it. Stop
// cannot fire ("Claude finished responding") while genuinely blocked
// rendering its own native passthrough prompt, so a MAIN-tagged signature
// still open when Stop(mainOnly) fires is resolved through the same funnel
// instead of a silent bookkeeping-only delete.
// ---------------------------------------------------------------------------
describe('AutoApproveGate Stop resolves a still-open MAIN passthrough question (#799 part 2)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let lastQuestionId: UUID | undefined;
  let parkedIds: UUID[];

  function gate(
    opts: {
      onResolved?: (questionId: UUID, reason: 'cancelled') => void;
    } = {},
  ): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => undefined),
        isInSubagentContext: () => false,
        escalate: () => {
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        parkForPTY: () => {
          const id = generateId() as UUID;
          parkedIds.push(id);
          return id;
        },
        alwaysEscalateTools: new Set(),
        ...(opts.onResolved ? { onResolved: opts.onResolved } : {}),
      },
      SID,
    );
  }

  /** ExitPlanMode is ALWAYS multi-choice (`ALWAYS_MULTI_CHOICE_TOOLS`), so
   *  this escalates as a PASSTHROUGH -- never held -- exactly the
   *  "No, keep planning" shape #799 targets. */
  function planModePr(): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'plan',
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: {},
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    lastQuestionId = undefined;
    parkedIds = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('fires: Stop(mainOnly) resolves a still-open MAIN passthrough question ("keep planning" answered in the terminal)', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(planModePr())).toBe('passthrough');
    const qid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: qid,
      text: 'Accept plan?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    g.cancelStale('Stop', { mainOnly: true });

    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolvedLog).toEqual([{ qid, reason: 'cancelled' }]);
  });

  test('never fires ambiguously: Stop(mainOnly) does not touch a still-open SUBAGENT question', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    // A still-open SUBAGENT escalation (#799: now also signature-registered,
    // tagged isSubagent -- this is exactly the entry Stop(mainOnly) must spare).
    const subagentPr: PermissionRequestHookInput = {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
    };
    expect(await g.resolvePermission(subagentPr)).toBe('passthrough');
    const subagentQid = parkedIds[0] as UUID;
    registry.addQuestion(SID, {
      id: subagentQid,
      text: 'ls?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-1',
    });

    // A genuinely open MAIN question too, so the test proves Stop(mainOnly)
    // resolves ITS OWN kind while sparing the subagent's.
    expect(await g.resolvePermission(planModePr())).toBe('passthrough');
    const mainQid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: mainQid,
      text: 'Accept plan?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });

    g.cancelStale('Stop', { mainOnly: true });

    expect(registry.getQuestion(SID, mainQid)).toBeNull(); // MAIN: resolved
    expect(registry.getQuestion(SID, subagentQid)).not.toBeNull(); // subagent: untouched
    expect(resolvedLog).toEqual([{ qid: mainQid, reason: 'cancelled' }]);
  });
});

// ---------------------------------------------------------------------------
// #948: `cancelStale`'s non-mainOnly (SessionEnd) branch, and `forceRelease`,
// used to be a silent `openQuestionSignatures.clear()` + `parkedInputs.clear()`
// -- exactly the "bookkeeping-only delete" the mainOnly Stop sweep's own
// comment (above) warns against. A PASSTHROUGH escalation (multi-choice /
// design, e.g. AskUserQuestion) is tracked ONLY in `openQuestionSignatures`,
// so a session that ends with no intervening `Stop` (e.g. killed or dropped
// mid-prompt) left its card sitting in the store with nothing left to
// resolve it. These tests exercise the fix: every survivor -- main OR
// subagent, unlike the mainOnly sweep -- is now routed through
// `resolveSupersededQuestion`, and prove the mainOnly Stop path is unchanged.
// ---------------------------------------------------------------------------
describe('AutoApproveGate full teardown resolves ALL survivors (#948)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let lastQuestionId: UUID | undefined;
  let parkedIds: UUID[];

  function gate(
    opts: {
      onResolved?: (questionId: UUID, reason: 'cancelled') => void;
    } = {},
  ): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => undefined),
        isInSubagentContext: () => false,
        escalate: () => {
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        parkForPTY: () => {
          const id = generateId() as UUID;
          parkedIds.push(id);
          return id;
        },
        alwaysEscalateTools: new Set(['AskUserQuestion']),
        ...(opts.onResolved ? { onResolved: opts.onResolved } : {}),
      },
      SID,
    );
  }

  /** AskUserQuestion is in `alwaysEscalateTools` -> design -> escalates as a
   *  PASSTHROUGH, never held -- the exact #948 repro shape. */
  function askUserQuestionPr(): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'Which approach?' },
    };
  }

  function subagentPr(agentId: string): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      agent_id: agentId,
      agent_type: 'general-purpose',
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    lastQuestionId = undefined;
    parkedIds = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('the exact #948 repro: SessionEnd with NO Stop in between resolves a still-open MAIN AskUserQuestion card', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(askUserQuestionPr())).toBe('passthrough');
    const qid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: qid,
      text: 'Which approach?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    expect(registry.getQuestion(SID, qid)).not.toBeNull(); // store size 1 before

    g.cancelStale('SessionEnd'); // no mainOnly, no prior Stop -- real teardown

    expect(registry.getQuestion(SID, qid)).toBeNull(); // store size 0 after
    expect(resolvedLog).toEqual([{ qid, reason: 'cancelled' }]);
  });

  test('a still-open SUBAGENT passthrough card is ALSO resolved on SessionEnd', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(subagentPr('agent-1'))).toBe('passthrough');
    const subagentQid = parkedIds[0] as UUID;
    registry.addQuestion(SID, {
      id: subagentQid,
      text: 'ls?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-1',
    });
    expect(registry.getQuestion(SID, subagentQid)).not.toBeNull();

    g.cancelStale('SessionEnd');

    expect(registry.getQuestion(SID, subagentQid)).toBeNull();
    expect(resolvedLog).toEqual([{ qid: subagentQid, reason: 'cancelled' }]);
  });

  test('Stop(mainOnly) still spares a subagent survivor exactly as before; a LATER SessionEnd then resolves it', async () => {
    // This is the regression guard: the fix must resolve every survivor on a
    // REAL teardown WITHOUT turning a mainOnly Stop into one.
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });

    expect(await g.resolvePermission(subagentPr('agent-1'))).toBe('passthrough');
    const subagentQid = parkedIds[0] as UUID;
    registry.addQuestion(SID, {
      id: subagentQid,
      text: 'ls?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-1',
    });

    expect(await g.resolvePermission(askUserQuestionPr())).toBe('passthrough');
    const mainQid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: mainQid,
      text: 'Which approach?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });

    g.cancelStale('Stop', { mainOnly: true });
    expect(registry.getQuestion(SID, mainQid)).toBeNull(); // MAIN: resolved
    expect(registry.getQuestion(SID, subagentQid)).not.toBeNull(); // subagent: still spared
    expect(resolvedLog).toEqual([{ qid: mainQid, reason: 'cancelled' }]);

    // The teammate never fires its own SubagentStop; the session just ends.
    g.cancelStale('SessionEnd');
    expect(registry.getQuestion(SID, subagentQid)).toBeNull(); // now resolved too
    expect(resolvedLog).toEqual([
      { qid: mainQid, reason: 'cancelled' },
      { qid: subagentQid, reason: 'cancelled' },
    ]);
  });

  test('question_resolved fires once per resolved survivor -- one main, two subagent -- on a full teardown', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });

    expect(await g.resolvePermission(askUserQuestionPr())).toBe('passthrough');
    const mainQid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: mainQid,
      text: 'q1',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });

    expect(await g.resolvePermission(subagentPr('agent-1'))).toBe('passthrough');
    const subagentQid1 = parkedIds[0] as UUID;
    registry.addQuestion(SID, {
      id: subagentQid1,
      text: 'q2',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-1',
    });

    expect(await g.resolvePermission(subagentPr('agent-2'))).toBe('passthrough');
    const subagentQid2 = parkedIds[1] as UUID;
    registry.addQuestion(SID, {
      id: subagentQid2,
      text: 'q3',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-2',
    });

    g.cancelStale('SessionEnd');

    expect(registry.getQuestion(SID, mainQid)).toBeNull();
    expect(registry.getQuestion(SID, subagentQid1)).toBeNull();
    expect(registry.getQuestion(SID, subagentQid2)).toBeNull();
    expect(resolvedLog).toHaveLength(3);
    const resolvedQids = resolvedLog.map((r) => r.qid);
    expect(resolvedQids).toContain(mainQid);
    expect(resolvedQids).toContain(subagentQid1);
    expect(resolvedQids).toContain(subagentQid2);
    expect(resolvedLog.every((r) => r.reason === 'cancelled')).toBe(true);
  });

  test('forceRelease (remi unstick) also resolves a still-open passthrough survivor, mirroring the teardown branch', async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(askUserQuestionPr())).toBe('passthrough');
    const qid = lastQuestionId as UUID;
    registry.addQuestion(SID, {
      id: qid,
      text: 'Which approach?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });

    g.forceRelease('remi unstick');

    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolvedLog).toEqual([{ qid, reason: 'cancelled' }]);
  });
});

// ---------------------------------------------------------------------------
// #799 part 2, subagent mirror: cancelStaleForAgent, wired from SubagentStop.
// ---------------------------------------------------------------------------
describe('AutoApproveGate cancelStaleForAgent (#799 part 2, subagent)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let parkedIds: UUID[];

  function gate(
    opts: {
      onResolved?: (questionId: UUID, reason: 'cancelled') => void;
    } = {},
  ): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => undefined),
        isInSubagentContext: () => false,
        // Unused by these subagent-only tests (no main escalation is ever
        // driven), but AutoApproveGateDeps requires it.
        escalate: () => generateId(),
        parkForPTY: () => {
          const id = generateId() as UUID;
          parkedIds.push(id);
          return id;
        },
        ...(opts.onResolved ? { onResolved: opts.onResolved } : {}),
      },
      SID,
    );
  }

  function pr(agentId: string, command: string): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command },
      agent_id: agentId,
      agent_type: 'general-purpose',
    };
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    parkedIds = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test("fires: SubagentStop resolves that agent's still-open question (denied in the terminal, no tool call ever followed)", async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr('agent-1', 'rm -rf /tmp/x'))).toBe('passthrough');
    const qid = parkedIds[0] as UUID;
    registry.addQuestion(SID, {
      id: qid,
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-1',
    });
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    g.cancelStaleForAgent('agent-1', 'SubagentStop');

    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolvedLog).toEqual([{ qid, reason: 'cancelled' }]);
  });

  test("never fires ambiguously: a DIFFERENT agent's SubagentStop does not resolve this agent's still-open question", async () => {
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr('agent-1', 'ls'))).toBe('passthrough');
    const qid1 = parkedIds[0] as UUID;
    registry.addQuestion(SID, {
      id: qid1,
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-1',
    });
    expect(await g.resolvePermission(pr('agent-2', 'ls'))).toBe('passthrough');
    const qid2 = parkedIds[1] as UUID;
    registry.addQuestion(SID, {
      id: qid2,
      text: 'proceed?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      agentId: 'agent-2',
    });

    g.cancelStaleForAgent('agent-1', 'SubagentStop');

    expect(registry.getQuestion(SID, qid1)).toBeNull(); // agent-1's is resolved
    expect(registry.getQuestion(SID, qid2)).not.toBeNull(); // agent-2's is untouched
    expect(resolvedLog).toEqual([{ qid: qid1, reason: 'cancelled' }]);
  });
});
