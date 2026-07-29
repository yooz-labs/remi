/**
 * Tests for the #888/#920 render-resolution transition: the hard
 * requirement that the pending-question store be able to resolve a question
 * whose ONLY evidence was a screen render.
 *
 * Root cause (#920, measured from a real capture): a genuinely hook-less
 * question (no PermissionRequest/Notification hook ever fired for it -- an
 * agent-team native prompt, a bare subprocess `(y/n)`) has no tool signature
 * for `AutoApproveGate.cancelExternallyResolved` or the Stop/SubagentStop
 * sweeps to match. Its only pre-#888 exits were the user answering it, or
 * the `MAX_PENDING_QUESTIONS` LRU cap -- 12 of 29 source-less questions were
 * measured never removed over one working day, one still pending 2h51m
 * later.
 *
 * `QuestionPresenceTracker.observedHooklessQuestion` + the
 * `onHooklessQuestionGone` dep close that gap: the render disappearing IS
 * the resolution evidence for this cohort. This suite drives the tracker
 * directly (no mocks -- a real `QuestionPresenceTracker`, spying on the push
 * sink and the new dep) through every transition that must fire it, and
 * confirms a hook-PAIRED question -- which has its own signature-matched
 * removal path -- is never touched by this mechanism.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, QuestionOption } from '@remi/shared';
import { generateId } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';

function makeOption(
  label: string,
  value: string,
  extras: Partial<QuestionOption> = {},
): QuestionOption {
  return { label, value, isRecommended: false, isYes: false, isNo: false, ...extras };
}

/** A genuinely hook-less PTY-parsed question, exactly as `question-parser.ts`
 *  produces one post-#920 (source: 'pty', fresh id every call). */
function makeHooklessPTYQuestion(text = 'Do you want to proceed?'): Question {
  return {
    id: generateId(),
    text,
    options: [makeOption('1', '1'), makeOption('2', '2')],
    allowsFreeText: false,
    isAnswered: false,
    source: 'pty',
  };
}

/** A hook record with real option labels (#574), as `HookEventBridge` mints
 *  one -- what makes a PTY render "hook-paired" once it merges with this. */
function makeHookRecord(text = 'Allow Bash: git push'): Question {
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
    source: 'permission_request',
  };
}

interface Harness {
  tracker: QuestionPresenceTracker;
  pushed: Question[];
  gone: Array<{ id: string; reason: string }>;
}

function buildTracker(extraDeps: Record<string, unknown> = {}): Harness {
  const pushed: Question[] = [];
  const gone: Array<{ id: string; reason: string }> = [];
  const tracker = new QuestionPresenceTracker(
    (q) => {
      pushed.push(q);
    },
    {
      onHooklessQuestionGone: (id, reason) => {
        gone.push({ id, reason });
      },
      ...extraDeps,
    },
  );
  return { tracker, pushed, gone };
}

describe('QuestionPresenceTracker render-resolution (#888/#920)', () => {
  test('a hook-less push starts tracking it as the observed hook-less question', () => {
    const { tracker, pushed, gone } = buildTracker();
    const q = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(q);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.id).toBe(q.id);
    expect(tracker.observedHooklessQuestionForTest()).toBe(q.id);
    expect(gone).toHaveLength(0); // nothing superseded yet
  });

  test('a SECOND hook-less render fires onHooklessQuestionGone for the FIRST id (supersession)', () => {
    const { tracker, gone } = buildTracker();
    const first = makeHooklessPTYQuestion('First prompt');
    const second = makeHooklessPTYQuestion('Second prompt');
    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(second);

    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
    expect(tracker.observedHooklessQuestionForTest()).toBe(second.id);
  });

  test('a redraw of the SAME text still supersedes (fresh id every parse, #486)', () => {
    // question-parser.ts mints a brand-new id on every single parse
    // regardless of content -- a hook-less question that merely redraws
    // (identical text) is indistinguishable from a genuinely new one at
    // this layer, so its stale registry entry must still be resolved.
    const { tracker, gone } = buildTracker();
    const redrawText = 'Do you want to proceed?';
    const first = makeHooklessPTYQuestion(redrawText);
    const second = makeHooklessPTYQuestion(redrawText);
    expect(first.id).not.toBe(second.id);

    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(second);

    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
    expect(tracker.observedHooklessQuestionForTest()).toBe(second.id);
  });

  test('status leaving "waiting" resolves the tracked hook-less question', () => {
    const { tracker, gone } = buildTracker();
    const q = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(q);
    tracker.onStatusChange('executing');

    expect(gone).toEqual([{ id: q.id, reason: 'pty_status_left_waiting' }]);
    expect(tracker.observedHooklessQuestionForTest()).toBeNull();
  });

  test('status staying "waiting" does NOT resolve the tracked hook-less question', () => {
    const { tracker, gone } = buildTracker();
    const q = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(q);
    tracker.onStatusChange('waiting');

    expect(gone).toHaveLength(0);
    expect(tracker.observedHooklessQuestionForTest()).toBe(q.id);
  });

  test('clearPending resolves the tracked hook-less question', () => {
    const { tracker, gone } = buildTracker();
    const q = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(q);
    tracker.clearPending();

    expect(gone).toEqual([{ id: q.id, reason: 'pty_clear_pending' }]);
    expect(tracker.observedHooklessQuestionForTest()).toBeNull();
  });

  test('a HOOK-PAIRED render is never tracked as hook-less (it has its own removal path)', () => {
    const { tracker, gone } = buildTracker();
    const hookRecord = makeHookRecord();
    tracker.recordPendingHook(hookRecord);
    const ptyRender = makeHooklessPTYQuestion(); // agentless -> pairs as sole candidate
    tracker.onPTYPromptVisible(ptyRender);

    expect(tracker.observedHooklessQuestionForTest()).toBeNull();
    tracker.onStatusChange('executing');
    expect(gone).toHaveLength(0); // nothing hook-less was ever tracked
  });

  test('a hook-paired render SUPERSEDES a previously-tracked hook-less one', () => {
    const { tracker, gone } = buildTracker();
    const hookless = makeHooklessPTYQuestion('orphan prompt');
    tracker.onPTYPromptVisible(hookless);
    expect(tracker.observedHooklessQuestionForTest()).toBe(hookless.id);

    const hookRecord = makeHookRecord();
    tracker.recordPendingHook(hookRecord);
    const paired = makeHooklessPTYQuestion('Allow Bash: git push'); // matches hook by sole-candidate
    tracker.onPTYPromptVisible(paired);

    expect(gone).toEqual([{ id: hookless.id, reason: 'pty_render_superseded' }]);
    // The merged push adopted the HOOK's id (#887) -- tracking is null now,
    // not the merged id, because the merge was hook-paired.
    expect(tracker.observedHooklessQuestionForTest()).toBeNull();
  });

  test('a HELD-hook push (always hook-derived) never touches hook-less tracking', () => {
    const { tracker, gone } = buildTracker();
    const hookless = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(hookless);

    const held = makeHookRecord('Allow Bash: rm -rf /tmp');
    tracker.recordPendingHook(held);
    const pushedHeld = tracker.pushHeldHook(held.id);

    expect(pushedHeld).toBe(true);
    // The hook-less question is untouched by the held push -- it is a
    // completely separate mechanism (#573) that never renders on the PTY.
    expect(tracker.observedHooklessQuestionForTest()).toBe(hookless.id);
    expect(gone).toHaveLength(0);
  });

  test('a throwing onHooklessQuestionGone dep is caught and logged, never propagated', () => {
    const pushed: Question[] = [];
    const tracker = new QuestionPresenceTracker(
      (q) => {
        pushed.push(q);
      },
      {
        onHooklessQuestionGone: () => {
          throw new Error('boom');
        },
      },
    );
    const first = makeHooklessPTYQuestion('first');
    const second = makeHooklessPTYQuestion('second');
    tracker.onPTYPromptVisible(first);
    expect(() => tracker.onPTYPromptVisible(second)).not.toThrow();
    // Tracking still advances correctly despite the dep throwing.
    expect(tracker.observedHooklessQuestionForTest()).toBe(second.id);
  });

  test('no onHooklessQuestionGone dep wired: tracker behaves exactly as before #888', () => {
    const pushed: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushed.push(q);
    });
    const first = makeHooklessPTYQuestion('first');
    const second = makeHooklessPTYQuestion('second');
    expect(() => {
      tracker.onPTYPromptVisible(first);
      tracker.onPTYPromptVisible(second);
      tracker.onStatusChange('idle');
    }).not.toThrow();
    expect(pushed).toHaveLength(2);
  });

  test('a hook-paired merge takes the HOOK record source, not the PTY parse source', () => {
    // #888 review finding: consumeAndMerge's `...ptyQuestion` spread silently
    // carried ptyQuestion.source onto a hook-paired merge before this fix.
    // Once question-parser.ts sets `source: 'pty'` on every PTY parse
    // (#920), an unfixed merge would have mislabeled every hook-paired
    // render as the unresolvable-by-signature cohort -- muddying the exact
    // measurement #920's acceptance criterion needs. The hook's own source
    // must win, mirroring text/options/agentId.
    const { tracker, pushed } = buildTracker();
    const hookRecord = makeHookRecord('Allow Bash: git push');
    tracker.recordPendingHook(hookRecord);
    const ptyRender = makeHooklessPTYQuestion('Allow Bash: git push');
    expect(ptyRender.source).toBe('pty');

    tracker.onPTYPromptVisible(ptyRender);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.source).toBe('permission_request');
    expect(pushed[0]?.source).not.toBe('pty');
  });

  test('a genuinely hook-less merge keeps the PTY parse source', () => {
    const { tracker, pushed } = buildTracker();
    const ptyRender = makeHooklessPTYQuestion('orphan prompt');
    tracker.onPTYPromptVisible(ptyRender);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.source).toBe('pty');
  });

  test('the ORPHAN (debounced) path also tracks and resolves hook-less questions', async () => {
    const { tracker, pushed, gone } = buildTracker({
      orphanDebounceMs: 5,
      hasLiveQuestions: () => false,
    });
    const first = makeHooklessPTYQuestion('orphan A');
    tracker.onOrphanPTYPrompt(first);
    await new Promise((r) => setTimeout(r, 30));
    expect(pushed).toHaveLength(1);
    expect(tracker.observedHooklessQuestionForTest()).toBe(first.id);

    const second = makeHooklessPTYQuestion('orphan B');
    tracker.onOrphanPTYPrompt(second);
    await new Promise((r) => setTimeout(r, 30));
    expect(pushed).toHaveLength(2);
    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
  });
});
