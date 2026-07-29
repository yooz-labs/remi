/**
 * Real-`MessageAPI`-and-`QuestionDedup` integration tests for #888's
 * render-resolution transition (review-requested).
 *
 * The unit-level render-resolution suite
 * (`question-presence-tracker-render-resolution.test.ts`) drives
 * `QuestionPresenceTracker` with a bare test-local push sink that always
 * "delivers" -- it never touches the REAL `QuestionDedup` a production
 * session actually pushes through. Per ADR 0011 ("a test named for a
 * component must construct it"), that suite's confidence about dedup
 * interaction was a claim, not a fact. This suite constructs the real
 * `SessionRegistry` + `MessageAPI` (and, inside it, the real `QuestionDedup`
 * it always owns) + `QuestionPresenceTracker`, wired exactly the way
 * `cli.ts`'s `createNewSession` wires them:
 *   - the tracker's push sink is `messageApi.handleQuestion`, not a raw
 *     collector;
 *   - `isQuestionLive` reads `sessionRegistry.getQuestion`;
 *   - `onHooklessQuestionGone` calls `sessionRegistry.removeQuestion`.
 *
 * It reproduces the exact failure chain review found in the V1 mechanism:
 * `cli.ts`'s OutputProcessor-driven status callback calls
 * `tracker.onStatusChange` UNCONDITIONALLY but gates `messageApi.
 * handleStatusChange` (which resets QuestionDedup) behind `!hookServer` --
 * so on the common path (a hook server IS running), a PTY-text-parsed
 * status flap reaches the tracker with NO paired dedup reset. This suite
 * drives that same asymmetry directly (never calling
 * `messageApi.handleStatusChange` from the flap, mirroring the
 * `hookServer` truthy branch) and asserts the question survives.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, QuestionOption, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

function opt(label: string, value: string, extras: Partial<QuestionOption> = {}): QuestionOption {
  return { label, value, isRecommended: false, isYes: false, isNo: false, ...extras };
}

/** A hook-less PTY-parsed question (source: 'pty', fresh id every call, as
 *  question-parser.ts produces post-#920). `optionCount` lets a test build a
 *  "richer" redraw that QuestionDedup lets through even within its window,
 *  without needing to wait out or fake the real 5s clock. */
function hooklessQuestion(text: string, optionCount = 2): Question {
  const options: QuestionOption[] = [];
  for (let i = 1; i <= optionCount; i++) options.push(opt(String(i), String(i)));
  return {
    id: generateId() as UUID,
    text,
    options,
    allowsFreeText: false,
    isAnswered: false,
    source: 'pty',
  };
}

function fakePTY(): PTYSession {
  return { id: generateId(), close: () => Promise.resolve() } as unknown as PTYSession;
}

interface Pipeline {
  sessionRegistry: SessionRegistry;
  messageApi: MessageAPI;
  tracker: QuestionPresenceTracker;
  sid: UUID;
}

/** Builds the real production pipeline the way `cli.ts`'s `createNewSession`
 *  + `message-api-setup.ts`'s `createMessageApiForSession` wire it -- no
 *  mocks, no synthetic stand-in for MessageAPI or QuestionDedup. */
function buildPipeline(): Pipeline {
  const sessionRegistry = new SessionRegistry();
  const sid = generateId() as UUID;
  sessionRegistry.registerSession(sid, '/messageapi-integration-test', fakePTY(), {
    bulletCount: 0,
  } as unknown as MessageAPI);

  const messageApi = new MessageAPI(
    { sessionId: sid, initialBulletId: 1 },
    {
      // Mirrors message-api-setup.ts's onQuestion callback: the ONLY part
      // relevant here is that a delivered (non-deduped) question always
      // registers in SessionRegistry.
      onQuestion: (question) => {
        sessionRegistry.addQuestion(sid, question, question.source ?? 'unknown');
      },
    },
  );

  const tracker = new QuestionPresenceTracker((q, opts) => messageApi.handleQuestion(q, opts), {
    isQuestionLive: (id) => sessionRegistry.getQuestion(sid, id as UUID) !== null,
    onHooklessQuestionGone: (id, reason) => {
      sessionRegistry.removeQuestion(
        sid,
        id as UUID,
        reason,
        undefined,
        'test:onHooklessQuestionGone',
      );
    },
  });

  return { sessionRegistry, messageApi, tracker, sid };
}

describe('QuestionPresenceTracker + real MessageAPI/QuestionDedup integration (#888 review)', () => {
  test('hard requirement (positive case): a genuinely new hook-less render resolves the one it replaces', () => {
    const { sessionRegistry, tracker, sid } = buildPipeline();
    const first = hooklessQuestion('First native prompt');
    tracker.onPTYPromptVisible(first);
    expect(sessionRegistry.getQuestion(sid, first.id)).not.toBeNull();

    const second = hooklessQuestion('Second native prompt');
    tracker.onPTYPromptVisible(second);

    expect(sessionRegistry.getQuestion(sid, first.id)).toBeNull(); // resolved
    expect(sessionRegistry.getQuestion(sid, second.id)).not.toBeNull(); // now live
  });

  test('the flap-then-redraw chain: a status false-positive must not swallow a still-live question', () => {
    // Reproduces the exact chain from review:
    //   1. A renders and registers.
    //   2. A PTY-text-parsed status "leaves waiting" -- WITHOUT a paired
    //      QuestionDedup reset, mirroring cli.ts's hookServer-truthy branch
    //      (messageApi.handleStatusChange is gated behind `!hookServer`;
    //      tracker.onStatusChange is not).
    //   3. Status flaps back to 'waiting' with the SAME prompt still on
    //      screen -- it redraws under a FRESH id (#486).
    //   4. QuestionDedup (never reset) suppresses the redraw as a
    //      same-fingerprint re-emission inside its window.
    // Correct outcome: A is still live. Before the #888 review fix, A was
    // wrongly resolved by the status flap alone (V1's onStatusChange
    // trigger) or by the id-only supersession check treating the deduped
    // redraw as confirmed replacement -- either way the user was told
    // "cancelled" while an identical, unanswered prompt sat on the real
    // screen.
    const { sessionRegistry, tracker, sid } = buildPipeline();
    const promptText = 'Allow this agent-team teammate to proceed?';
    const a = hooklessQuestion(promptText);
    tracker.onPTYPromptVisible(a);
    expect(sessionRegistry.getQuestion(sid, a.id)).not.toBeNull();

    // Step 2: false-positive status flap. Deliberately NOT calling
    // messageApi.handleStatusChange -- that is the asymmetry cli.ts has for
    // every session with an active hook server (the common case).
    tracker.onStatusChange('executing');
    // Step 3: flaps back to 'waiting'.
    tracker.onStatusChange('waiting');

    // Step 4: the SAME prompt redraws under a fresh id, same option count
    // (not richer) -- QuestionDedup suppresses it.
    const redraw = hooklessQuestion(promptText);
    expect(redraw.id).not.toBe(a.id);
    tracker.onPTYPromptVisible(redraw);

    // The disqualifying failure would be: neither id live. Assert A
    // specifically survives.
    expect(sessionRegistry.getQuestion(sid, a.id)).not.toBeNull();
    expect(sessionRegistry.getQuestion(sid, redraw.id)).toBeNull(); // the redraw itself never landed (deduped)
    expect(sessionRegistry.getSession(sid)?.currentQuestions.size).toBe(1);
  });

  test('same-text redraw under a fresh id, CONFIRMED delivered (richer re-emission), correctly resolves the original', () => {
    // The positive counterpart: QuestionDedup lets a RICHER re-emission
    // through even within its window. Once genuinely delivered, resolution
    // must still fire -- the guard is confirmed delivery, not text
    // identity.
    const { sessionRegistry, tracker, sid } = buildPipeline();
    const promptText = 'Allow this agent-team teammate to proceed?';
    const a = hooklessQuestion(promptText, 2);
    tracker.onPTYPromptVisible(a);
    expect(sessionRegistry.getQuestion(sid, a.id)).not.toBeNull();

    const richerRedraw = hooklessQuestion(promptText, 4); // more options -> dedup upgrade
    tracker.onPTYPromptVisible(richerRedraw);

    expect(sessionRegistry.getQuestion(sid, a.id)).toBeNull();
    expect(sessionRegistry.getQuestion(sid, richerRedraw.id)).not.toBeNull();
  });

  test('fail-toward-showing: an uncertain (undeliverable) push leaves the original pending, not silently dropped', () => {
    // Sanity check on the underlying store semantics this mechanism relies
    // on: SessionRegistry never removes a question except through an
    // explicit removeQuestion/clearQuestions call. A push that never lands
    // (deduped) cannot have removed anything by itself.
    const { sessionRegistry, tracker, sid } = buildPipeline();
    const a = hooklessQuestion('Same text', 2);
    tracker.onPTYPromptVisible(a);
    const dupe = hooklessQuestion('Same text', 2); // same fingerprint, not richer
    tracker.onPTYPromptVisible(dupe);

    expect(sessionRegistry.getSession(sid)?.currentQuestions.size).toBe(1);
    expect(sessionRegistry.getQuestion(sid, a.id)).not.toBeNull();
  });
});
