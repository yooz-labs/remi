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
 * V1 of this suite (and the mechanism it tested) compared the PTY-parsed
 * render's id alone to decide "superseded". Review found that unsound on two
 * fronts -- the PTY parser mints a fresh id on every parse even for a
 * REDRAW of unchanged text (#486), and a replacement push can be silently
 * eaten by `QuestionDedup`'s 5s window before it ever reaches
 * `SessionRegistry.addQuestion` -- and, reachable in production, a
 * PTY-text-parsed status false-positive (`output-processor.ts`,
 * confidence >= 0.5) could fire this mechanism with NO paired dedup reset,
 * so a redraw's replacement got deduped away while the original was already
 * reported cancelled. Net: a live question, swallowed, in one status hiccup.
 *
 * This suite now pins the corrected design: `pairAndPush` pushes first, then
 * reads the `QuestionRegistrationOutcome` the push call itself returned
 * (#888 criterion iii) to CONFIRM the replacement actually landed before
 * resolving the question it superseded (`QuestionPresenceTracker.pairAndPush`'s
 * own doc has the full chain -- this used to be a separate `isQuestionLive`
 * dep that re-queried a store after the fact; deleted once the push's own
 * return value could report the same thing directly). The status-leaves-
 * 'waiting' and `clearPending` triggers were dropped entirely -- neither can
 * be trusted as evidence a SPECIFIC question's render is gone (see their own
 * reset comments in the tracker) -- so this suite also pins that they no
 * longer resolve anything.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, QuestionOption } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { QuestionRegistrationOutcome } from '../../src/api/message-api.ts';
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
  /** Ids currently "registered" in this harness's fake store -- mirrors
   *  SessionRegistry.currentQuestions closely enough to exercise the
   *  confirmed-delivery gate: a push adds to it (unless `shouldDeliver`
   *  says it was deduped), a resolution removes from it. */
  liveIds: Set<string>;
}

interface BuildOpts {
  extraDeps?: Record<string, unknown>;
  /** Simulates QuestionDedup: return false to make a specific push NOT
   *  land (as if suppressed). Defaults to "every push lands". */
  shouldDeliver?: (q: Question) => boolean;
  /** Make the push sink report no outcome at all (`void`), to test the
   *  safe-default case a push sink that does not implement the
   *  `QuestionRegistrationOutcome` contract falls into. Defaults to
   *  reporting the real outcome every time. */
  reportOutcome?: boolean;
}

function buildTracker(opts: BuildOpts = {}): Harness {
  const pushed: Question[] = [];
  const gone: Array<{ id: string; reason: string }> = [];
  const liveIds = new Set<string>();
  const shouldDeliver = opts.shouldDeliver ?? (() => true);
  const reportOutcome = opts.reportOutcome ?? true;
  const tracker = new QuestionPresenceTracker(
    (q): QuestionRegistrationOutcome | undefined => {
      pushed.push(q);
      const delivered = shouldDeliver(q);
      if (delivered) liveIds.add(q.id);
      if (!reportOutcome) return undefined;
      return delivered ? { status: 'registered' } : { status: 'deduped' };
    },
    {
      onHooklessQuestionGone: (id, reason) => {
        gone.push({ id, reason });
        liveIds.delete(id);
      },
      ...opts.extraDeps,
    },
  );
  return { tracker, pushed, gone, liveIds };
}

describe('QuestionPresenceTracker render-resolution (#888/#920)', () => {
  test('a hook-less push starts tracking it as the observed hook-less question', () => {
    const { tracker, pushed, gone } = buildTracker();
    const q = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(q);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.id).toBe(q.id);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(q.id);
    expect(gone).toHaveLength(0); // nothing superseded yet
  });

  test('a SECOND hook-less render, CONFIRMED delivered, resolves the FIRST id', () => {
    const { tracker, gone } = buildTracker();
    const first = makeHooklessPTYQuestion('First prompt');
    const second = makeHooklessPTYQuestion('Second prompt');
    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(second);

    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(second.id);
  });

  test('the hard requirement fix: a redraw whose replacement push is DEDUPED does NOT resolve the original', () => {
    // The exact swallow class found in review: a same-text redraw mints a
    // fresh id (#486) but its own push gets suppressed (QuestionDedup, or
    // any other reason it never lands). The original must stay tracked and
    // stay pending -- resolving it here would be the disqualifying failure
    // (a live question with no card, already reported "cancelled").
    const first = makeHooklessPTYQuestion('Do you want to proceed?');
    const second = makeHooklessPTYQuestion('Do you want to proceed?');
    const { tracker, gone, liveIds } = buildTracker({
      shouldDeliver: (q) => q.id !== second.id, // second is "deduped"
    });
    tracker.onPTYPromptVisible(first);
    expect(liveIds.has(first.id)).toBe(true);

    tracker.onPTYPromptVisible(second);

    expect(gone).toHaveLength(0); // first was NOT resolved
    expect(liveIds.has(first.id)).toBe(true); // still live in the store
    expect(liveIds.has(second.id)).toBe(false); // second never landed
    // Tracking still points at the original -- a LATER confirmed
    // supersession can still resolve it correctly.
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(first.id);
  });

  test('a redraw of the SAME text, once CONFIRMED delivered (e.g. a richer re-emission), still supersedes', () => {
    // Distinguishes "same text" from "not delivered": QuestionDedup lets a
    // RICHER re-emission through even within its window. Once delivered is
    // confirmed, resolution must still fire -- the guard is delivery, not
    // text identity (this suite deliberately does not reinvent
    // isPromptCurrent's text-fallback policy; see isQuestionLive's doc).
    const { tracker, gone } = buildTracker();
    const redrawText = 'Do you want to proceed?';
    const first = makeHooklessPTYQuestion(redrawText);
    const second = makeHooklessPTYQuestion(redrawText);
    expect(first.id).not.toBe(second.id);

    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(second);

    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(second.id);
  });

  test('status changes never resolve a hook-less question (trigger dropped, #888 review fix)', () => {
    const { tracker, gone } = buildTracker();
    const q = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(q);

    tracker.onStatusChange('executing'); // leaves 'waiting'
    expect(gone).toHaveLength(0);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(q.id);

    tracker.onStatusChange('waiting'); // back to 'waiting'
    expect(gone).toHaveLength(0);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(q.id);
  });

  test('clearPending never resolves a hook-less question (trigger dropped, #888 review fix)', () => {
    const { tracker, gone } = buildTracker();
    const q = makeHooklessPTYQuestion();
    tracker.onPTYPromptVisible(q);
    tracker.clearPending();

    expect(gone).toHaveLength(0);
    // Tracking survives clearPending too -- a later CONFIRMED supersession
    // can still resolve it, exactly as if clearPending had never run.
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(q.id);
  });

  /**
   * CHANGED by #1005 Change B. This test previously asserted that a
   * hook-paired render is NOT tracked, justified as "it has its own removal
   * path". That justification was measured false for the cohort that matters:
   * a parked subagent escalation is hook-BORN, but its hook was answered
   * `passthrough` at park time (ADR 0004), so its only exits are an
   * exact-signature tool-run match, a phone answer, or `SubagentStop` — and a
   * terminal DENY fires no tool call, the lead-`Stop` sweep skips subagent
   * entries (#711), and a teammate can run for days without `SubagentStop`.
   *
   * Tracing the 8 cards stuck in a real pending set: 7 subagent-tagged, every
   * one removed ONLY by `lru_eviction`, 2.5-12.5h after being added. The
   * "own removal path" did not exist. So a hook-paired render IS tracked now.
   */
  test('a HOOK-PAIRED render IS tracked as render-owned (#1005)', () => {
    const { tracker, gone } = buildTracker();
    const hookRecord = makeHookRecord();
    tracker.recordPendingHook(hookRecord);
    const ptyRender = makeHooklessPTYQuestion(); // agentless -> pairs as sole candidate
    tracker.onPTYPromptVisible(ptyRender);

    // The merged push adopts the HOOK's id (#887), so that is what is tracked.
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(hookRecord.id);
    expect(gone).toHaveLength(0); // nothing was superseded yet
  });

  test('a hook-paired render, CONFIRMED delivered, SUPERSEDES a previously-tracked hook-less one', () => {
    const { tracker, gone } = buildTracker();
    const hookless = makeHooklessPTYQuestion('orphan prompt');
    tracker.onPTYPromptVisible(hookless);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(hookless.id);

    const hookRecord = makeHookRecord();
    tracker.recordPendingHook(hookRecord);
    const paired = makeHooklessPTYQuestion('Allow Bash: git push'); // matches hook by sole-candidate
    tracker.onPTYPromptVisible(paired);

    expect(gone).toEqual([{ id: hookless.id, reason: 'pty_render_superseded' }]);
    // The merged push adopted the HOOK's id (#887), and since #1005 a
    // hook-paired render takes the render-owned slot rather than clearing it —
    // so the NEXT confirmed render can resolve this one in turn.
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(hookRecord.id);
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
    // completely separate mechanism (#573) that never renders on the PTY,
    // and pushHeldHook never runs the confirmed-delivery gate at all.
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(hookless.id);
    expect(gone).toHaveLength(0);
  });

  test('a throwing onHooklessQuestionGone dep is caught and logged, never propagated', () => {
    const pushed: Question[] = [];
    const tracker = new QuestionPresenceTracker(
      (q): QuestionRegistrationOutcome => {
        pushed.push(q);
        return { status: 'registered' };
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
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(second.id);
  });

  test('no onHooklessQuestionGone dep wired: tracker behaves exactly as before #888', () => {
    const pushed: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushed.push(q);
      return undefined;
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

  test('safe default: onHooklessQuestionGone wired but the push sink reports NO outcome -- never resolves (fail toward showing)', () => {
    const { tracker, gone } = buildTracker({ reportOutcome: false });
    const first = makeHooklessPTYQuestion('first');
    const second = makeHooklessPTYQuestion('second');
    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(second);

    // Without a reported outcome, "delivered" defaults to false -- the
    // mechanism is fully inert, matching pre-#888 behavior rather than
    // guessing.
    expect(gone).toHaveLength(0);
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

  test('the ORPHAN (debounced) path also tracks and resolves hook-less questions, gated on confirmed delivery', async () => {
    const { tracker, pushed, gone } = buildTracker({
      extraDeps: {
        orphanDebounceMs: 5,
        hasLiveQuestions: () => false,
      },
    });
    const first = makeHooklessPTYQuestion('orphan A');
    tracker.onOrphanPTYPrompt(first);
    await new Promise((r) => setTimeout(r, 30));
    expect(pushed).toHaveLength(1);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(first.id);

    const second = makeHooklessPTYQuestion('orphan B');
    tracker.onOrphanPTYPrompt(second);
    await new Promise((r) => setTimeout(r, 30));
    expect(pushed).toHaveLength(2);
    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
  });
});

/**
 * #1002. `handleAnswer` needs to know "is a prompt on screen?" before typing a
 * digit into the PTY. The obvious candidate, `isPromptVisibleOnPTY`, cannot
 * answer that: it means "this tracker PUSHED a card off a PTY render", which is
 * false for the most common cohort of all — a gate-owned hook card whose native
 * prompt renders is recognised as an echo and suppressed without setting it.
 *
 * These tests exist because the first attempt at #1002 used that flag and would
 * have refused every legitimate hook-sourced answer. They pin the distinction so
 * the two are not "simplified" back together.
 */
describe('#1002 prompt-on-screen signals are not interchangeable', () => {
  test('a gate-owned hook render: visible=false, observed=true', () => {
    const { tracker } = buildTracker();
    const hook = makeHookRecord('Allow Bash: ls -la');
    tracker.recordPendingHook(hook);
    tracker.onOrphanPTYPrompt(makeHooklessPTYQuestion('Allow Bash: ls -la'));

    // Suppressed as a gate-owned echo, so it never pushed a card off the render.
    expect(tracker.isPromptVisibleOnPTY()).toBe(false);
    // But a prompt IS genuinely on screen, and this reports it.
    expect(tracker.isPromptObservedOnPTY()).toBe(true);
  });

  test('observed starts false, before anything has rendered', () => {
    const { tracker } = buildTracker();
    expect(tracker.isPromptObservedOnPTY()).toBe(false);
  });

  test('a status transition off waiting clears observed (the stale-card case)', () => {
    const { tracker } = buildTracker();
    tracker.recordPendingHook(makeHookRecord('Allow Bash: ls -la'));
    tracker.onOrphanPTYPrompt(makeHooklessPTYQuestion('Allow Bash: ls -la'));
    expect(tracker.isPromptObservedOnPTY()).toBe(true);

    tracker.onStatusChange('thinking');
    expect(tracker.isPromptObservedOnPTY()).toBe(false);
  });

  test('clearPending clears observed', () => {
    const { tracker } = buildTracker();
    tracker.recordPendingHook(makeHookRecord('Allow Bash: ls -la'));
    tracker.onOrphanPTYPrompt(makeHooklessPTYQuestion('Allow Bash: ls -la'));
    tracker.clearPending();
    expect(tracker.isPromptObservedOnPTY()).toBe(false);
  });

  test('a hookless render sets both signals', () => {
    const { tracker } = buildTracker();
    tracker.onPTYPromptVisible(makeHooklessPTYQuestion());
    expect(tracker.isPromptVisibleOnPTY()).toBe(true);
    expect(tracker.isPromptObservedOnPTY()).toBe(true);
  });
});

/**
 * #1005 Change B. The parked-render ARBITRATION push (an escalate verdict, the
 * "45 born live" cohort) went through `pushMerged` directly, bypassing the
 * render-owned bookkeeping entirely — so those cards were tracked by nothing
 * and could only ever leave the store via LRU eviction.
 */
describe('#1005 an arbitration-verdict push takes the render-owned slot', () => {
  function trackerWithArbiter(
    pushes: Question[],
    gone: Array<{ id: string; reason: string }>,
    verdict: 'push' | 'answered',
    deliver: () => boolean = () => true,
  ): QuestionPresenceTracker {
    const tracker = new QuestionPresenceTracker(
      (q) => {
        pushes.push(q);
        return deliver() ? { status: 'registered' as const } : { status: 'deduped' as const };
      },
      { onHooklessQuestionGone: (id, reason) => gone.push({ id, reason }) },
    );
    tracker.setParkedRenderArbiter(async () => ({ outcome: verdict }));
    return tracker;
  }

  test('an escalated parked render is superseded by the next confirmed render', async () => {
    const pushes: Question[] = [];
    const gone: Array<{ id: string; reason: string }> = [];
    const tracker = trackerWithArbiter(pushes, gone, 'push');

    const hook = makeHookRecord('reviewer · Bash: git push');
    tracker.recordPendingHook(hook);
    tracker.parkAwaitingPTY(hook);
    tracker.onOrphanPTYPrompt(makeHooklessPTYQuestion('Do you want to proceed?'));
    await new Promise((r) => setTimeout(r, 5));

    expect(pushes).toHaveLength(1);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(hook.id);

    // A different prompt takes the screen: the escalated card's prompt is
    // provably gone, so the card is resolved instead of lingering.
    tracker.onPTYPromptVisible(makeHooklessPTYQuestion('A different prompt'));
    expect(gone).toEqual([{ id: hook.id, reason: 'pty_render_superseded' }]);
  });

  test('an UNCONFIRMED arbitration push does not claim the slot (ADR 0021)', async () => {
    const pushes: Question[] = [];
    const gone: Array<{ id: string; reason: string }> = [];
    const tracker = trackerWithArbiter(pushes, gone, 'push', () => false);

    const hook = makeHookRecord('reviewer · Bash: git push');
    tracker.recordPendingHook(hook);
    tracker.parkAwaitingPTY(hook);
    tracker.onOrphanPTYPrompt(makeHooklessPTYQuestion('Do you want to proceed?'));
    await new Promise((r) => setTimeout(r, 5));

    // Deduped: nothing is known to have changed, so nothing is tracked and
    // nothing is resolved on its strength.
    expect(tracker.observedRenderOwnedQuestionForTest()).toBeNull();
    expect(gone).toHaveLength(0);
  });

  test('an ANSWERED verdict pushes nothing and claims nothing', async () => {
    const pushes: Question[] = [];
    const gone: Array<{ id: string; reason: string }> = [];
    const tracker = trackerWithArbiter(pushes, gone, 'answered');

    const hook = makeHookRecord('reviewer · Bash: git push');
    tracker.recordPendingHook(hook);
    tracker.parkAwaitingPTY(hook);
    tracker.onOrphanPTYPrompt(makeHooklessPTYQuestion('Do you want to proceed?'));
    await new Promise((r) => setTimeout(r, 5));

    expect(pushes).toHaveLength(0);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBeNull();
  });
});

/**
 * #1008 review. The render-owned slot was the ONE piece of state in this file
 * that was not agent-keyed, and #1008 moved the highest-stakes cohort
 * (deliberately-escalated subagent permissions) into it. Nothing in this file
 * exercised two concurrent agents in either direction, which is how that
 * shipped unnoticed.
 */
describe('#1008 a different agent never supersedes, and a redraw is not a replacement', () => {
  function makeAgentPTY(agentId: string, text: string): Question {
    return { ...makeHooklessPTYQuestion(text), agentId } as Question;
  }

  test('agent B rendering does NOT resolve agent A card', () => {
    const { tracker, gone } = buildTracker();
    const a = makeAgentPTY('agent-a', 'Allow Bash: git push');
    tracker.onPTYPromptVisible(a);
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(a.id);

    // A completely unrelated agent's permission renders on the shared PTY.
    // Nobody answered A; no tool ran; no SubagentStop fired.
    const b = makeAgentPTY('agent-b', 'Allow Bash: rm -rf build');
    tracker.onPTYPromptVisible(b);

    expect(gone).toHaveLength(0); // A must survive
  });

  test('the SAME agent rendering something different does supersede', () => {
    const { tracker, gone } = buildTracker();
    const first = makeAgentPTY('agent-a', 'Allow Bash: git push');
    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(makeAgentPTY('agent-a', 'Allow Bash: something else'));

    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
  });

  test('a same-agent redraw DOES supersede, and that is correct', () => {
    // Review proposed refusing this too (a redraw is "the same prompt"). It is
    // #888's deliberate policy -- "the guard is delivery, not text identity" --
    // and the harm does not apply: a supersede only fires on a CONFIRMED
    // registration, so the user still holds a card for this prompt, the new
    // one. Cross-agent above is the case that leaves a prompt with NO card.
    const { tracker, gone } = buildTracker();
    const first = makeAgentPTY('agent-a', 'Do you want to proceed?');
    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(makeAgentPTY('agent-a', 'Do you want to proceed?'));

    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
  });

  test('main-agent prompts still supersede each other', () => {
    const { tracker, gone } = buildTracker();
    const first = makeHooklessPTYQuestion('first prompt');
    tracker.onPTYPromptVisible(first);
    tracker.onPTYPromptVisible(makeHooklessPTYQuestion('second prompt'));

    expect(gone).toEqual([{ id: first.id, reason: 'pty_render_superseded' }]);
  });
});

/**
 * #1008 review follow-up, found by probing rather than by the review.
 *
 * The first cut of the agent scoping keyed on the RAW PTY question. A PTY parse
 * usually carries no `agentId` — "Do you want to proceed?" says nothing about
 * whose permission it is — so `agentKey` fell back to `main` and filed a parked
 * SUBAGENT card under the main agent. The next main-agent prompt then
 * superseded it: exactly the cross-agent bleed the scoping was added to stop,
 * reintroduced by the scoping itself.
 *
 * Keying on the MERGED question fixes it, because the merge takes the hook
 * record's `agentId`, which is the half that knows.
 */
describe('#1008 a parked subagent card is scoped by its HOOK agent, not the PTY parse', () => {
  test('a main-agent prompt does not resolve a parked subagent card', async () => {
    const { tracker, gone } = buildTracker();
    tracker.setParkedRenderArbiter(async () => ({ outcome: 'push' }));

    const hook = makeHookRecord('reviewer · Bash: git push');
    (hook as { agentId?: string }).agentId = 'agent-1';
    tracker.recordPendingHook(hook);
    tracker.parkAwaitingPTY(hook);

    // The render itself carries NO agentId -- this is the normal case.
    tracker.onOrphanPTYPrompt(makeHooklessPTYQuestion('Do you want to proceed?'));
    await new Promise((r) => setTimeout(r, 5));
    expect(tracker.observedRenderOwnedQuestionForTest()).toBe(hook.id);

    // A genuinely different, main-agent prompt takes the screen.
    tracker.onPTYPromptVisible(makeHooklessPTYQuestion('A different main prompt'));

    expect(gone).toHaveLength(0);
  });
});
