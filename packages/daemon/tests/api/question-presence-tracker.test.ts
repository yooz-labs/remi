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

  describe('fallback options do not overwrite PTY truth (#718)', () => {
    it('a fallback hook record loses its options to a concrete PTY option set (hook text still wins)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      const fallbackHook: Question = {
        ...makePermissionRequestHook('Allow Bash: git push'),
        options: [
          makeOption('Yes', '1', { isYes: true, isRecommended: true }),
          makeOption('No', '2', { isNo: true }),
        ],
        optionsAreFallback: true,
      };
      tracker.recordPendingHook(fallbackHook);

      // The PTY parsed the ACTUAL rendered prompt: a real 2-option Yes/No
      // with its own labels (e.g. Claude's real wording), not the hook's bare
      // substitute.
      const ptyQ: Question = {
        ...makePTYQuestion('Do you want to proceed?'),
        options: [
          makeOption('Yes, and add to allowlist', 'y', { isYes: true }),
          makeOption('No, ask every time', 'n', { isNo: true }),
        ],
      };
      tracker.onPTYPromptVisible(ptyQ);

      expect(pushes.length).toBe(1);
      // Text still comes from the hook (tool + command context, #497).
      expect(pushes[0]?.text).toBe('Allow Bash: git push');
      // But the OPTIONS are the PTY's real ones, not the hook's fallback.
      expect(pushes[0]?.options.map((o) => o.label)).toEqual([
        'Yes, and add to allowlist',
        'No, ask every time',
      ]);
      // The merged question's own flag must describe what actually won: the
      // PTY's options, which are concrete (#718 review).
      expect(pushes[0]?.optionsAreFallback).toBe(false);
    });

    it('overrides a stale optionsAreFallback the PTY question itself happened to carry', () => {
      // The PTY base is spread first (`...ptyQuestion`), so its OWN
      // optionsAreFallback must not leak through when the hook's options win
      // (#718 review) — the merged flag must reflect the hook record, not
      // whatever the PTY parser separately decided about ITS OWN options.
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      const structuredHook: Question = {
        ...makePermissionRequestHook('Allow Bash: rm -rf /tmp/foo'),
        options: [
          makeOption('Yes', '1', { isYes: true, isRecommended: true }),
          makeOption('Yes, always allow: rm -rf /tmp/foo', '2', {
            isYes: true,
            suggestionIndex: 0,
          }),
          makeOption('No', '3', { isNo: true }),
        ],
        // Real derived set: no optionsAreFallback flag.
      };
      tracker.recordPendingHook(structuredHook);

      const ptyQ: Question = {
        ...makePTYQuestion('Do you want to proceed?'),
        optionsAreFallback: false,
      };
      tracker.onPTYPromptVisible(ptyQ);

      expect(pushes[0]?.options.map((o) => o.label)).toEqual([
        'Yes',
        'Yes, always allow: rm -rf /tmp/foo',
        'No',
      ]);
      // The hook's options won and the hook record has no fallback flag, so
      // the merged question must not carry `false` (or any stale value)
      // leaked from the PTY base.
      expect(pushes[0]?.optionsAreFallback).toBeUndefined();
    });

    it('a suggestion-derived (non-fallback) hook record still wins over the PTY options', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      const structuredHook: Question = {
        ...makePermissionRequestHook('Allow Bash: rm -rf /tmp/foo'),
        options: [
          makeOption('Yes', '1', { isYes: true, isRecommended: true }),
          makeOption('Yes, always allow: rm -rf /tmp/foo', '2', {
            isYes: true,
            suggestionIndex: 0,
          }),
          makeOption('No', '3', { isNo: true }),
        ],
        // optionsAreFallback intentionally absent: this is a real derived set.
      };
      tracker.recordPendingHook(structuredHook);

      const ptyQ = makePTYQuestion('Do you want to proceed?');
      tracker.onPTYPromptVisible(ptyQ);

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.options.map((o) => o.label)).toEqual([
        'Yes',
        'Yes, always allow: rm -rf /tmp/foo',
        'No',
      ]);
      expect(pushes[0]?.options[1]?.suggestionIndex).toBe(0);
      expect(pushes[0]?.optionsAreFallback).toBeUndefined();
    });

    it('a fallback hook record keeps its own options when the PTY question has none', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q));
      const fallbackHook: Question = {
        ...makePermissionRequestHook('Allow Bash: git push'),
        options: [
          makeOption('Yes', '1', { isYes: true, isRecommended: true }),
          makeOption('No', '2', { isNo: true }),
        ],
        optionsAreFallback: true,
      };
      tracker.recordPendingHook(fallbackHook);

      const ptyQ: Question = { ...makePTYQuestion('Do you want to proceed?'), options: [] };
      tracker.onPTYPromptVisible(ptyQ);

      // No PTY options to prefer: the hook's fallback is still better than nothing.
      expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
      // The hook's own options won (no PTY options to prefer), so the merged
      // flag mirrors the hook record's fallback flag.
      expect(pushes[0]?.optionsAreFallback).toBe(true);
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

    it('a SAME-AGENT pending hook record does NOT double-push via the orphan path', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      // A hook fired for the main agent (no agentId -> MAIN_AGENT_ID key,
      // same as the PTY question below) and the gate has not resolved it yet.
      tracker.recordPendingHook(makeHookQuestion('Allow Bash?'));

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(0);
      // The stashed hook record is untouched by the orphan path.
      expect(tracker.hasPendingForTest()).toBe(true);
    });

    it('a DIFFERENT-agent pending hook record does NOT suppress an orphan prompt (scoped ownership)', async () => {
      // A background subagent's PermissionRequest is still mid-flight
      // (agent-X) while an unrelated main-screen orphan prompt (e.g. a
      // native agent-team permission, no hook at all) renders. The
      // subagent's in-flight record must not swallow the main orphan for
      // the whole window it's pending — that's the exact class of
      // notification loss #712 exists to fix.
      //
      // Note: the debounce fire routes through the same onPTYPromptVisible
      // merge/push path a non-orphan prompt uses (per spec), so with exactly
      // one OTHER pending record its pre-existing sole-candidate heuristic
      // (#483) may still attach agent-X's labels — a separate, pre-existing
      // cross-agent attribution question this test does not assert on.
      // What matters here is that the push fires at all.
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.recordPendingHook({ ...makeHookQuestion('Allow Bash?'), agentId: 'agent-X' });

      // No agentId -> keyed to MAIN_AGENT_ID, distinct from 'agent-X'.
      tracker.onOrphanPTYPrompt(makePTYQuestion('Agent-team permission prompt'));
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(1);
    });

    it('2+ different-agent pending records do NOT suppress an orphan prompt — pushes bare (#425/#483)', async () => {
      // With 2+ unrelated pending agents, onPTYPromptVisible's existing
      // anti-guessing rule pushes the bare PTY question (no merge) and
      // drops the ambiguous records, so this case has no attribution
      // ambiguity: a clean demonstration that scoped ownership lets the
      // orphan through untouched by other agents' in-flight hooks.
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.recordPendingHook({ ...makeHookQuestion('Allow Bash A?'), agentId: 'agent-A' });
      tracker.recordPendingHook({ ...makeHookQuestion('Allow Edit B?'), agentId: 'agent-B' });

      const ptyQ = makePTYQuestion('Agent-team permission prompt');
      tracker.onOrphanPTYPrompt(ptyQ);
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(1);
      expect(pushes[0]).toBe(ptyQ); // bare, not merged with either agent's hook
      expect(tracker.hasPendingForTest()).toBe(false);
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

    it('hasLiveQuestions() throwing is caught and treated as no live questions (fail-open)', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => {
          throw new Error('sessionRegistry lookup blew up');
        },
        orphanDebounceMs: DEBOUNCE_MS,
      });

      // Must not throw synchronously out of onOrphanPTYPrompt, and must not
      // get stuck suppressed forever — a possibly-redundant push beats a
      // crash or a silently swallowed genuine orphan.
      expect(() =>
        tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?')),
      ).not.toThrow();
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(1);
    });
  });

  describe('awaiting-PTY parking (#751)', () => {
    const DEBOUNCE_MS = 20;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('a parked record + rendered prompt pushes IMMEDIATELY, merged, no debounce', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.parkAwaitingPTY(makePermissionRequestHook('reviewer · Bash: git push'));
      expect(tracker.awaitingPTYCountForTest()).toBe(1);

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));

      // Hook + render is positive double-confirmation: no orphan debounce.
      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('reviewer · Bash: git push'); // merged rich label
      expect(tracker.hasPendingForTest()).toBe(false); // record consumed
      expect(tracker.awaitingPTYCountForTest()).toBe(0);
    });

    it('an unrelated LIVE question does not suppress a parked prompt (bypasses gate-owned check)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => true, // e.g. a held main card is open
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.parkAwaitingPTY({
        ...makePermissionRequestHook('agent · Edit: config.toml'),
        agentId: 'agent-1',
      });

      // The PTY prompt does not name the agent: sole-candidate pairing applies.
      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to make this edit?'));

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('agent · Edit: config.toml');
    });

    it("#763: a fresh parked record SURVIVES another agent's status churn and still merges on render", () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.parkAwaitingPTY({
        ...makePermissionRequestHook('agent · Bash: ls'),
        agentId: 'agent-A',
      });

      // Main / teammate hook activity flips status constantly in team runs;
      // that must NOT wipe A's still-live parked record.
      tracker.onStatusChange('executing');
      tracker.onStatusChange('thinking');
      expect(tracker.awaitingPTYCountForTest()).toBe(1);

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('agent · Bash: ls'); // merged, not bare
    });

    it("#763: noteAgentAdvanced expires exactly that agent's parked record (allowlist absorbed)", async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.parkAwaitingPTY({
        ...makePermissionRequestHook('A · Bash: ls'),
        agentId: 'agent-A',
      });
      tracker.parkAwaitingPTY({
        ...makePermissionRequestHook('B · Edit: x.md'),
        agentId: 'agent-B',
      });

      tracker.noteAgentAdvanced('agent-A'); // A's PreToolUse: permission resolved silently
      tracker.noteAgentAdvanced(undefined); // main-tagged: no-op
      expect(tracker.awaitingPTYCountForTest()).toBe(1);

      // B's prompt renders and still pairs by exact key.
      tracker.onOrphanPTYPrompt({ ...makePTYQuestion('proceed?'), agentId: 'agent-B' });
      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('B · Edit: x.md');
      // A later unnamed prompt is a plain orphan again (A's record is gone).
      tracker.onOrphanPTYPrompt(makePTYQuestion('unrelated later prompt'));
      expect(pushes.length).toBe(1);
      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(2);
      expect(pushes[1]?.text).toBe('unrelated later prompt');
    });

    it('#763: a parked record past the TTL is dropped by the next status change', () => {
      let now = 1_000_000;
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
        nowMs: () => now,
      });
      tracker.parkAwaitingPTY(makePermissionRequestHook('agent · Bash: ls'));

      now += 119_000;
      tracker.onStatusChange('executing');
      expect(tracker.awaitingPTYCountForTest()).toBe(1); // inside TTL: spared

      now += 2_000; // 121s parked: past the 120s TTL
      tracker.onStatusChange('executing');
      expect(tracker.awaitingPTYCountForTest()).toBe(0);
      expect(tracker.hasPendingForTest()).toBe(false);
    });

    it("#763: NORMAL pending records still clear when status leaves 'waiting'", () => {
      const tracker = new QuestionPresenceTracker(() => {}, {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.recordPendingHook(makeHookQuestion('Allow Bash?')); // not parked
      tracker.parkAwaitingPTY({
        ...makePermissionRequestHook('agent · Bash: ls'),
        agentId: 'agent-A',
      });

      tracker.onStatusChange('executing');

      expect(tracker.pendingCountForTest()).toBe(1); // only the parked one survives
      expect(tracker.awaitingPTYCountForTest()).toBe(1);
    });

    it('#763: clearPending (restart/rotation) still wipes parked records', () => {
      const tracker = new QuestionPresenceTracker(() => {}, {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.parkAwaitingPTY(makePermissionRequestHook('agent · Bash: ls'));
      tracker.clearPending();
      expect(tracker.awaitingPTYCountForTest()).toBe(0);
      expect(tracker.hasPendingForTest()).toBe(false);
    });

    it('a NORMAL pending record for the prompt agent still suppresses (echo protection intact)', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      // A normal gate escalation is mid-flight for main; a parked record
      // exists for a different agent. The unnamed PTY prompt matches main's
      // normal record -> gate-owned -> suppressed (not stolen by the parked one).
      tracker.recordPendingHook(makeHookQuestion('Allow Bash?'));
      tracker.parkAwaitingPTY({
        ...makePermissionRequestHook('agent · Write: notes.md'),
        agentId: 'agent-1',
      });

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(0);
    });

    it('a normal recordPendingHook for the same agent clears the parked flag', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => pushes.push(q), {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      });
      tracker.parkAwaitingPTY(makePermissionRequestHook('agent · Bash: ls'));
      // A real gate escalation for the same agent takes over the prompt cycle.
      tracker.recordPendingHook(makePermissionRequestHook('Allow Bash: ls'));
      expect(tracker.awaitingPTYCountForTest()).toBe(0);

      // Its render echo is suppressed like any gate-owned cycle.
      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(0);
    });
  });
});
