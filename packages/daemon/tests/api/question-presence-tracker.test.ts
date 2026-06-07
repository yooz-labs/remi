import { describe, expect, it } from 'bun:test';
import type { Question, QuestionOption } from '@remi/shared';
import { generateId } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';

function makeOption(
  label: string,
  value: string,
  extras: Partial<QuestionOption> = {},
): QuestionOption {
  return {
    label,
    value,
    isRecommended: false,
    isYes: false,
    isNo: false,
    ...extras,
  };
}

function makePTYQuestion(text = 'Allow Bash?'): Question {
  return {
    id: generateId(),
    text,
    options: [makeOption('1', '1'), makeOption('2', '2'), makeOption('3', '3')],
    allowsFreeText: false,
    isAnswered: false,
  };
}

function makeHookQuestion(text = 'Allow Bash?'): Question {
  return {
    id: generateId(),
    text,
    options: [
      makeOption('Yes', '1', { isYes: true, isRecommended: true }),
      makeOption('Yes, always', '2', { isYes: true }),
      makeOption('No', '3', { isNo: true }),
    ],
    allowsFreeText: false,
    isAnswered: false,
  };
}

describe('QuestionPresenceTracker', () => {
  it('PTY-only push (no preceding hook) — fires once with PTY question as-is', () => {
    // Covers anthropics/claude-code #23983: subagent permission requests
    // do not fire hooks at all; PTY is the only source and must still push.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    const ptyQ = makePTYQuestion('Subagent prompt visible');

    tracker.onPTYPromptVisible(ptyQ);

    expect(pushes.length).toBe(1);
    expect(pushes[0]).toBe(ptyQ);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('2+ pending hooks from different agents, PTY names none -> pushes BARE (#483)', () => {
    // Fail-safe: concurrent prompts from two subagents + a PTY question that
    // matches neither must NOT guess — push the bare PTY question rather than
    // attach the wrong agent's option labels (#425).
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    tracker.recordPendingHook({ ...makeHookQuestion('Allow Bash A?'), agentId: 'subagent-A' });
    tracker.recordPendingHook({ ...makeHookQuestion('Allow Edit B?'), agentId: 'subagent-B' });
    const ptyQ = makePTYQuestion('Some prompt'); // no agentId -> 'main', matches neither
    tracker.onPTYPromptVisible(ptyQ);
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toBe(ptyQ); // bare, not merged
    expect(pushes[0]?.options.map((o) => o.label)).toEqual(['1', '2', '3']);
    // Ambiguous hooks are dropped, not leaked into the next prompt cycle.
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('exactly one pending hook, PTY names no agent -> still pairs unambiguously (#483)', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    tracker.recordPendingHook({ ...makeHookQuestion('Allow Bash?'), agentId: 'subagent-A' });
    const ptyQ = makePTYQuestion('Allow Bash?'); // no agentId, but only one candidate
    tracker.onPTYPromptVisible(ptyQ);
    expect(pushes.length).toBe(1);
    expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, always', 'No']);
  });

  it('hook then PTY — pushes once with merged options from hook metadata', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    const hookMeta = makeHookQuestion('Edit');
    const ptyQ = makePTYQuestion('Allow Edit: /tmp/foo.ts?');

    tracker.recordPendingHook(hookMeta);
    tracker.onPTYPromptVisible(ptyQ);

    expect(pushes.length).toBe(1);
    expect(pushes[0]?.text).toBe('Allow Edit: /tmp/foo.ts?');
    // PTY id/text wins; hook options replace PTY's numbered fallback.
    expect(pushes[0]?.id).toBe(ptyQ.id);
    expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, always', 'No']);
    expect(pushes[0]?.options[0]?.isYes).toBe(true);
    expect(pushes[0]?.options[2]?.isNo).toBe(true);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('hook only — no push until PTY confirms or status clears', () => {
    // Auto-approve in progress: hook fired, LLM is evaluating. We have
    // not yet seen the prompt on screen. No push must fire yet.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.recordPendingHook(makeHookQuestion('Bash'));

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingForTest()).toBe(true);
  });

  it('hook then status transitions to executing — pending dropped, no push', () => {
    // Auto-approve approved silently: inject '1', Claude resumed → status
    // changes to 'executing'. The prompt the hook described is gone from
    // screen; the iOS user must not be poked for a prompt that no longer
    // exists.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.recordPendingHook(makeHookQuestion('Bash'));
    tracker.onStatusChange('executing');

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('hook then status transitions to thinking — pending dropped, no push', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.recordPendingHook(makeHookQuestion('Bash'));
    tracker.onStatusChange('thinking');

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it("status stays 'waiting' — pending hook is preserved", () => {
    // PermissionRequest fired and Claude is still waiting. A 'waiting'
    // status update arrives (e.g. hook-bridge's onStatusChange) — must
    // NOT drop the pending; we're still expecting PTY confirmation.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.recordPendingHook(makeHookQuestion('Edit'));
    tracker.onStatusChange('waiting');

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingForTest()).toBe(true);
  });

  it('two hooks back-to-back, one PTY — single push with newest hook metadata', () => {
    // Claude Code rarely fires two PermissionRequests for the same prompt,
    // but a Notification(permission_prompt) trailing a PermissionRequest
    // counts as a second hook arrival. Only the user-visible prompt
    // matters; pair the most recent hook with the PTY confirmation.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    const ptyQ = makePTYQuestion();

    tracker.recordPendingHook(makeHookQuestion('Bash'));
    const secondHook: Question = {
      id: generateId(),
      text: 'Allow Edit?',
      options: [
        { label: 'A', value: '1', isRecommended: true, isYes: false, isNo: false },
        { label: 'B', value: '2', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: false,
      isAnswered: false,
    };
    tracker.recordPendingHook(secondHook);
    tracker.onPTYPromptVisible(ptyQ);

    expect(pushes.length).toBe(1);
    expect(pushes[0]?.options.map((o) => o.label)).toEqual(['A', 'B']);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('PTY visible, status clears, then a second PTY visible — both push', () => {
    // Sequential prompts: first prompt rendered, user answered (status
    // moved on), second prompt rendered later. The tracker must push
    // both; clearing pending state on status change does not block the
    // next PTY emission.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.onPTYPromptVisible(makePTYQuestion('first'));
    tracker.onStatusChange('executing');
    tracker.onStatusChange('waiting');
    tracker.onPTYPromptVisible(makePTYQuestion('second'));

    expect(pushes.length).toBe(2);
    expect(pushes[0]?.text).toBe('first');
    expect(pushes[1]?.text).toBe('second');
  });

  it('hook with no usable options — PTY question fires unchanged (no replacement)', () => {
    // Edge: hook present but its options list is empty (e.g. addDirectories-
    // only suggestion that hook-event-bridge filtered out). We should
    // still push, but with the PTY question's own options.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    const ptyQ = makePTYQuestion();

    const emptyOptionsHook: Question = {
      id: generateId(),
      text: 'whatever',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    };
    tracker.recordPendingHook(emptyOptionsHook);
    tracker.onPTYPromptVisible(ptyQ);

    expect(pushes.length).toBe(1);
    expect(pushes[0]).toBe(ptyQ); // identity-equal: no shallow-merge happened.
  });

  it('clearPending — drops a pending hook record without pushing', () => {
    // Used by the auto-approve cancelled branch: Claude advanced past the
    // prompt without a status transition we can observe (e.g. user typed
    // a slash command). Without clearPending, the pending hook would
    // merge stale option labels onto the next unrelated prompt.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.recordPendingHook(makeHookQuestion('Edit'));
    expect(tracker.hasPendingForTest()).toBe(true);

    tracker.clearPending();

    expect(tracker.hasPendingForTest()).toBe(false);
    expect(pushes.length).toBe(0);
  });

  it('clearPending — also resets ptyShowingQuestion so the inject gate cannot leak', () => {
    // Sequence: PTY confirms a prompt (flag=true) -> auto-approve eval
    // returns 'cancelled' (Claude advanced past the prompt) -> bridge
    // calls clearPending. Without resetting ptyShowingQuestion, the very
    // next subagent PermissionRequest arriving before any onStatusChange
    // would find the gate open and inject "1"/"3" into a PTY that is no
    // longer showing a prompt.
    const tracker = new QuestionPresenceTracker(() => {});
    tracker.onPTYPromptVisible(makePTYQuestion());
    expect(tracker.isPromptVisibleOnPTY()).toBe(true);

    tracker.clearPending();

    expect(tracker.isPromptVisibleOnPTY()).toBe(false);
  });

  it('push sink throws — error is caught, tracker stays in a clean state', () => {
    // APNS fan-out or WebSocket send can throw mid-push. The tracker
    // must not crash the daemon process; log and move on. Pending is
    // already cleared at this point (before push), so the next PTY emit
    // re-pushes without the hook merge (degraded UX) but the system
    // stays consistent.
    const tracker = new QuestionPresenceTracker(() => {
      throw new Error('test: APNS fan-out failure');
    });
    const ptyQ = makePTYQuestion();

    expect(() => tracker.onPTYPromptVisible(ptyQ)).not.toThrow();
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  describe('isPromptVisibleOnPTY (subagent auto-approve gate)', () => {
    it('starts false before any PTY confirmation', () => {
      const tracker = new QuestionPresenceTracker(() => {});
      expect(tracker.isPromptVisibleOnPTY()).toBe(false);
    });

    it('stays false when only a hook has recorded — PTY has not confirmed yet', () => {
      // Background subagent fires PermissionRequest; LLM eval is running;
      // the prompt is NOT on the main PTY. The gate must report false so
      // hook-bridge-setup drops the inject instead of typing "1" into
      // the main agent's input.
      const tracker = new QuestionPresenceTracker(() => {});
      tracker.recordPendingHook(makeHookQuestion('Bash'));
      expect(tracker.isPromptVisibleOnPTY()).toBe(false);
    });

    it('flips to true once PTY confirms a prompt is on screen', () => {
      const tracker = new QuestionPresenceTracker(() => {});
      tracker.onPTYPromptVisible(makePTYQuestion());
      expect(tracker.isPromptVisibleOnPTY()).toBe(true);
    });

    it('flips back to false when status leaves waiting (prompt consumed)', () => {
      const tracker = new QuestionPresenceTracker(() => {});
      tracker.onPTYPromptVisible(makePTYQuestion());
      expect(tracker.isPromptVisibleOnPTY()).toBe(true);
      tracker.onStatusChange('executing');
      expect(tracker.isPromptVisibleOnPTY()).toBe(false);
    });

    it("stays true while status stays 'waiting'", () => {
      const tracker = new QuestionPresenceTracker(() => {});
      tracker.onPTYPromptVisible(makePTYQuestion());
      tracker.onStatusChange('waiting');
      expect(tracker.isPromptVisibleOnPTY()).toBe(true);
    });

    it('also flips false on transition to thinking or idle', () => {
      const tracker = new QuestionPresenceTracker(() => {});
      tracker.onPTYPromptVisible(makePTYQuestion());
      tracker.onStatusChange('thinking');
      expect(tracker.isPromptVisibleOnPTY()).toBe(false);

      tracker.onPTYPromptVisible(makePTYQuestion());
      tracker.onStatusChange('idle');
      expect(tracker.isPromptVisibleOnPTY()).toBe(false);
    });
  });
});
