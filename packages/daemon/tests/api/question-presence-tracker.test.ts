import { describe, expect, it } from 'bun:test';
import type { Question, QuestionOption } from '@remi/shared';
import { generateId } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { extractToolQuestion } from '../../src/hooks/tool-question.ts';
import { parseQuestion } from '../../src/parser/question-parser.ts';

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
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });
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
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });
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
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });
    const hook = { ...makeHookQuestion('Allow Bash?'), agentId: 'subagent-A' };
    tracker.recordPendingHook(hook);
    const ptyQ = makePTYQuestion('Allow Bash?'); // no agentId, but only one candidate
    tracker.onPTYPromptVisible(ptyQ);
    expect(pushes.length).toBe(1);
    // Paired: the hook's identity and agent, the screen's options (#1134).
    expect(pushes[0]?.id).toBe(hook.id);
    expect(pushes[0]?.agentId).toBe('subagent-A');
    expect(pushes[0]?.options.map((o) => o.label)).toEqual(['1', '2', '3']);
  });

  it("hook then PTY — pushes once with the hook rich text and the screen's options (#497, #1134)", () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });
    // Reality: the hook carries the rich tool/command text; the PTY is the bare
    // terminal prompt that confirms the prompt is on screen.
    const hookMeta = makeHookQuestion('Allow Edit: /tmp/foo.ts');
    const ptyQ = makePTYQuestion('Do you want to proceed?');

    tracker.recordPendingHook(hookMeta);
    tracker.onPTYPromptVisible(ptyQ);

    expect(pushes.length).toBe(1);
    // The hook's rich text wins so the user sees the command, not the bare prompt.
    expect(pushes[0]?.text).toBe('Allow Edit: /tmp/foo.ts');
    // #887: identity is minted ONCE, at hook arrival — the merge ADOPTS the
    // hook's id instead of the PTY's freshly-parsed one (which is discarded
    // once a hook record exists to pair with).
    expect(pushes[0]?.id).toBe(hookMeta.id);
    expect(pushes[0]?.id).not.toBe(ptyQ.id);
    // #1134: the card is answered by typing its option value into the PTY, so
    // it carries the screen's numbering, never the hook's.
    expect(pushes[0]?.options).toEqual(ptyQ.options);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('falls back to the PTY text when the hook text is empty (#497)', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });
    const hookMeta = { ...makeHookQuestion(''), text: '' };
    const ptyQ = makePTYQuestion('Do you want to proceed?');
    tracker.recordPendingHook(hookMeta);
    tracker.onPTYPromptVisible(ptyQ);
    expect(pushes[0]?.text).toBe('Do you want to proceed?');
  });

  it('hook only — no push until PTY confirms or status clears', () => {
    // The hook fired but the prompt has not rendered on screen yet. No
    // push must fire yet.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });

    tracker.recordPendingHook(makeHookQuestion('Bash'));

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingForTest()).toBe(true);
  });

  it('hook then status transitions to executing — pending dropped, no push', () => {
    // The prompt was answered in the terminal (or Claude's own rules
    // allowed the call) and Claude resumed → status changes to 'executing'.
    // The prompt the hook described is gone from screen; the iOS user must
    // not be poked for a prompt that no longer exists.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });

    tracker.recordPendingHook(makeHookQuestion('Bash'));
    tracker.onStatusChange('executing');

    expect(pushes.length).toBe(0);
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('hook then status transitions to thinking — pending dropped, no push', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });

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
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });

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
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });
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
    expect(pushes[0]?.id).toBe(secondHook.id);
    expect(pushes[0]?.text).toBe('Allow Edit?');
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  it('PTY visible, status clears, then a second PTY visible — both push', () => {
    // Sequential prompts: first prompt rendered, user answered (status
    // moved on), second prompt rendered later. The tracker must push
    // both; clearing pending state on status change does not block the
    // next PTY emission.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });

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
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });
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
    // Used on a transcript rotation (hook-bridge-setup's `onRotation`):
    // Claude moved on without a status transition we can observe. Without
    // clearPending, the pending hook would merge stale option labels onto
    // the next unrelated prompt.
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker((q) => {
      pushes.push(q);
      return undefined;
    });

    tracker.recordPendingHook(makeHookQuestion('Edit'));
    expect(tracker.hasPendingForTest()).toBe(true);

    tracker.clearPending();

    expect(tracker.hasPendingForTest()).toBe(false);
    expect(pushes.length).toBe(0);
  });

  it('clearPending — also resets the on-screen state so a stale answer cannot be typed', () => {
    // A rotation (/clear, /resume) calls clearPending. Without resetting the
    // on-screen state, an answer for the dying session's prompt would still
    // pass the #920 prompt-currency guard and be typed into the new one.
    const tracker = new QuestionPresenceTracker(() => undefined);
    const ptyQ = makePTYQuestion();
    tracker.onPTYPromptVisible(ptyQ);
    expect(tracker.isPromptCurrent(ptyQ.id, ptyQ.text)).toBe(true);
    expect(tracker.isPromptObservedOnPTY()).toBe(true);

    tracker.clearPending();

    expect(tracker.isPromptCurrent(ptyQ.id, ptyQ.text)).toBe(false);
    expect(tracker.isPromptObservedOnPTY()).toBe(false);
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

  describe('isPromptCurrent (#814, #920): is THIS prompt still on screen?', () => {
    it('starts false before any PTY confirmation', () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      expect(tracker.isPromptCurrent('nothing-yet')).toBe(false);
    });

    it('stays false when only a hook has recorded — PTY has not confirmed yet', () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      const hook = makeHookQuestion('Bash');
      tracker.recordPendingHook(hook);
      expect(tracker.isPromptCurrent(hook.id, hook.text)).toBe(false);
    });

    it('flips to true once PTY confirms the prompt is on screen', () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      const ptyQ = makePTYQuestion();
      tracker.onPTYPromptVisible(ptyQ);
      expect(tracker.isPromptCurrent(ptyQ.id)).toBe(true);
    });

    it('a redraw under a fresh id still matches by text', () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      const ptyQ = makePTYQuestion('Do you want to proceed?');
      tracker.onPTYPromptVisible(ptyQ);
      expect(tracker.isPromptCurrent('some-other-id', 'Do you want to proceed?')).toBe(true);
      expect(tracker.isPromptCurrent('some-other-id', 'A different prompt')).toBe(false);
    });

    it('flips back to false when status leaves waiting (prompt consumed)', () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      const ptyQ = makePTYQuestion();
      tracker.onPTYPromptVisible(ptyQ);
      tracker.onStatusChange('executing');
      expect(tracker.isPromptCurrent(ptyQ.id)).toBe(false);
    });

    it("stays true while status stays 'waiting'", () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      const ptyQ = makePTYQuestion();
      tracker.onPTYPromptVisible(ptyQ);
      tracker.onStatusChange('waiting');
      expect(tracker.isPromptCurrent(ptyQ.id)).toBe(true);
    });

    it('also flips false on transition to thinking or idle', () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      const first = makePTYQuestion();
      tracker.onPTYPromptVisible(first);
      tracker.onStatusChange('thinking');
      expect(tracker.isPromptCurrent(first.id)).toBe(false);

      const second = makePTYQuestion();
      tracker.onPTYPromptVisible(second);
      tracker.onStatusChange('idle');
      expect(tracker.isPromptCurrent(second.id)).toBe(false);
    });
  });

  describe('PermissionRequest vs Notification merge policy (#574)', () => {
    it('a trailing generic Notification does NOT overwrite a rich PermissionRequest for the same agent', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
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
      // Options are the screen's whichever hook record pairs (#1134).
      expect(pushes[0]?.options).toEqual(ptyQ.options);
    });

    it('a source-less (StopFailure-shaped) question does NOT evict a pending permission_request, but a newer permission_request DOES replace it (FIX 2A)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
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
      const tracker2 = new QuestionPresenceTracker(() => undefined);
      tracker2.recordPendingHook(makePermissionRequestHook('Allow Bash: old cmd'));
      tracker2.recordPendingHook(makePermissionRequestHook('Allow Edit: new cmd'));
      const pushes2: Question[] = [];
      const tracker3 = new QuestionPresenceTracker((q) => {
        pushes2.push(q);
        return undefined;
      });
      tracker3.recordPendingHook(makePermissionRequestHook('Allow Bash: old cmd'));
      tracker3.recordPendingHook(makePermissionRequestHook('Allow Edit: new cmd'));
      tracker3.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));
      expect(pushes2[0]?.text).toBe('Allow Edit: new cmd');
    });

    it('a PermissionRequest arriving AFTER a Notification still wins (richer replaces generic)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
      tracker.recordPendingHook(makeNotificationHook());
      tracker.recordPendingHook(makePermissionRequestHook('Allow Edit: /tmp/foo.ts'));

      tracker.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('Allow Edit: /tmp/foo.ts');
    });

    it('raw PTY text never wins over the hook text for the notification (#574 issue 3)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
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
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
      tracker.recordPendingHook(makeNotificationHook('Claude needs your permission to use Bash'));
      expect(tracker.hasPendingForTest()).toBe(true);

      tracker.onPTYPromptVisible(makePTYQuestion('Do you want to proceed?'));
      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('Claude needs your permission to use Bash');
    });

    it("different agents: a notification for agent B does not touch agent A's request", () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
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

  describe("merged options are the screen's (#1134, replacing #718's fallback-only rule)", () => {
    it('a fallback hook record loses its options to a concrete PTY option set (hook text still wins)', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
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

    it('does not leak a stale optionsAreFallback the PTY question itself happened to carry', () => {
      // The PTY base is spread first (`...ptyQuestion`), so its OWN
      // optionsAreFallback must not leak through (#718 review): the merged
      // flag describes the options that won, and the screen's are concrete.
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
      tracker.recordPendingHook(makePermissionRequestHook('Allow Bash: rm -rf /tmp/foo'));

      const ptyQ: Question = {
        ...makePTYQuestion('Do you want to proceed?'),
        optionsAreFallback: true,
      };
      tracker.onPTYPromptVisible(ptyQ);

      expect(pushes[0]?.options).toEqual(ptyQ.options);
      expect(pushes[0]?.optionsAreFallback).toBe(false);
    });

    it('a suggestion-derived hook record gives way to the screen: the live 4-over-3 mismatch', () => {
      // The live failure (#1134): `addDirectories` + `setMode` suggestions
      // built a 4-option card, Claude's dialog showed 3, and the pre-#1134
      // merge kept the hook's set because it was not the fallback. The
      // phone's "No" was value 4, which the dialog does not have.
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
      const structuredHook: Question = {
        ...makePermissionRequestHook('Allow Bash: touch e5-marker.txt'),
        options: [
          makeOption('Yes', '1', { isYes: true, isRecommended: true }),
          makeOption('Yes, allow directory /work', '2', { isYes: true, suggestionIndex: 0 }),
          makeOption('Yes, switch to acceptEdits mode', '3', { isYes: true, suggestionIndex: 1 }),
          makeOption('No', '4', { isNo: true }),
        ],
        // optionsAreFallback intentionally absent: this is a real derived set.
      };
      tracker.recordPendingHook(structuredHook);

      const ptyQ: Question = {
        ...makePTYQuestion('Do you want to proceed?'),
        options: [
          makeOption('Yes', '1', { isRecommended: true }),
          makeOption('Yes, and always allow access to /work from this project', '2'),
          makeOption('No', '3'),
        ],
      };
      tracker.onPTYPromptVisible(ptyQ);

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.id).toBe(structuredHook.id);
      expect(pushes[0]?.text).toBe('Allow Bash: touch e5-marker.txt');
      // The screen's labels and values; yes/no flags derived from the labels.
      expect(pushes[0]?.options.map((o) => [o.value, o.label])).toEqual(
        ptyQ.options.map((o) => [o.value, o.label]),
      );
      expect(pushes[0]?.options.map((o) => [o.isYes, o.isNo])).toEqual([
        [true, false],
        [true, false],
        [false, true],
      ]);
      // No hook-only artifacts survive: nothing to echo, no value 4.
      expect(pushes[0]?.options.some((o) => o.suggestionIndex !== undefined)).toBe(false);
      expect(pushes[0]?.options.map((o) => o.value)).toEqual(['1', '2', '3']);
      expect(pushes[0]?.optionsAreFallback).toBe(false);
    });

    it('derives yes/no flags from the screen labels, conservatively', () => {
      // The parser reads a numbered menu as bare picks (no flags); the merge
      // restores the meaning from the label, counting only a label that
      // starts with the exact word "Yes" or "No".
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
      tracker.recordPendingHook(makePermissionRequestHook('Allow Bash: ls'));
      const labels = [
        'Yes',
        "Yes, and don't ask again for this command",
        'Yes,andalwaysallowaccessto/w',
        'No, and tell Claude what to do differently (esc)',
        "Yesterday's build",
        'None of these',
        'yes',
        'Nope',
      ];
      tracker.onPTYPromptVisible({
        ...makePTYQuestion('Do you want to proceed?'),
        options: labels.map((l, i) => makeOption(l, String(i + 1))),
      });

      expect(pushes[0]?.options.map((o) => [o.label, o.isYes, o.isNo])).toEqual([
        ['Yes', true, false],
        ["Yes, and don't ask again for this command", true, false],
        ['Yes,andalwaysallowaccessto/w', true, false],
        ['No, and tell Claude what to do differently (esc)', false, true],
        ["Yesterday's build", false, false],
        ['None of these', false, false],
        ['yes', false, false],
        ['Nope', false, false],
      ]);
    });

    it('an AskUserQuestion record pairs with its parsed menu: structure from the hook, numbering from the screen', () => {
      // A parked subagent AskUserQuestion merges on its render. The runner
      // answers from the hook's `questions`; a plain pick is typed by the
      // screen's numbering, which includes the "Type something." row.
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
      const tool = extractToolQuestion('AskUserQuestion', {
        questions: [
          {
            question: 'Which database?',
            header: 'DB',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Relational' },
              { label: 'SQLite', description: 'Embedded' },
            ],
          },
        ],
      });
      if (!tool) throw new Error('not an AskUserQuestion shape');
      const hook: Question = {
        id: generateId(),
        text: tool.text,
        options: tool.options,
        allowsFreeText: false,
        isAnswered: false,
        source: 'permission_request',
        agentId: 'sub-auq',
        ...(tool.kind ? { kind: tool.kind } : {}),
        ...(tool.questions ? { questions: tool.questions } : {}),
      };
      tracker.recordPendingHook(hook);
      const screen = parseQuestion(
        [
          ' Which database?',
          ' ❯ 1. Postgres',
          '      Relational',
          '   2. SQLite',
          '      Embedded',
          '   3. Type something.',
          ' Enter to select · ↑/↓ to navigate · Esc to cancel',
        ].join('\n'),
      ).question;
      if (!screen) throw new Error('the menu did not parse');

      tracker.onPTYPromptVisible(screen);

      expect(pushes).toHaveLength(1);
      expect(pushes[0]?.id).toBe(hook.id);
      expect(pushes[0]?.agentId).toBe('sub-auq');
      expect(pushes[0]?.kind).toBe('multi_question');
      expect(pushes[0]?.questions).toEqual(tool.questions);
      expect(pushes[0]?.options.map((o) => [o.value, o.label])).toEqual([
        ['1', 'Postgres Relational'],
        ['2', 'SQLite Embedded'],
        ['3', 'Type something.'],
      ]);
      expect(pushes[0]?.allowsFreeText).toBe(false);
    });

    it('a hook record keeps its own options only when the PTY question has none', () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker((q) => {
        pushes.push(q);
        return undefined;
      });
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

      // No PTY options to take: the hook's are kept. The answer path still
      // refuses to type any of them, because the screen shows no such value.
      expect(pushes[0]?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
      // The hook's own options were kept, so the merged flag mirrors the hook
      // record's fallback flag.
      expect(pushes[0]?.optionsAreFallback).toBe(true);
    });
  });

  describe('orphan PTY prompt fallback (#712)', () => {
    // Short real timer (no fake-timer precedent in this suite).
    const DEBOUNCE_MS = 20;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('genuine orphan (no live questions, no pending hooks) pushes after the debounce', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
      const ptyQ = makePTYQuestion('Agent-team permission prompt');

      tracker.onOrphanPTYPrompt(ptyQ);
      expect(pushes.length).toBe(0); // debounced, not immediate

      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(1);
      expect(pushes[0]).toBe(ptyQ);
    });

    it('a prompt while the gate has a live registered question does NOT push', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          // Gate already registered (and likely already pushed) a question for
          // this prompt cycle: this is the echo the #625 suppression exists for.
          hasLiveQuestions: () => true,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(0);
    });

    it('a SAME-AGENT pending hook record does NOT double-push via the orphan path', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );

      tracker.onOrphanPTYPrompt(makePTYQuestion('Agent-team permission prompt'));
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(true);

      tracker.onStatusChange('executing'); // the prompt is gone from screen
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(false);

      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(0);
    });

    it('clearPending cancels the armed orphan timer', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );

      tracker.onOrphanPTYPrompt(makePTYQuestion('Agent-team permission prompt'));
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(true);

      tracker.clearPending();
      expect(tracker.hasArmedOrphanTimerForTest()).toBe(false);

      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(0);
    });

    it('a second orphan before the timer fires replaces the first — only the latest pushes, once', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );

      tracker.onOrphanPTYPrompt(makePTYQuestion('first orphan'));
      tracker.onOrphanPTYPrompt(makePTYQuestion('second orphan'));

      await wait(DEBOUNCE_MS * 2);

      expect(pushes.length).toBe(1);
      expect(pushes[0]?.text).toBe('second orphan');
    });

    it('re-checks ownership at debounce fire: a live question registered mid-window suppresses the push', async () => {
      const pushes: Question[] = [];
      let live = false;
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => live,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );

      tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
      live = true; // the gate registered a question for this cycle mid-debounce

      await wait(DEBOUNCE_MS * 2);
      expect(pushes.length).toBe(0);
    });

    it('hasLiveQuestions() throwing is caught and treated as no live questions (fail-open)', async () => {
      const pushes: Question[] = [];
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => {
            throw new Error('sessionRegistry lookup blew up');
          },
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );

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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => true, // e.g. a held main card is open
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
          nowMs: () => now,
        },
      );
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
      const tracker = new QuestionPresenceTracker(() => undefined, {
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
      const tracker = new QuestionPresenceTracker(() => undefined, {
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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
      const tracker = new QuestionPresenceTracker(
        (q) => {
          pushes.push(q);
          return undefined;
        },
        {
          hasLiveQuestions: () => false,
          orphanDebounceMs: DEBOUNCE_MS,
        },
      );
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

// #1125: the parked-render arbiter (#814) was deleted with the auto-approve
// evaluator, so a parked render always pushes straight through.
describe('parked render push', () => {
  const DEBOUNCE_MS = 20;

  it('a parked subagent render pushes SYNCHRONOUSLY, merged with its hook record', () => {
    const pushes: Question[] = [];
    const tracker = new QuestionPresenceTracker(
      (q) => {
        pushes.push(q);
        return undefined;
      },
      {
        hasLiveQuestions: () => false,
        orphanDebounceMs: DEBOUNCE_MS,
      },
    );
    tracker.parkAwaitingPTY(makePermissionRequestHook('reviewer · Bash: git push'));

    tracker.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.text).toBe('reviewer · Bash: git push');
  });
});

// #1126: hook-backed prompts are never rebuilt from the screen into a card
// the phone would answer by typing.
describe('hook-backed renders (#1126)', () => {
  const DEBOUNCE = 5;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function tracker() {
    const pushes: Question[] = [];
    const t = new QuestionPresenceTracker(
      (q) => {
        pushes.push(q);
        return { status: 'registered' as const };
      },
      { hasLiveQuestions: () => false, orphanDebounceMs: DEBOUNCE },
    );
    return { t, pushes };
  }

  it('while the probe reports an open hook-backed prompt, a render is not an orphan', async () => {
    const { t, pushes } = tracker();
    let open = true;
    t.setHookPromptProbe(() => open);
    t.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
    await wait(DEBOUNCE * 4);
    expect(pushes).toHaveLength(0);
    // Still observed, so the answer guards know a prompt is on screen.
    expect(t.isPromptObservedOnPTY()).toBe(true);

    // Nothing hook-backed open: a hook-less prompt takes the orphan path.
    open = false;
    t.onOrphanPTYPrompt(makePTYQuestion('Allow network access?'));
    await wait(DEBOUNCE * 4);
    expect(pushes).toHaveLength(1);
  });

  it('with no probe installed (no hook server) nothing changes', async () => {
    const { t, pushes } = tracker();
    t.onOrphanPTYPrompt(makePTYQuestion('Allow network access?'));
    await wait(DEBOUNCE * 4);
    expect(pushes).toHaveLength(1);
  });

  it("a parked render with onRender hands over the merged question under the hook's id, and pushes no card", () => {
    const { t, pushes } = tracker();
    const noticed: Question[] = [];
    const hook = makePermissionRequestHook('reviewer · Bash: git push');
    t.parkAwaitingPTY(hook, { onRender: (q) => noticed.push(q) });
    t.onOrphanPTYPrompt(makePTYQuestion('Do you want to proceed?'));
    expect(pushes).toHaveLength(0);
    expect(noticed.map((q) => [q.id, q.text])).toEqual([[hook.id, 'reviewer · Bash: git push']]);
    expect(t.awaitingPTYCountForTest()).toBe(0);
    expect(t.observedRenderOwnedQuestionForTest()).toBeNull();
  });

  it('a throwing onRender is absorbed', () => {
    const { t } = tracker();
    t.parkAwaitingPTY(makePermissionRequestHook(), {
      onRender: () => {
        throw new Error('test: notice failed');
      },
    });
    expect(() => t.onOrphanPTYPrompt(makePTYQuestion())).not.toThrow();
  });
});

describe('observed prompt options (#1134)', () => {
  function screenWith(values: string[], text = 'Do you want to proceed?'): Question {
    return {
      ...makePTYQuestion(text),
      options: values.map((v) => makeOption(`Option ${v}`, v)),
    };
  }

  it('is null before anything renders', () => {
    const t = new QuestionPresenceTracker(() => undefined);
    expect(t.observedPromptOptions()).toBeNull();
  });

  it('retains the options of a render seen by onPTYPromptVisible', () => {
    const t = new QuestionPresenceTracker(() => undefined);
    const screen = screenWith(['1', '2', '3']);
    t.onPTYPromptVisible(screen);
    expect(t.observedPromptOptions()).toEqual(screen.options);
  });

  it("retains the screen's options for a gate-owned echo, not the hook's", () => {
    // The render is suppressed as an echo of the stashed hook record, but the
    // observation is recorded before that decision, and it is the screen's.
    const t = new QuestionPresenceTracker(() => undefined);
    t.recordPendingHook(makePermissionRequestHook('Allow Bash: ls'));
    const screen = screenWith(['1', '2']);
    t.onOrphanPTYPrompt(screen);
    expect(t.observedPromptOptions()?.map((o) => o.value)).toEqual(['1', '2']);
  });

  it('a later render replaces the observed options', () => {
    const t = new QuestionPresenceTracker(() => undefined);
    t.onPTYPromptVisible(screenWith(['1', '2', '3', '4']));
    t.onPTYPromptVisible(screenWith(['1', '2', '3']));
    expect(t.observedPromptOptions()?.map((o) => o.value)).toEqual(['1', '2', '3']);
  });

  it('a free-text prompt is observed with no options (empty, not null)', () => {
    const t = new QuestionPresenceTracker(() => undefined);
    t.onPTYPromptVisible(screenWith([], 'Enter your response:'));
    expect(t.observedPromptOptions()).toEqual([]);
  });

  it("survives a status update that stays 'waiting'", () => {
    const t = new QuestionPresenceTracker(() => undefined);
    t.onPTYPromptVisible(screenWith(['1', '2']));
    t.onStatusChange('waiting');
    expect(t.observedPromptOptions()?.map((o) => o.value)).toEqual(['1', '2']);
  });

  it("is cleared when status leaves 'waiting', with the rest of the observation", () => {
    const t = new QuestionPresenceTracker(() => undefined);
    t.onPTYPromptVisible(screenWith(['1', '2']));
    t.onStatusChange('executing');
    expect(t.observedPromptOptions()).toBeNull();
    expect(t.isPromptObservedOnPTY()).toBe(false);
  });

  it('is cleared by clearPending, with the rest of the observation', () => {
    const t = new QuestionPresenceTracker(() => undefined);
    t.onOrphanPTYPrompt(screenWith(['1', '2']));
    t.clearPending();
    expect(t.observedPromptOptions()).toBeNull();
    expect(t.isPromptObservedOnPTY()).toBe(false);
  });
});
