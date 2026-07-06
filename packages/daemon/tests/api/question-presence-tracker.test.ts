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

/** Rich PermissionRequest record: tool + command text, real labels (#574). */
function makePermissionRequestHook(text = 'Allow Bash: git push origin main'): Question {
  return { ...makeHookQuestion(text), source: 'permission_request' };
}

/** Generic Notification(permission_prompt) record: bland text, hardcoded 3-set (#574). */
function makeNotificationHook(text = 'Claude needs your permission to use Bash'): Question {
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
    source: 'notification',
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

  it('hook then PTY — pushes once with the hook rich text + options (#497)', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    // Reality: the hook carries the rich tool/command text; the PTY is the bare
    // terminal prompt that confirms the prompt is on screen.
    const hookMeta = makeHookQuestion('Allow Edit: /tmp/foo.ts');
    const ptyQ = makePTYQuestion('Do you want to proceed?');

    tracker.recordPendingHook(hookMeta);
    tracker.onPTYPromptVisible(ptyQ);

    expect(pushes.length).toBe(1);
    // The hook's rich text wins so the user sees the command, not the bare prompt.
    expect(pushes[0]?.text).toBe('Allow Edit: /tmp/foo.ts');
    // PTY id (answer routing) + hook options.
    expect(pushes[0]?.id).toBe(ptyQ.id);
    expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, always', 'No']);
    expect(pushes[0]?.options[0]?.isYes).toBe(true);
    expect(pushes[0]?.options[2]?.isNo).toBe(true);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('falls back to the PTY text when the hook text is empty (#497)', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
    const hookMeta = { ...makeHookQuestion(''), text: '' };
    const ptyQ = makePTYQuestion('Do you want to proceed?');
    tracker.recordPendingHook(hookMeta);
    tracker.onPTYPromptVisible(ptyQ);
    expect(pushes[0]?.text).toBe('Do you want to proceed?');
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

  describe('PermissionRequest vs Notification merge policy (#574)', () => {
    it('a trailing generic Notification does NOT overwrite a rich PermissionRequest for the same agent', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      // Claude fires both for one prompt: the rich request first, the bland
      // notification second. The notification must be dropped.
      tracker.recordPendingHook(makePermissionRequestHook('Allow Bash: git push origin main'));
      tracker.recordPendingHook(makeNotificationHook());

      // PTY confirms the prompt is on screen -> single push with the rich text.
      const ptyQ = makePTYQuestion('Do you want to proceed?');
      tracker.onPTYPromptVisible(ptyQ);

      expect(pushes.length).toBe(1);
      // The user sees the command, not "Claude needs your permission to use Bash"
      // and never the bare PTY "Do you want to proceed?".
      expect(pushes[0]?.text).toBe('Allow Bash: git push origin main');
      expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, always', 'No']);
    });

    it('a source-less (StopFailure-shaped) question does NOT evict a pending permission_request, but a newer permission_request DOES replace it (FIX 2A)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.recordPendingHook(makePermissionRequestHook('Allow Bash: git push'));

      // A StopFailure "Retry?" card for the same agent carries no source; it
      // must NOT silently evict the rich permission request (which would leave
      // the real permission prompt without a push).
      const stopFailureCard: Question = {
        id: generateId(),
        text: 'Session stop failed (timeout). Retry?',
        options: [
          makeOption('Yes', 'y', { isYes: true, isRecommended: true }),
          makeOption('No', 'n', { isNo: true }),
        ],
        allowsFreeText: false,
        isAnswered: false,
        // source intentionally undefined (StopFailure does not set it)
      };
      tracker.recordPendingHook(stopFailureCard);

      tracker.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));
      expect(pushes.length).toBe(1);
      // The permission request survived the StopFailure arrival.
      expect(pushes[0]?.text).toBe('Allow Bash: git push');

      // A genuinely new permission cycle (another permission_request) DOES replace it.
      const tracker2 = new QuestionPresenceTracker(() => {});
      tracker2.recordPendingHook(makePermissionRequestHook('Allow Bash: old cmd'));
      tracker2.recordPendingHook(makePermissionRequestHook('Allow Edit: new cmd'));
      const pushes2: Question[] = [];
      const tracker3 = new QuestionPresenceTracker((q) => pushes2.push(q));
      tracker3.recordPendingHook(makePermissionRequestHook('Allow Bash: old cmd'));
      tracker3.recordPendingHook(makePermissionRequestHook('Allow Edit: new cmd'));
      tracker3.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));
      expect(pushes2[0]?.text).toBe('Allow Edit: new cmd');
    });

    it('a PermissionRequest arriving AFTER a Notification still wins (richer replaces generic)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.recordPendingHook(makeNotificationHook());
      tracker.recordPendingHook(makePermissionRequestHook('Allow Edit: /tmp/foo.ts'));

      tracker.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('Allow Edit: /tmp/foo.ts');
    });

    it('raw PTY text never wins over the hook text for the notification (#574 issue 3)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.recordPendingHook(makePermissionRequestHook('Allow Bash: rm -rf build'));
      // The PTY's literal screen text is the bare prompt; it must not surface.
      tracker.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));

      expect(pushes[0]?.text).toBe('Allow Bash: rm -rf build');
      expect(pushes[0]?.text).not.toBe('Do you want to proceed?');
    });

    it('subagent fallback: a Notification with no preceding PermissionRequest is still recorded', () => {
      // Subagent / no-PermissionRequest escalations must keep a question record
      // so they remain answerable; the drop only applies when a richer request
      // for the SAME agent already exists.
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.recordPendingHook(makeNotificationHook('Claude needs your permission to use Bash'));
      expect(tracker.hasPendingForTest()).toBe(true);

      tracker.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));
      expect(pushes.length).toBe(1);
      expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, always', 'No']);
    });

    it("different agents: a notification for agent B does not touch agent A's request", () => {
      const tracker = new QuestionPresenceTracker(() => {});
      tracker.recordPendingHook({
        ...makePermissionRequestHook('Allow Bash A'),
        agentId: 'agent-A',
      });
      tracker.recordPendingHook({
        ...makeNotificationHook(),
        agentId: 'agent-B',
      });
      // Both kept: the per-agent merge policy only drops a same-agent generic.
      expect(tracker.pendingCountForTest()).toBe(2);
    });
  });

  describe('auto-approve buffer (#484)', () => {
    it('PTY prompt during an eval is BUFFERED, not pushed', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.onAutoApproveStart();
      tracker.onPTYPromptVisible(makePTYQuestion('Allow Bash?'));
      expect(pushes.length).toBe(0); // held until the verdict
    });

    it('escalate verdict releases the buffered prompt once, merged with the hook', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.onAutoApproveStart();
      tracker.onPTYPromptVisible(makePTYQuestion('Allow Bash?'));
      expect(pushes.length).toBe(0);
      // escalate() stashes the hook record first, THEN onEscalate releases.
      tracker.recordPendingHook(makeHookQuestion('Allow Bash?'));
      tracker.onAutoApproveEscalate();
      expect(pushes.length).toBe(1);
      expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, always', 'No']);
    });

    it('auto-approved (no escalate): status-leaves-waiting discards the buffer, never pushes', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.onAutoApproveStart();
      tracker.onPTYPromptVisible(makePTYQuestion('Allow Read?'));
      tracker.onStatusChange('idle'); // injected silently -> agent advanced
      expect(pushes.length).toBe(0);
      // A later prompt (new cycle, eval window closed) pushes normally.
      tracker.onPTYPromptVisible(makePTYQuestion('Different prompt?'));
      expect(pushes.length).toBe(1);
    });

    it('escalate before any PTY prompt -> the next PTY prompt pushes normally', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.onAutoApproveStart();
      tracker.recordPendingHook(makeHookQuestion('Allow Bash?'));
      tracker.onAutoApproveEscalate(); // nothing buffered yet
      expect(pushes.length).toBe(0);
      tracker.onPTYPromptVisible(makePTYQuestion('Allow Bash?'));
      expect(pushes.length).toBe(1);
    });

    it('onAutoApproveHandled discards the buffer and closes the window (#484)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      tracker.onAutoApproveStart();
      tracker.onPTYPromptVisible(makePTYQuestion('Allow Read?'));
      tracker.onAutoApproveHandled(); // auto-approved -> discard, no push
      expect(pushes.length).toBe(0);
      // Window is closed (not stuck): a later prompt pushes normally.
      tracker.onPTYPromptVisible(makePTYQuestion('Next?'));
      expect(pushes.length).toBe(1);
    });
  });

  describe('orphan PTY prompt fallback (#712)', () => {
    // Short real timer (no fake-timer precedent in this suite) — see
    // auto-approve-gate.test.ts's `holdMs: 30` pattern.
    const DEBOUNCE_MS = 20;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('genuine orphan (no live questions, no pending hooks, no eval) pushes after the debounce', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      const ptyQ = makePTYQuestion('Agent-team permission prompt');

      tracker.onOrphanPTYPrompt(ptyQ);
      expect(pushes.length).toBe(0); // debounced, not immediate

      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(1);
      expect(pushes[0]).toBe(ptyQ);
    });

    it('a prompt while the gate has a live registered question does NOT push', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        // Gate already registered (and likely already pushed) a question for
        // this prompt cycle: this is the echo the #625 suppression exists for.
        hasLiveQuestions: () => true,
        orphanDebounceMs: DEBOUNCE_MS,
      });

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(0);
    });

    it('a prompt with a pending hook record does NOT double-push via the orphan path', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      // A hook fired for some agent and the gate has not resolved it yet.
      tracker.recordPendingHook(makeHookQuestion('Allow Bash?'));

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(0);
      // The stashed hook record is untouched by the orphan path.
      expect(tracker.hasPendingForTest()).toBe(true);
    });

    it("status leaving 'waiting' before the debounce fires cancels the push", async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });

      tracker.onOrphanPTYPrompt(makePTYQuestion('Agent-team permission prompt'));
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(true);

      tracker.onStatusChange('executing'); // the prompt is gone from screen
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(false);

      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(0);
    });

    it('clearPending cancels the armed orphan timer', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });

      tracker.onOrphanPTYPrompt(makePTYQuestion('Agent-team permission prompt'));
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(true);

      tracker.clearPending();
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(false);

      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(0);
    });

    it('autoApproveInFlight still buffers the orphan prompt; escalate releases it (#484 semantics unchanged)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });

      tracker.onAutoApproveStart();
      tracker.onOrphanPTYPrompt(makePTYQuestion('Allow Bash?'));
      expect(pushes.length).toBe(0);
      // Buffered like onPTYPromptVisible, not routed through the debounce.
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(false);

      tracker.recordPendingHook(makeHookQuestion('Allow Bash?'));
      tracker.onAutoApproveEscalate();

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Yes, always', 'No']);
    });

    it('a second orphan before the timer fires replaces the first — only the latest pushes, once', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });

      tracker.onOrphanPTYPrompt(makePTYQuestion('first orphan'));
      tracker.onOrphanPTYPrompt(makePTYQuestion('second orphan'));

      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('second orphan');
    });

    it('re-checks ownership at debounce fire: a live question registered mid-window suppresses the push', async () => {
      const pushes: Question[] = [];
      let live = false;
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => live,
        orphanDebounceMs: DEBOUNCE_MS,
      });

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      live = true; // the gate registered a question for this cycle mid-debounce

      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(0);
    });
  });
});
