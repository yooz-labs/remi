/**
 * AutoApproveGate after #1125 (ADR 0030) and #1126 (ADR 0031): the gate
 * decides nothing on its own. A binary main-agent prompt holds its hook and
 * pushes its card at once; only a human answer (the phone's, through
 * `answerHeld`, or the terminal's) settles it, and every non-answer path
 * releases the hook with the empty response. A multi-choice / design prompt is
 * pushed at once and answered 'passthrough'; a subagent prompt parks for its
 * PTY render. What is pinned here: the routing, the push triggers, the
 * answer-to-decision mapping, the deadline, and the external-resolution
 * bookkeeping that clears cards nobody will answer through remi.
 *
 * Real gate, real `SessionRegistry`. The deps
 * are recording sinks for the gate's outward calls (escalate, park, push),
 * not replacements for any decision logic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { QuestionOption, UUID } from '@remi/shared';
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
        isInSubagentContext: () => subagentContext,
        holdMs: 60_000,
        hasLocalTerminal: true,
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

  test('a binary main prompt holds its hook and pushes its card at once (#1126)', async () => {
    const g = gate();
    let settled = false;
    const hook = g.resolvePermission(pr()).then((d) => {
      settled = true;
      return d;
    });
    await Bun.sleep(5);
    expect(escalated).toHaveLength(1);
    // Pushed now, by id: the dialog renders during the hold, the card does
    // not wait for it.
    expect(pushNowIds).toEqual(escalatedIds);
    expect(parks).toEqual([]);
    expect(submits).toEqual([]);
    expect(settled).toBe(false);
    expect(g.hasOpenHookPrompt()).toBe(true);
    // Every non-answer release is the empty response.
    g.forceRelease('test');
    expect(await hook).toBe('passthrough');
    expect(g.hasOpenHookPrompt()).toBe(false);
  });

  test('a design prompt (AskUserQuestion) escalates and is pushed immediately (#625)', async () => {
    const d = await gate().resolvePermission(
      pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'Which approach?' } }),
    );
    expect(d).toBe('passthrough');
    expect(pushNowIds).toEqual(escalatedIds);
    expect(pushNowIds).toHaveLength(1);
  });

  test('a multi-choice prompt (ExitPlanMode) is pushed immediately, even with no configured tools', async () => {
    const d = await gate({ alwaysEscalateTools: new Set() }).resolvePermission(
      pr({ tool_name: 'ExitPlanMode', tool_input: {}, permission_mode: 'plan' }),
    );
    expect(d).toBe('passthrough');
    expect(pushNowIds).toEqual(escalatedIds);
  });

  test('a string-label multi-choice permission_suggestions set is pushed immediately', async () => {
    const d = await gate().resolvePermission(
      pr({ permission_suggestions: ['Option A', 'Option B', 'Option C'] }),
    );
    expect(d).toBe('passthrough');
    expect(pushNowIds).toEqual(escalatedIds);
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
    expect(pushNowIds).toEqual([]);
  });

  test('a throwing push trigger is absorbed: the hook is still answered, never left dangling', async () => {
    const g = gate({
      onHeldEscalate: () => {
        throw new Error('test: push failed');
      },
    });
    // The binary prompt still holds (its dialog is on screen and the
    // terminal can answer it); the release is the empty response.
    const hook = g.resolvePermission(pr());
    expect(g.hasOpenHookPrompt()).toBe(true);
    g.forceRelease('test');
    expect(await hook).toBe('passthrough');
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
    const g = gate();
    const hook = g.resolvePermission(pr());
    expect(resets).toBe(1);
    expect(escalated).toHaveLength(1);
    expect(parks).toEqual([]);
    expect(pushNowIds).toEqual(escalatedIds);
    g.forceRelease('test');
    expect(await hook).toBe('passthrough');
  });

  test('#807: onSubagentPassthrough reports a parked subagent call, never a main one', async () => {
    const g = gate();
    const sub = pr({ agent_id: 'agent-1', agent_type: 'general-purpose' });
    await g.resolvePermission(sub);
    const main = g.resolvePermission(pr());
    expect(subagentAlerts).toEqual([sub]);
    g.forceRelease('test');
    await main;
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
        isInSubagentContext: () => false,
        holdMs: 60_000,
        hasLocalTerminal: true,
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

  test('a matching (tool_name, tool_input) removes the card, fires onResolved(cancelled) and releases the hold empty', async () => {
    const g = gate();
    const hook = g.resolvePermission(pr({ tool_input: { command: 'git push' } }));
    const qid = escalatedIds[0] as UUID;
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' } },
      'PreToolUse',
    );

    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolved).toEqual([{ qid, reason: 'cancelled' }]);
    // The terminal answered: the hook gets the empty response Claude ignores.
    expect(await hook).toBe('passthrough');
    expect(g.answerHeld(qid, { kind: 'cancel' })).toBe('closed');
  });

  test('same tool_name but a DIFFERENT tool_input does not match', async () => {
    const g = gate();
    void g.resolvePermission(pr({ tool_input: { command: 'git push' } }));
    g.cancelExternallyResolved({ toolName: 'Bash', toolInput: { command: 'ls' } }, 'PreToolUse');
    expect(registry.getQuestion(SID, escalatedIds[0] as UUID)).not.toBeNull();
    expect(resolved).toEqual([]);
  });

  test('a different tool_name with the SAME tool_input does not match', async () => {
    const g = gate();
    void g.resolvePermission(pr({ tool_input: { command: 'git push' } }));
    g.cancelExternallyResolved(
      { toolName: 'Terminal', toolInput: { command: 'git push' } },
      'PreToolUse',
    );
    expect(resolved).toEqual([]);
  });

  test('key order in tool_input does not defeat the signature match', async () => {
    const g = gate();
    void g.resolvePermission(pr({ tool_input: { command: 'git push', description: 'push' } }));
    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { description: 'push', command: 'git push' } },
      'PostToolUse',
    );
    expect(resolved).toEqual([{ qid: escalatedIds[0] as UUID, reason: 'cancelled' }]);
  });

  test('when both sides carry a tool_use_id it must agree as well', async () => {
    const g = gate();
    void g.resolvePermission(pr({ tool_use_id: 'use-a' }));
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
    void g.resolvePermission(pr());
    void g.resolvePermission(pr());
    const [first, second] = escalatedIds as [UUID, UUID];
    expect(resolved).toEqual([{ qid: first, reason: 'cancelled' }]);
    expect(registry.getQuestion(SID, first)).toBeNull();
    expect(registry.getQuestion(SID, second)).not.toBeNull();
  });

  test('retireQuestion: a card answered through remi is not resolved again by its tool run', async () => {
    const g = gate();
    const hook = g.resolvePermission(pr());
    const qid = escalatedIds[0] as UUID;
    // The answer path removes + dismisses the card itself, then retires it.
    registry.removeQuestion(SID, qid, 'user_answer');
    g.retireQuestion(qid);

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' } },
      'PreToolUse',
    );

    expect(resolved).toEqual([]);
    // A retired hold is released with the empty response, never left
    // pending to its deadline.
    expect(await hook).toBe('passthrough');
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
    void g.resolvePermission(pr());
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
    void g.resolvePermission(pr({ tool_input: { command: 'a' } }));
    void g.resolvePermission(pr({ tool_input: { command: 'b' } }));
    expect(g.forceRelease('remi unstick')).toEqual({ resolved: 2 });
    expect(resolved.map((r) => r.qid).sort()).toEqual([...escalatedIds].sort());
    // Nothing left to resolve a second time.
    expect(g.forceRelease('remi unstick')).toEqual({ resolved: 0 });
  });
});

// ---------------------------------------------------------------------------
// #1126: a held binary prompt is settled by exactly one human answer (the
// phone's through `answerHeld`, or the terminal's through a resolution
// signal), or released empty at its deadline. The phone's answer maps by the
// card option's MEANING; nothing a card does not offer can be expressed.
// ---------------------------------------------------------------------------
describe('AutoApproveGate held prompts (#1126)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let ids: UUID[];
  let resolved: UUID[];
  let deadlines: Array<{ qid: UUID; registered: boolean }>;
  let noticesCleared: UUID[];

  function gate(over: Partial<AutoApproveGateDeps> = {}): AutoApproveGate {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => false,
        holdMs: 60_000,
        hasLocalTerminal: true,
        escalate: () => {
          const id = generateId() as UUID;
          ids.push(id);
          registry.addQuestion(SID, {
            id,
            text: 'Allow Bash: git push',
            options: [],
            allowsFreeText: false,
            isAnswered: false,
          });
          return id;
        },
        onResolved: (qid) => {
          resolved.push(qid);
        },
        onHoldDeadline: (qid) => {
          deadlines.push({ qid, registered: registry.getQuestion(SID, qid) !== null });
        },
        onTerminalNoticeResolved: (qid) => {
          noticesCleared.push(qid);
        },
        ...over,
      },
      SID,
    );
  }

  const YES: QuestionOption = {
    label: 'Yes',
    value: '1',
    isRecommended: true,
    isYes: true,
    isNo: false,
  };
  const NO: QuestionOption = {
    label: 'No',
    value: '3',
    isRecommended: false,
    isYes: false,
    isNo: true,
  };
  function standing(suggestionIndex: number, label = 'Yes, and switch to acceptEdits mode') {
    return {
      label,
      value: '2',
      isRecommended: false,
      isYes: true,
      isNo: false,
      suggestionIndex,
    } satisfies QuestionOption;
  }
  const SET_MODE = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
  const ADD_RULES = {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'git push' }],
    behavior: 'allow',
    destination: 'localSettings',
  };
  const ADD_DIRS = { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' };

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    ids = [];
    resolved = [];
    deadlines = [];
    noticesCleared = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('phone Yes resolves the hook with allow, exactly once', async () => {
    const g = gate();
    const hook = g.resolvePermission(pr());
    const qid = ids[0] as UUID;
    expect(g.answerHeld(qid, { kind: 'option', option: YES })).toBe('resolved');
    expect(await hook).toBe('allow');
    // The hold is over: a second answer is refused as closed, and the
    // prompt no longer counts as open.
    expect(g.answerHeld(qid, { kind: 'option', option: NO })).toBe('closed');
    expect(g.hasOpenHookPrompt()).toBe(false);
  });

  test('phone No resolves deny; a message rides along trimmed, an empty one is dropped', async () => {
    const g = gate();
    const plain = g.resolvePermission(pr({ tool_input: { command: 'a' } }));
    expect(g.answerHeld(ids[0] as UUID, { kind: 'option', option: NO })).toBe('resolved');
    expect(await plain).toBe('deny');

    const withMsg = g.resolvePermission(pr({ tool_input: { command: 'b' } }));
    expect(
      g.answerHeld(ids[1] as UUID, {
        kind: 'option',
        option: NO,
        message: '  use the staging branch instead  ',
      }),
    ).toBe('resolved');
    expect(await withMsg).toEqual({ behavior: 'deny', message: 'use the staging branch instead' });

    const blank = g.resolvePermission(pr({ tool_input: { command: 'c' } }));
    expect(g.answerHeld(ids[2] as UUID, { kind: 'option', option: NO, message: '   ' })).toBe(
      'resolved',
    );
    expect(await blank).toBe('deny');
  });

  test('a very long deny message is bounded before it reaches Claude', async () => {
    const g = gate();
    const hook = g.resolvePermission(pr());
    g.answerHeld(ids[0] as UUID, { kind: 'option', option: NO, message: 'x'.repeat(5000) });
    const decision = (await hook) as { behavior: string; message: string };
    expect(decision.behavior).toBe('deny');
    expect(decision.message.length).toBe(2000);
  });

  test('Cancel on a held card is a No through the hook, never an Esc', async () => {
    const g = gate();
    const hook = g.resolvePermission(pr());
    expect(g.answerHeld(ids[0] as UUID, { kind: 'cancel' })).toBe('resolved');
    expect(await hook).toBe('deny');
  });

  test('a setMode standing option echoes the suggestion scoped to this session', async () => {
    const g = gate();
    const hook = g.resolvePermission(pr({ permission_suggestions: [ADD_DIRS, SET_MODE] }));
    expect(g.answerHeld(ids[0] as UUID, { kind: 'option', option: standing(1) })).toBe('resolved');
    expect(await hook).toEqual({ behavior: 'allow', updatedPermissions: [SET_MODE] });
    // Even a mode change Claude suggested for a settings file stays in the
    // session: a phone tap never writes one (#1126 lead decision).
    const hook2 = g.resolvePermission(
      pr({
        tool_input: { command: 'other' },
        permission_suggestions: [{ ...SET_MODE, destination: 'localSettings' }],
      }),
    );
    g.answerHeld(ids[1] as UUID, { kind: 'option', option: standing(0) });
    expect(await hook2).toEqual({ behavior: 'allow', updatedPermissions: [SET_MODE] });
  });

  test('an addRules standing option echoes the rule scoped to this session', async () => {
    const g = gate();
    const hook = g.resolvePermission(pr({ permission_suggestions: [ADD_RULES] }));
    expect(
      g.answerHeld(ids[0] as UUID, {
        kind: 'option',
        option: standing(0, 'Yes, allow git push for this session'),
      }),
    ).toBe('resolved');
    expect(await hook).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ ...ADD_RULES, destination: 'session' }],
    });
  });

  test('what a card does not offer is refused and the hold stays: addDirectories, a missing suggestion, a reworded Yes, free text', async () => {
    const g = gate();
    let settled = false;
    const hook = g
      .resolvePermission(pr({ permission_suggestions: [ADD_DIRS, SET_MODE] }))
      .then((d) => {
        settled = true;
        return d;
      });
    const qid = ids[0] as UUID;
    // An option naming the addDirectories entry (no card offers it).
    expect(g.answerHeld(qid, { kind: 'option', option: standing(0) })).toBe('refused');
    // An index with no suggestion behind it.
    expect(g.answerHeld(qid, { kind: 'option', option: standing(7) })).toBe('refused');
    // A Yes that is not the one-time Yes and names no suggestion.
    expect(
      g.answerHeld(qid, {
        kind: 'option',
        option: { ...YES, label: 'Yes, and always allow' },
      }),
    ).toBe('refused');
    expect(g.answerHeld(qid, { kind: 'text' })).toBe('refused');
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(registry.getQuestion(SID, qid)).not.toBeNull();
    // The hold is intact: a real option still resolves it.
    expect(g.answerHeld(qid, { kind: 'option', option: YES })).toBe('resolved');
    expect(await hook).toBe('allow');
  });

  test('an id this gate never held is unknown (hook-less and passthrough cards use their own path)', async () => {
    const g = gate();
    expect(g.answerHeld(generateId() as UUID, { kind: 'option', option: YES })).toBe('unknown');
    await g.resolvePermission(pr({ tool_name: 'AskUserQuestion', tool_input: { question: 'q' } }));
    expect(g.answerHeld(ids[0] as UUID, { kind: 'option', option: YES })).toBe('unknown');
  });

  test('the deadline releases the hook empty, tells the phone while the card is registered, then dismisses it', async () => {
    const g = gate({ holdMs: 30 });
    const hook = g.resolvePermission(pr());
    const qid = ids[0] as UUID;
    expect(await hook).toBe('passthrough');
    expect(deadlines).toEqual([{ qid, registered: true }]);
    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolved).toEqual([qid]);
    // Claude's dialog is still up, so the prompt stays open for the probe,
    // and a late phone answer is refused as closed.
    expect(g.hasOpenHookPrompt()).toBe(true);
    expect(g.answerHeld(qid, { kind: 'option', option: YES })).toBe('closed');
    // The terminal answers later: the prompt closes and the notice clears,
    // with no second card dismissal.
    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' } },
      'PostToolUse',
    );
    expect(g.hasOpenHookPrompt()).toBe(false);
    expect(noticesCleared).toEqual([qid]);
    expect(resolved).toEqual([qid]);
  });

  test('a prompt released at its deadline is not retired by a late answer path (its dialog is still up)', async () => {
    const g = gate({ holdMs: 20 });
    const hook = g.resolvePermission(pr());
    const qid = ids[0] as UUID;
    expect(await hook).toBe('passthrough');
    // The stale-answer path for the dismissed card retires its id.
    g.retireQuestion(qid);
    expect(g.hasOpenHookPrompt()).toBe(true);
    expect(noticesCleared).toEqual([]);
    // Only a hook signal closes it, and the notice clears then.
    g.cancelStale('UserPromptSubmit', { mainOnly: true });
    expect(g.hasOpenHookPrompt()).toBe(false);
    expect(noticesCleared).toEqual([qid]);
  });

  test('an answer before the deadline cancels it: no notice, no late release', async () => {
    const g = gate({ holdMs: 40 });
    const hook = g.resolvePermission(pr());
    g.answerHeld(ids[0] as UUID, { kind: 'option', option: YES });
    expect(await hook).toBe('allow');
    await Bun.sleep(80);
    expect(deadlines).toEqual([]);
  });

  test('an abort of the hook request (Claude closed it) dismisses the card and closes the prompt', async () => {
    const g = gate();
    const client = new AbortController();
    const hook = g.resolvePermission(pr(), client.signal);
    const qid = ids[0] as UUID;
    client.abort();
    expect(await hook).toBe('passthrough');
    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(resolved).toEqual([qid]);
    expect(g.hasOpenHookPrompt()).toBe(false);
    expect(g.answerHeld(qid, { kind: 'option', option: YES })).toBe('closed');
  });

  test('an abort after a phone answer is a no-op (the answer already settled the hold)', async () => {
    const g = gate();
    const client = new AbortController();
    const hook = g.resolvePermission(pr(), client.signal);
    g.answerHeld(ids[0] as UUID, { kind: 'option', option: YES });
    client.abort();
    expect(await hook).toBe('allow');
    expect(resolved).toEqual([]);
  });

  test('a request already aborted on arrival is not held and creates no card', async () => {
    const g = gate();
    const client = new AbortController();
    client.abort();
    expect(await g.resolvePermission(pr(), client.signal)).toBe('passthrough');
    expect(ids).toEqual([]);
  });

  describe('pairing a request with its PreToolUse (#1126)', () => {
    const call = { toolName: 'Bash', toolInput: { command: 'git push' } };

    test('the paired PostToolUse closes the prompt; an identical call with another id does not', async () => {
      const g = gate();
      g.notePreToolUse({ ...call, toolUseId: 'tu-1' });
      const hook = g.resolvePermission(pr());
      g.cancelExternallyResolved({ ...call, toolUseId: 'tu-other' }, 'PostToolUse');
      expect(g.hasOpenHookPrompt()).toBe(true);
      g.cancelExternallyResolved({ ...call, toolUseId: 'tu-1' }, 'PostToolUse');
      expect(await hook).toBe('passthrough');
      expect(g.hasOpenHookPrompt()).toBe(false);
    });

    test('two identical calls in flight: no pairing; a name + input match releases the hold to the terminal, never closes it', async () => {
      const g = gate();
      g.notePreToolUse({ ...call, toolUseId: 'tu-a' });
      g.notePreToolUse({ ...call, toolUseId: 'tu-b' });
      const hook = g.resolvePermission(pr());
      const qid = ids[0] as UUID;
      // Unpaired: either call's PostToolUse ends the hold. The worst case is
      // an early empty release, never a decision...
      g.cancelExternallyResolved({ ...call, toolUseId: 'tu-b' }, 'PostToolUse');
      expect(await hook).toBe('passthrough');
      expect(registry.getQuestion(SID, qid)).toBeNull();
      // ...and its dialog may still be up (the other call ran), so the prompt
      // stays open for the probe and is not retired by a late phone answer.
      expect(g.hasOpenHookPrompt()).toBe(true);
      g.retireQuestion(qid);
      expect(g.hasOpenHookPrompt()).toBe(true);
      // The next matching run closes it.
      g.cancelExternallyResolved({ ...call, toolUseId: 'tu-a' }, 'PostToolUse');
      expect(g.hasOpenHookPrompt()).toBe(false);
    });

    test('an identical unpaired re-request releases the earlier hold to the terminal', async () => {
      const g = gate();
      const first = g.resolvePermission(pr());
      const second = g.resolvePermission(pr());
      expect(await first).toBe('passthrough');
      expect(registry.getQuestion(SID, ids[0] as UUID)).toBeNull();
      // Both prompts stay open: the first in the terminal, the second held.
      expect(g.answerHeld(ids[1] as UUID, { kind: 'option', option: YES })).toBe('resolved');
      expect(await second).toBe('allow');
      expect(g.hasOpenHookPrompt()).toBe(true);
      g.cancelStale('Stop', { mainOnly: true });
      expect(g.hasOpenHookPrompt()).toBe(false);
    });

    test('closed-hold memory and in-flight calls are bounded', async () => {
      const g = gate();
      for (let i = 0; i < 260; i++) {
        const hook = g.resolvePermission(pr({ tool_input: { command: `c${i}` } }));
        g.answerHeld(ids[i] as UUID, { kind: 'option', option: YES });
        await hook;
      }
      // The oldest ended hold has been forgotten; recent ones are remembered.
      expect(g.answerHeld(ids[0] as UUID, { kind: 'cancel' })).toBe('unknown');
      expect(g.answerHeld(ids[259] as UUID, { kind: 'cancel' })).toBe('closed');
      // Only the newest 64 unfinished calls stay pairable.
      for (let i = 0; i < 70; i++) {
        g.notePreToolUse({
          toolName: 'Bash',
          toolInput: { command: `p${i}` },
          toolUseId: `tu-${i}`,
        });
      }
      const oldest = g.resolvePermission(pr({ tool_input: { command: 'p0' } }));
      const newest = g.resolvePermission(pr({ tool_input: { command: 'p69' } }));
      g.cancelExternallyResolved(
        { toolName: 'Bash', toolInput: { command: 'p69' }, toolUseId: 'tu-69' },
        'PostToolUse',
      );
      expect(await newest).toBe('passthrough');
      // p0 was evicted, so it is unpaired: an id-carrying event for it can
      // only release it to the terminal by name and input.
      g.cancelExternallyResolved(
        { toolName: 'Bash', toolInput: { command: 'p0' }, toolUseId: 'tu-0' },
        'PostToolUse',
      );
      expect(await oldest).toBe('passthrough');
      expect(g.hasOpenHookPrompt()).toBe(true);
    });

    test('two requests each paired with its own call stay separate holds', async () => {
      const g = gate();
      g.notePreToolUse({ ...call, toolUseId: 'tu-1' });
      const first = g.resolvePermission(pr());
      g.notePreToolUse({ ...call, toolUseId: 'tu-2' });
      const second = g.resolvePermission(pr());
      // The identical re-request did not cancel the first: different ids.
      expect(resolved).toEqual([]);
      g.answerHeld(ids[1] as UUID, { kind: 'option', option: NO });
      expect(await second).toBe('deny');
      g.cancelExternallyResolved({ ...call, toolUseId: 'tu-1' }, 'PostToolUse');
      expect(await first).toBe('passthrough');
    });

    test("a finished call cannot pair, and another agent's call never pairs", async () => {
      const g = gate();
      g.notePreToolUse({ ...call, toolUseId: 'tu-done' });
      g.noteToolUseEnded('tu-done');
      g.notePreToolUse({ ...call, toolUseId: 'tu-sub', agentId: 'agent-1' });
      const hook = g.resolvePermission(pr());
      // Unpaired, so a PostToolUse with any id falls back to name + input,
      // except the subagent's (agent scoping still holds).
      g.cancelExternallyResolved({ ...call, toolUseId: 'tu-sub', agentId: 'agent-1' }, 'x');
      expect(g.hasOpenHookPrompt()).toBe(true);
      g.cancelExternallyResolved(call, 'PostToolUse');
      expect(await hook).toBe('passthrough');
    });
  });

  test('Stop, SubagentStop-style sweeps and SessionEnd release a held hook empty', async () => {
    const g = gate();
    const atStop = g.resolvePermission(pr({ tool_input: { command: 'a' } }));
    g.cancelStale('Stop', { mainOnly: true });
    expect(await atStop).toBe('passthrough');
    const atEnd = g.resolvePermission(pr({ tool_input: { command: 'b' } }));
    g.cancelStale('SessionEnd');
    expect(await atEnd).toBe('passthrough');
    expect(resolved).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// #1126: a background subagent's dialog does not render while its hook is
// held, so the route depends on whether the session has a local terminal.
// ---------------------------------------------------------------------------
describe('AutoApproveGate subagent routing by local terminal (#1126)', () => {
  const SID = generateId() as UUID;
  let registry: SessionRegistry;
  let ids: UUID[];
  let parks: PermissionRequestHookInput[];
  let noticesNow: PermissionRequestHookInput[];
  let pushedNow: UUID[];
  let alerts: PermissionRequestHookInput[];
  let noticesCleared: UUID[];

  function gate(hasLocalTerminal: boolean, over: Partial<AutoApproveGateDeps> = {}) {
    registry.registerSession(SID, '/d', fakePTY([]), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => false,
        holdMs: 60_000,
        hasLocalTerminal,
        escalate: () => {
          const id = generateId() as UUID;
          ids.push(id);
          return id;
        },
        parkForPTY: (i) => {
          parks.push(i);
          const id = generateId() as UUID;
          ids.push(id);
          return id;
        },
        pushTerminalNoticeNow: (i) => {
          noticesNow.push(i);
          const id = generateId() as UUID;
          ids.push(id);
          return id;
        },
        onHeldEscalate: (id) => {
          pushedNow.push(id);
        },
        onSubagentPassthrough: (i) => {
          alerts.push(i);
        },
        onTerminalNoticeResolved: (id) => {
          noticesCleared.push(id);
        },
        ...over,
      },
      SID,
    );
  }

  const sub = (over: Partial<PermissionRequestHookInput> = {}) =>
    pr({ agent_id: 'agent-1', agent_type: 'general-purpose', ...over });
  const YES: QuestionOption = {
    label: 'Yes',
    value: '1',
    isRecommended: true,
    isYes: true,
    isNo: false,
  };

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    ids = [];
    parks = [];
    noticesNow = [];
    pushedNow = [];
    alerts = [];
    noticesCleared = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('with a local terminal: passthrough at once, parked for its render, alert cue fired, nothing held', async () => {
    const g = gate(true);
    const input = sub();
    expect(await g.resolvePermission(input)).toBe('passthrough');
    expect(parks).toEqual([input]);
    expect(pushedNow).toEqual([]);
    expect(alerts).toEqual([input]);
    expect(g.answerHeld(ids[0] as UUID, { kind: 'option', option: YES })).toBe('unknown');
    // Not rendered yet: it must not suppress a hook-less prompt's card (its
    // own render is matched through its parked record first).
    expect(g.hasOpenHookPrompt()).toBe(false);
    // Rendered: now its redraws are echoes, not orphans.
    g.noteTerminalNotice(ids[0] as UUID);
    expect(g.hasOpenHookPrompt()).toBe(true);
  });

  test('a rendered notice is dismissed when the prompt resolves', async () => {
    const g = gate(true);
    await g.resolvePermission(sub());
    const qid = ids[0] as UUID;
    g.noteTerminalNotice(qid);
    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' }, agentId: 'agent-1' },
      'PostToolUse-subagent',
    );
    expect(noticesCleared).toEqual([qid]);
    // A notice for a prompt no longer open is not tracked.
    g.noteTerminalNotice(qid);
    g.forceRelease('probe');
    expect(noticesCleared).toEqual([qid]);
  });

  test('with no render path the notice is pushed at once, and still dismissed on resolution', async () => {
    const g = gate(true, {
      parkForPTY: () => {
        throw new Error('test: park failed');
      },
    });
    const input = sub();
    expect(await g.resolvePermission(input)).toBe('passthrough');
    expect(noticesNow).toEqual([input]);
    g.cancelStaleForAgent('agent-1', 'SubagentStop');
    expect(noticesCleared).toEqual([ids[0] as UUID]);
  });

  test('without a local terminal: held and pushed like a main prompt, answerable from the phone', async () => {
    const g = gate(false);
    const hook = g.resolvePermission(sub());
    const qid = ids[0] as UUID;
    expect(parks).toEqual([]);
    expect(pushedNow).toEqual([qid]);
    // Held, not passed through: no alert for a call the phone decides.
    expect(alerts).toEqual([]);
    // The lead idling does not release a subagent's hold (#711).
    g.cancelStale('Stop', { mainOnly: true });
    expect(g.answerHeld(qid, { kind: 'option', option: YES })).toBe('resolved');
    expect(await hook).toBe('allow');
  });

  test("without a local terminal: that agent's SubagentStop releases its hold empty", async () => {
    const g = gate(false);
    const hook = g.resolvePermission(sub());
    g.cancelStaleForAgent('agent-other', 'SubagentStop');
    expect(g.hasOpenHookPrompt()).toBe(true);
    g.cancelStaleForAgent('agent-1', 'SubagentStop');
    expect(await hook).toBe('passthrough');
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
        isInSubagentContext: () => false,
        holdMs: 60_000,
        hasLocalTerminal: true,
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
    stashQuestion(firstQid, 'agent-1'); // its prompt rendered and was pushed
    // Claude re-issues the IDENTICAL PermissionRequest for the same agent.
    expect(await g.resolvePermission(pr())).toBe('passthrough');
    const secondQid = parkedIds[1] as UUID;
    expect(secondQid).not.toBe(firstQid);

    expect(resolvedLog).toEqual([{ qid: firstQid, reason: 'cancelled' }]);
  });

  test('a prompt that never rendered dismisses nothing when resolved, and is still untracked (#1125)', async () => {
    // Parked, never rendered, so never pushed: there is no card on any client
    // and nothing to dismiss. The signature must still go, or a later
    // matching tool event would find it again.
    const resolvedLog: Array<{ qid: UUID; reason: string }> = [];
    const g = gate({ onResolved: (qid, reason) => resolvedLog.push({ qid, reason }) });
    expect(await g.resolvePermission(pr())).toBe('passthrough');

    g.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push' }, agentId: 'agent-1' },
      'PreToolUse-subagent',
    );

    expect(resolvedLog).toEqual([]);
    expect(g.forceRelease('probe')).toEqual({ resolved: 0 });
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
        isInSubagentContext: () => false,
        holdMs: 60_000,
        hasLocalTerminal: true,
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
        isInSubagentContext: () => false,
        holdMs: 60_000,
        hasLocalTerminal: true,
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
        isInSubagentContext: () => false,
        holdMs: 60_000,
        hasLocalTerminal: true,
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
