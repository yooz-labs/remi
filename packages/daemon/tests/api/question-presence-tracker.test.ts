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
    expect(tracker.hasPendingHookForTest()).toBe(false);
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
    expect(tracker.hasPendingHookForTest()).toBe(false);
  });

  it('hook only — no push until PTY confirms or status clears', () => {
    // Auto-approve in progress: hook fired, LLM is evaluating. We have
    // not yet seen the prompt on screen. No push must fire yet.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.recordPendingHook(makeHookQuestion('Bash'));

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingHookForTest()).toBe(true);
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
    expect(tracker.hasPendingHookForTest()).toBe(false);
  });

  it('hook then status transitions to thinking — pending dropped, no push', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));

    tracker.recordPendingHook(makeHookQuestion('Bash'));
    tracker.onStatusChange('thinking');

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingHookForTest()).toBe(false);
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
    expect(tracker.hasPendingHookForTest()).toBe(true);
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
    expect(tracker.hasPendingHookForTest()).toBe(false);
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
});
