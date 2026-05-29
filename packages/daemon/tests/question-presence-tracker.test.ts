/**
 * Tests for QuestionPresenceTracker per-agent pending map (#425/#437). No mocks:
 * a real push sink captures emitted questions.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, QuestionOption } from '@remi/shared';
import { generateId } from '@remi/shared';
import { QuestionPresenceTracker } from '../src/api/question-presence-tracker.ts';

function opt(label: string, value: string): QuestionOption {
  return { label, value, isRecommended: false, isYes: false, isNo: false };
}

function question(opts: { text?: string; agentId?: string; options?: QuestionOption[] }): Question {
  return {
    id: generateId(),
    text: opts.text ?? 'Allow?',
    options: opts.options ?? [],
    allowsFreeText: false,
    isAnswered: false,
    agentId: opts.agentId,
  };
}

function makeTracker() {
  const pushed: Question[] = [];
  const tracker = new QuestionPresenceTracker((q) => pushed.push(q));
  return { tracker, pushed };
}

describe('QuestionPresenceTracker per-agent pending', () => {
  test('hooks for two agents keep separate pending entries', () => {
    const { tracker } = makeTracker();
    tracker.recordPendingHook(question({ agentId: undefined, text: 'main?' }));
    tracker.recordPendingHook(question({ agentId: 'sub-7', text: 'sub?' }));
    expect(tracker.pendingCountForTest()).toBe(2);
  });

  test('a second hook for the SAME agent replaces (one slot per agent)', () => {
    const { tracker } = makeTracker();
    tracker.recordPendingHook(question({ agentId: 'sub-7', text: 'first' }));
    tracker.recordPendingHook(question({ agentId: 'sub-7', text: 'second' }));
    expect(tracker.pendingCountForTest()).toBe(1);
  });

  test('PTY visible pairs the same agent, merges its options, leaves others pending', () => {
    const { tracker, pushed } = makeTracker();
    tracker.recordPendingHook(
      question({ agentId: undefined, options: [opt('Yes', '1'), opt('No', '2')] }),
    );
    tracker.recordPendingHook(question({ agentId: 'sub-7', options: [opt('A', '1')] }));

    // PTY prompt for the main agent (numbered fallback options).
    tracker.onPTYPromptVisible(question({ agentId: undefined, options: [opt('1', '1')] }));

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.options.map((o) => o.label)).toEqual(['Yes', 'No']); // hook labels win
    // main consumed; sub-7 still pending.
    expect(tracker.pendingCountForTest()).toBe(1);
    expect(tracker.isPromptVisibleOnPTY()).toBe(true);
  });

  test('PTY-only prompt (no hook) is pushed as-is', () => {
    const { tracker, pushed } = makeTracker();
    const q = question({ agentId: undefined, options: [opt('1', '1'), opt('2', '2')] });
    tracker.onPTYPromptVisible(q);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.id).toBe(q.id);
  });

  test('most-recent fallback when PTY agent has no matching hook (#425 caveat)', () => {
    const { tracker, pushed } = makeTracker();
    tracker.recordPendingHook(
      question({ agentId: 'sub-7', options: [opt('Allow', '1'), opt('Deny', '2')] }),
    );
    // PTY prompt arrives without an agent id; no 'main' entry, so it pairs the
    // most-recent pending hook (sub-7) and adopts its labels + agentId.
    tracker.onPTYPromptVisible(question({ agentId: undefined, options: [] }));
    expect(pushed[0]?.options.map((o) => o.label)).toEqual(['Allow', 'Deny']);
    expect(pushed[0]?.agentId).toBe('sub-7');
  });

  test('status leaving waiting clears all pending and presence', () => {
    const { tracker } = makeTracker();
    tracker.recordPendingHook(question({ agentId: 'sub-7' }));
    tracker.onPTYPromptVisible(question({ agentId: undefined }));
    expect(tracker.isPromptVisibleOnPTY()).toBe(true);
    tracker.onStatusChange('thinking');
    expect(tracker.pendingCountForTest()).toBe(0);
    expect(tracker.isPromptVisibleOnPTY()).toBe(false);
  });

  test('clearPending drops all records and presence', () => {
    const { tracker } = makeTracker();
    tracker.recordPendingHook(question({ agentId: undefined }));
    tracker.recordPendingHook(question({ agentId: 'sub-7' }));
    tracker.clearPending();
    expect(tracker.hasPendingForTest()).toBe(false);
    expect(tracker.isPromptVisibleOnPTY()).toBe(false);
  });
});
