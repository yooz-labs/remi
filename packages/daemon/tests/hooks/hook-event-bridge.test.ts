import { describe, expect, it } from 'bun:test';
import type { AgentStatus, Question } from '@remi/shared';
import { HookEventBridge } from '../../src/hooks/hook-event-bridge.ts';
import type {
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from '../../src/hooks/hook-types.ts';

function makeCommon() {
  return {
    session_id: 'test-session',
    transcript_path: '/tmp/test.jsonl',
    cwd: '/tmp/project',
    permission_mode: 'default',
  };
}

describe('HookEventBridge', () => {
  function createBridge() {
    const statuses: Array<{ status: AgentStatus; context?: string }> = [];
    const questions: Question[] = [];
    const sessionInfos: Array<{ claudeSessionId: string; transcriptPath: string }> = [];

    const bridge = new HookEventBridge('session-1' as import('@remi/shared').UUID, {
      onStatusChange: (status, context) => {
        if (context !== undefined) {
          statuses.push({ status, context });
        } else {
          statuses.push({ status });
        }
      },
      onQuestion: (q) => questions.push(q),
      onSessionInfo: (id, path) => sessionInfos.push({ claudeSessionId: id, transcriptPath: path }),
    });

    return { bridge, statuses, questions, sessionInfos };
  }

  it('maps PreToolUse to executing status with tool name', () => {
    const { bridge, statuses } = createBridge();

    bridge.handlePreToolUse({
      ...makeCommon(),
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    } as PreToolUseHookInput);

    expect(statuses).toEqual([{ status: 'executing', context: 'Bash' }]);
  });

  it('maps PostToolUse to thinking status', () => {
    const { bridge, statuses } = createBridge();

    bridge.handlePostToolUse({
      ...makeCommon(),
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'ok',
    } as PostToolUseHookInput);

    expect(statuses).toEqual([{ status: 'thinking' }]);
  });

  it('maps standalone Notification(permission_prompt) to the honest Yes/No 2-set', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handleNotification({
      ...makeCommon(),
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    } as NotificationHookInput);

    expect(statuses).toEqual([{ status: 'waiting' }]);
    expect(questions.length).toBe(1);
    expect(questions[0]?.text).toBe('Claude needs your permission to use Bash');
    // Fallback 2-option set (not parsed from message); this event never
    // carries permission_suggestions (#718).
    expect(questions[0]?.options.length).toBe(2);
    expect(questions[0]?.options[0]?.label).toBe('Yes');
    expect(questions[0]?.options[0]?.isYes).toBe(true);
    expect(questions[0]?.options[1]?.label).toBe('No');
    expect(questions[0]?.options[1]?.isNo).toBe(true);
    expect(questions[0]?.optionsAreFallback).toBe(true);
  });

  it('maps Notification(idle_prompt) to idle status', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handleNotification({
      ...makeCommon(),
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: '',
    } as NotificationHookInput);

    expect(statuses).toEqual([{ status: 'idle' }]);
    expect(questions.length).toBe(0);
  });

  it('maps Stop to idle status', () => {
    const { bridge, statuses } = createBridge();

    bridge.handleStop({
      ...makeCommon(),
      hook_event_name: 'Stop',
      stop_hook_active: false,
    } as StopHookInput);

    expect(statuses).toEqual([{ status: 'idle' }]);
  });

  it('maps SessionStart to session info', () => {
    const { bridge, sessionInfos } = createBridge();

    bridge.handleSessionStart({
      ...makeCommon(),
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-4-6',
    } as SessionStartHookInput);

    expect(sessionInfos.length).toBe(1);
    expect(sessionInfos[0]?.claudeSessionId).toBe('test-session');
    expect(sessionInfos[0]?.transcriptPath).toBe('/tmp/test.jsonl');
  });

  it('provides default text for empty standalone Notification', () => {
    const { bridge, questions } = createBridge();

    bridge.handleNotification({
      ...makeCommon(),
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: '',
    } as NotificationHookInput);

    expect(questions[0]?.text).toBe('Allow this action?');
    expect(questions[0]?.options.length).toBe(2);
    // #718: a generic Notification never carries permission_suggestions, so
    // it is always the honest Yes/No fallback.
    expect(questions[0]?.optionsAreFallback).toBe(true);
  });

  it('hookHandlers returns handlers that delegate to bridge methods', () => {
    const { bridge, statuses } = createBridge();
    const handlers = bridge.hookHandlers();

    handlers.onPreToolUse?.({
      ...makeCommon(),
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {},
    } as PreToolUseHookInput);

    expect(statuses).toEqual([{ status: 'executing', context: 'Edit' }]);
  });

  it('maps PermissionRequest with suggestions to numbered options immediately', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: {},
      permission_suggestions: ['Yes', 'Always', 'No'],
    } as PermissionRequestHookInput);

    expect(statuses).toEqual([{ status: 'waiting' }]);
    expect(questions.length).toBe(1);
    expect(questions[0]?.options.length).toBe(3);
    expect(questions[0]?.options[0]?.label).toBe('Yes');
    expect(questions[0]?.options[0]?.isYes).toBe(true);
    expect(questions[0]?.options[0]?.isRecommended).toBe(true);
    expect(questions[0]?.options[1]?.label).toBe('Always');
    expect(questions[0]?.options[1]?.isYes).toBe(true);
    expect(questions[0]?.options[2]?.label).toBe('No');
    expect(questions[0]?.options[2]?.isNo).toBe(true);
  });

  // #626: the bridge must THREAD the structured AskUserQuestion fields onto the
  // emitted Question (extractToolQuestion proves the shape; this proves wiring).
  it('threads the structured AskUserQuestion fields onto the emitted Question', () => {
    const { bridge, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Who is the PI?',
            header: 'Collab PI',
            multiSelect: false,
            options: [{ label: 'Scott', description: 'EEGLAB founder' }],
          },
          {
            question: 'Which tools?',
            header: 'Software focus',
            multiSelect: true,
            options: [{ label: 'EEGLAB', description: 'plugins' }],
          },
        ],
      },
    } as PermissionRequestHookInput);

    expect(questions.length).toBe(1);
    const q = questions[0];
    expect(q?.kind).toBe('multi_question');
    expect(q?.submitLabel).toBe('Submit');
    expect(q?.questions).toHaveLength(2);
    expect(q?.questions?.[0]?.header).toBe('Collab PI');
    expect(q?.questions?.[0]?.options[0]?.description).toBe('EEGLAB founder');
    expect(q?.questions?.[1]?.multiSelect).toBe(true);
    // Back-compat flat fields still mirror questions[0].
    expect(q?.text).toBe('Collab PI: Who is the PI?');
    expect(q?.options[0]?.label).toBe('Scott');
  });

  it('does NOT set kind/questions on a plain (non-AskUserQuestion) permission', () => {
    const { bridge, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    } as PermissionRequestHookInput);

    expect(questions.length).toBe(1);
    expect(questions[0]?.kind).toBeUndefined();
    expect(questions[0]?.questions).toBeUndefined();
    expect(questions[0]?.submitLabel).toBeUndefined();
  });

  // #628: the gate passes the LLM's lock-screen summary; the bridge must set it on
  // the emitted Question (the push prefers it over the raw "Allow Bash: …").
  it('sets Question.summary from the summary argument', () => {
    const { bridge, questions } = createBridge();

    bridge.handlePermissionRequest(
      {
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin main' },
      } as PermissionRequestHookInput,
      'Force-push to main?',
    );

    expect(questions.length).toBe(1);
    expect(questions[0]?.summary).toBe('Force-push to main?');
  });

  it('leaves Question.summary undefined when no summary is passed', () => {
    const { bridge, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    } as PermissionRequestHookInput);

    expect(questions[0]?.summary).toBeUndefined();
  });

  // Inputs with NO usable suggestion of either shape (fewer than 2 string
  // labels AND no structured entry this card can render as a one-tap "yes")
  // must fall back to the honest Yes/No 2-set (#718) so the iOS card always
  // renders something the user can act on, without fabricating a 3rd option
  // the daemon has no way to actually persist.
  const fallbackCases: Array<[string, unknown]> = [
    ['all non-string, non-suggestion entries', [null, 42, { label: 'Yes' }]],
    ['single valid string element (< 2 strings)', ['Yes']],
    ['empty array', []],
    ['string passed directly (not an array)', 'Yes'],
    ['number passed directly (not an array)', 7],
    ['array-like object', { 0: 'Yes', 1: 'No', length: 2 }],
    ['addDirectories with no directories field', [{ type: 'addDirectories' }]],
    ['setMode with no mode field', [{ type: 'setMode' }]],
    ['addRules with behavior "ask" (not a yes-variant)', [{ type: 'addRules', behavior: 'ask' }]],
    [
      'only unusable types (removeRules, unknown)',
      [{ type: 'removeRules' }, { type: 'someFutureType' }],
    ],
  ];
  for (const [label, value] of fallbackCases) {
    it(`PermissionRequest falls back to the honest Yes/No 2-set: ${label}`, () => {
      const { bridge, statuses, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Edit',
        tool_input: {},
        permission_suggestions: value as unknown as string[],
      } as PermissionRequestHookInput);

      expect(statuses).toEqual([{ status: 'waiting' }]);
      expect(questions.length).toBe(1);
      expect(questions[0]?.options.length).toBe(2);
      expect(questions[0]?.options[0]?.label).toBe('Yes');
      expect(questions[0]?.options[1]?.label).toBe('No');
      expect(questions[0]?.optionsAreFallback).toBe(true);
    });
  }

  describe('structured permission_suggestions (#718)', () => {
    it('addRules with behavior "allow" and destination "session" becomes a middle option', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/foo' },
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'rm -rf /tmp/foo' }],
            behavior: 'allow',
            destination: 'session',
          },
        ],
      } as PermissionRequestHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.optionsAreFallback).toBeUndefined();
      const opts = questions[0]?.options ?? [];
      expect(opts.map((o) => o.label)).toEqual([
        'Yes',
        'Yes, always allow: rm -rf /tmp/foo (this session)',
        'No',
      ]);
      expect(opts[1]?.isYes).toBe(true);
      expect(opts[1]?.isNo).toBe(false);
      expect(opts[1]?.suggestionIndex).toBe(0);
    });

    it('addRules with destination "localSettings" carries no "(this session)" suffix', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'git push' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options[1]?.label).toBe('Yes, always allow: git push');
    });

    it('addRules falls back to toolName when a rule has no ruleContent', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: {},
        permission_suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow' },
        ],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options[1]?.label).toBe('Yes, always allow: Read');
    });

    it('addRules with behavior "deny" is skipped (not a yes-variant)', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny' },
        ],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options.length).toBe(2); // honest fallback, deny entry skipped
      expect(questions[0]?.optionsAreFallback).toBe(true);
    });

    it('removeRules / replaceRules / removeDirectories are skipped (never yes-variants)', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [
          { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' },
          { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' },
          { type: 'removeDirectories', directories: ['/tmp'] },
        ],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options.length).toBe(2);
      expect(questions[0]?.optionsAreFallback).toBe(true);
    });

    it('addDirectories becomes a middle option naming the directories', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: {},
        permission_suggestions: [
          { type: 'addDirectories', directories: ['/tmp'], destination: 'session' },
        ],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options.map((o) => o.label)).toEqual([
        'Yes',
        'Yes, allow directory /tmp',
        'No',
      ]);
      expect(questions[0]?.options[1]?.suggestionIndex).toBe(0);
    });

    it('setMode becomes a middle option naming the mode', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        // NOT ExitPlanMode/AskUserQuestion: those tools carry their own
        // authored toolQuestion options and never reach optionsFromSuggestions.
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [{ type: 'setMode', mode: 'plan', destination: 'session' }],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options.map((o) => o.label)).toEqual([
        'Yes',
        'Yes, switch to plan mode',
        'No',
      ]);
    });

    it('multiple usable suggestions each become their own middle option, in order', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow' },
          { type: 'addDirectories', directories: ['/tmp'] },
        ],
      } as PermissionRequestHookInput);

      const opts = questions[0]?.options ?? [];
      expect(opts).toHaveLength(4);
      expect(opts[1]?.label).toBe('Yes, always allow: ls');
      expect(opts[1]?.suggestionIndex).toBe(0);
      expect(opts[2]?.label).toBe('Yes, allow directory /tmp');
      expect(opts[2]?.suggestionIndex).toBe(1);
      expect(opts[3]?.label).toBe('No');
    });

    it('caps at 4 total options, keeping the first suggestions and dropping the rest', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'cmd-1' }],
            behavior: 'allow',
          },
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'cmd-2' }],
            behavior: 'allow',
          },
          { type: 'addDirectories', directories: ['/tmp'] },
        ],
      } as PermissionRequestHookInput);

      const opts = questions[0]?.options ?? [];
      // Yes + 2 kept middles + No == 4 total; the 3rd suggestion is dropped.
      expect(opts).toHaveLength(4);
      expect(opts[1]?.label).toBe('Yes, always allow: cmd-1');
      expect(opts[2]?.label).toBe('Yes, always allow: cmd-2');
      expect(opts[3]?.label).toBe('No');
      expect(opts.some((o) => o.label.includes('/tmp'))).toBe(false);
    });

    it('a long ruleContent is truncated to ~80 characters', () => {
      const { bridge, questions } = createBridge();
      const longCommand = 'x'.repeat(200);

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: longCommand }],
            behavior: 'allow',
          },
        ],
      } as PermissionRequestHookInput);

      const label = questions[0]?.options[1]?.label ?? '';
      expect(label.length).toBeLessThanOrEqual(80);
      expect(label.endsWith('...')).toBe(true);
    });

    it('disambiguates two suggestions that truncate to an identical label (#718 review)', () => {
      // Two long commands sharing the first ~90 characters would otherwise
      // both truncate to the SAME 80-char label. That is not just cosmetic:
      // the lock-screen relay answers by LABEL, and resolveOption matches an
      // answer to its option by label first, so identical labels would let
      // an answer resolve to the WRONG suggestionIndex and echo the wrong
      // permission_suggestions entry back to Claude Code.
      const sharedPrefix = 'echo '.repeat(20); // 100 chars, identical for both
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: `${sharedPrefix}one` }],
            behavior: 'allow',
          },
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: `${sharedPrefix}two` }],
            behavior: 'allow',
          },
        ],
      } as PermissionRequestHookInput);

      const opts = questions[0]?.options ?? [];
      expect(opts).toHaveLength(4);
      // Distinct labels: the 2nd occurrence gets an ordinal suffix.
      expect(opts[1]?.label).not.toBe(opts[2]?.label);
      expect(opts[2]?.label.endsWith(' (2)')).toBe(true);
      // Each label still maps back to the CORRECT original suggestion.
      expect(opts[1]?.suggestionIndex).toBe(0);
      expect(opts[2]?.suggestionIndex).toBe(1);
      // Total length still fits the cap even with the ordinal suffix appended.
      expect(opts[2]?.label.length).toBeLessThanOrEqual(80);
    });

    it('unknown/undocumented suggestion types are skipped, falling back to Yes/No', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        permission_suggestions: [{ type: 'someBrandNewType', foo: 'bar' }],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options.length).toBe(2);
      expect(questions[0]?.optionsAreFallback).toBe(true);
    });

    it('legacy >= 2 plain-string suggestions still take the unchanged string path', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Edit',
        tool_input: {},
        permission_suggestions: ['Yes', 'Always', 'No'],
      } as PermissionRequestHookInput);

      expect(questions[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Always', 'No']);
      expect(questions[0]?.optionsAreFallback).toBeUndefined();
    });
  });

  // Mixed arrays where at least 2 string entries survive the filter:
  // render those strings as the option set. This accepts Claude Code's
  // newer permission_suggestions union where object entries (addDirectories
  // etc) sit alongside Yes/No string labels.
  const partialStringCases: Array<[string, unknown[], string[]]> = [
    ['strings + object entry', ['Yes', { type: 'addDirectories' }, 'No'], ['Yes', 'No']],
    ['strings + null', ['Yes', null, 'No'], ['Yes', 'No']],
    ['strings + empty string', ['Yes', '', 'No'], ['Yes', 'No']],
  ];
  for (const [label, value, expected] of partialStringCases) {
    it(`PermissionRequest uses filtered string labels: ${label}`, () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Edit',
        tool_input: {},
        permission_suggestions: value as unknown as string[],
      } as PermissionRequestHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.options.map((o) => o.label)).toEqual(expected);
      // isYes / isNo are the load-bearing flags the iOS response handler
      // uses to route taps; verify they survive the filtered-string path.
      expect(questions[0]?.options[0]?.isYes).toBe(true);
      expect(questions[0]?.options[1]?.isNo).toBe(true);
    });
  }

  it('PermissionRequest without suggestions emits immediately with the honest Yes/No 2-set', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    } as PermissionRequestHookInput);

    // Emitted immediately (no timer, no waiting)
    expect(statuses).toEqual([{ status: 'waiting' }]);
    expect(questions.length).toBe(1);
    expect(questions[0]?.text).toBe('Allow Bash: rm -rf /');
    expect(questions[0]?.options.length).toBe(2);
    expect(questions[0]?.options[0]?.label).toBe('Yes');
    expect(questions[0]?.options[1]?.label).toBe('No');
    expect(questions[0]?.optionsAreFallback).toBe(true);
  });

  it('a subagent PermissionRequest names the agent in the text (#497)', () => {
    const { bridge, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      agent_id: 'agent-1',
      agent_type: 'code-reviewer',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    } as PermissionRequestHookInput);

    // The user sees WHO is asking + the command, not a bare "Allow Bash".
    expect(questions[0]?.text).toBe('code-reviewer · Bash: git push origin main');
  });

  it('surfaces the real AskUserQuestion question + options, not "Allow AskUserQuestion" (#597)', () => {
    const { bridge, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which approach do you prefer?',
            header: 'Approach',
            options: [
              { label: 'Refactor first', description: 'a' },
              { label: 'Ship then refactor', description: 'b' },
            ],
          },
        ],
      },
    } as PermissionRequestHookInput);

    expect(questions[0]?.text).toBe('Approach: Which approach do you prefer?');
    expect(questions[0]?.options.map((o) => o.label)).toEqual([
      'Refactor first',
      'Ship then refactor',
    ]);
    // Picks, so the answer path releases the hook + submits the digit.
    expect(questions[0]?.options.every((o) => !o.isYes && !o.isNo)).toBe(true);
  });

  it('surfaces ExitPlanMode plan-approval choices (#597)', () => {
    const { bridge, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '# Plan\n- do the thing' },
    } as PermissionRequestHookInput);

    expect(questions[0]?.options.map((o) => o.label)).toEqual([
      'Yes, and auto-accept edits',
      'Yes, and manually approve edits',
      'No, keep planning',
    ]);
    expect(questions[0]?.text).toContain('Plan ready');
  });

  it('maps PostToolUseFailure to executing status with error context', () => {
    const { bridge, statuses } = createBridge();

    bridge.handlePostToolUseFailure({
      ...makeCommon(),
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: {},
      error: 'command not found',
    } as PostToolUseFailureHookInput);

    expect(statuses).toEqual([{ status: 'executing', context: 'Bash failed: command not found' }]);
  });

  it('maps SubagentStart to executing status with agent_type', () => {
    const { bridge, statuses } = createBridge();

    bridge.handleSubagentStart({
      ...makeCommon(),
      hook_event_name: 'SubagentStart',
      agent_type: 'code-reviewer',
    } as SubagentStartHookInput);

    expect(statuses).toEqual([{ status: 'executing', context: 'subagent:code-reviewer' }]);
  });

  it('maps SubagentStop to thinking status', () => {
    const { bridge, statuses } = createBridge();

    bridge.handleSubagentStop({
      ...makeCommon(),
      hook_event_name: 'SubagentStop',
      agent_type: 'code-reviewer',
    } as SubagentStopHookInput);

    expect(statuses).toEqual([{ status: 'thinking' }]);
  });

  it('maps StopFailure to question + waiting status', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handleStopFailure({
      ...makeCommon(),
      hook_event_name: 'StopFailure',
      error_type: 'timeout',
    } as StopFailureHookInput);

    expect(statuses).toEqual([{ status: 'waiting' }]);
    expect(questions.length).toBe(1);
    expect(questions[0]?.text).toContain('timeout');
    expect(questions[0]?.options.length).toBe(2);
    expect(questions[0]?.options[0]?.isYes).toBe(true);
    expect(questions[0]?.options[1]?.isNo).toBe(true);
  });

  it('maps SessionEnd to idle status', () => {
    const { bridge, statuses } = createBridge();

    bridge.handleSessionEnd({
      ...makeCommon(),
      hook_event_name: 'SessionEnd',
      reason: 'user_exit',
    } as SessionEndHookInput);

    expect(statuses).toEqual([{ status: 'idle' }]);
  });

  it('hookHandlers includes all high-priority handlers', () => {
    const { bridge } = createBridge();
    const handlers = bridge.hookHandlers();

    expect(handlers.onPermissionRequest).toBeDefined();
    expect(handlers.onPostToolUseFailure).toBeDefined();
    expect(handlers.onSubagentStart).toBeDefined();
    expect(handlers.onSubagentStop).toBeDefined();
    expect(handlers.onStopFailure).toBeDefined();
    expect(handlers.onSessionEnd).toBeDefined();
  });

  describe('PermissionRequest + Notification forwarding', () => {
    it('emits BOTH question events when PermissionRequest is followed by Notification(permission_prompt)', () => {
      // Phase 3: the 5 s `lastPermissionEmitAt` dedup window is gone. Both
      // hook events now forward their metadata; QuestionPresenceTracker
      // (cli.ts wiring) collapses them into a single push because the
      // tracker only holds one `pending` slot at a time and PTY confirms
      // once. This test pins the bridge contract: hand both events through.
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/foo.ts' },
        permission_suggestions: ['Yes', 'Always', 'No'],
      } as PermissionRequestHookInput);
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Edit: /tmp/foo.ts?',
      } as NotificationHookInput);

      expect(questions.length).toBe(2);
    });

    it('allows standalone Notification when no preceding PermissionRequest', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.text).toBe('Claude needs your permission to use Bash');
      expect(questions[0]?.options.length).toBe(2);
    });

    it('PermissionRequest includes tool context in question text', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ssh hallu "uv run pytest"' },
      } as PermissionRequestHookInput);

      expect(questions[0]?.text).toBe('Allow Bash: ssh hallu "uv run pytest"');
    });

    it('stamps source so the tracker can prefer the rich request over the generic notification (#574)', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      } as PermissionRequestHookInput);
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      } as NotificationHookInput);

      expect(questions[0]?.source).toBe('permission_request');
      expect(questions[1]?.source).toBe('notification');
    });
  });

  describe('subagent context filtering (issue #316, phase 4 #419)', () => {
    it('forwards PermissionRequest during a Task tool call (tracker handles presence)', () => {
      // Phase 4 (#419): the subagentContext drop in handlePermissionRequest
      // is removed. The bridge now forwards every question; whether a push
      // fires is decided by the QuestionPresenceTracker downstream, based
      // on PTY confirmation. A hot-switched subagent view that renders
      // a permission prompt on the user's PTY IS user-answerable.
      const { bridge, questions } = createBridge();

      // Main agent spawns subagent via Task
      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { subagent_type: 'general-purpose', prompt: 'do stuff' },
        tool_use_id: 'tu_task_1',
      } as PreToolUseHookInput);

      expect(bridge.isInSubagentContext()).toBe(true);

      // Subagent tries to run an unapproved Bash command — PermissionRequest fires
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'nmap --version' },
      } as PermissionRequestHookInput);

      // Bridge forwards the question; the tracker (cli.ts wiring) gates push.
      expect(questions).toHaveLength(1);
      expect(questions[0]?.text).toContain('nmap --version');

      // Task completes; context exits
      bridge.handlePostToolUse({
        ...makeCommon(),
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_response: { result: 'done' },
        tool_use_id: 'tu_task_1',
      } as PostToolUseHookInput);

      expect(bridge.isInSubagentContext()).toBe(false);

      // Post-Task PermissionRequest passes through unchanged.
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'dig example.com' },
      } as PermissionRequestHookInput);

      expect(questions).toHaveLength(2);
      expect(questions[1]?.text).toContain('dig example.com');
    });

    it('forwards Notification(permission_prompt) during a Task tool call', () => {
      // Mirror of the PermissionRequest test above. The bridge no longer
      // drops Notification(permission_prompt) based on subagent context;
      // the tracker collapses hook+PTY events into a single push.
      const { bridge, questions } = createBridge();

      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_1',
      } as PreToolUseHookInput);

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      } as NotificationHookInput);

      expect(questions).toHaveLength(1);
      expect(questions[0]?.text).toBe('Claude needs your permission to use Bash');
    });

    it('concurrent Task calls: context exits only when all complete', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_A',
      } as PreToolUseHookInput);
      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_B',
      } as PreToolUseHookInput);

      // Close A only
      bridge.handlePostToolUse({
        ...makeCommon(),
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'tu_A',
      } as PostToolUseHookInput);

      expect(bridge.isInSubagentContext()).toBe(true); // B still running

      // Phase 4: PermissionRequest forwards even in subagent context; the
      // tracker handles push gating downstream. This test now only
      // verifies the subagentContext bookkeeping (reset semantics), not
      // bridge-level suppression.
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      } as PermissionRequestHookInput);
      expect(questions).toHaveLength(1);

      // Close B
      bridge.handlePostToolUse({
        ...makeCommon(),
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'tu_B',
      } as PostToolUseHookInput);

      expect(bridge.isInSubagentContext()).toBe(false);
    });

    it('nested non-Task tool uses do NOT enter context', () => {
      const { bridge, questions } = createBridge();
      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'tu_b1',
      } as PreToolUseHookInput);

      expect(bridge.isInSubagentContext()).toBe(false);

      // Normal PermissionRequest should still reach the user
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'sudo something' },
      } as PermissionRequestHookInput);

      expect(questions).toHaveLength(1);
    });

    it('handleStop(stop_hook_active=false) resets orphan subagent state', () => {
      const { bridge } = createBridge();
      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_orphan',
      } as PreToolUseHookInput);
      expect(bridge.isInSubagentContext()).toBe(true);

      // Agent turn stops without matching PostToolUse(Task)
      bridge.handleStop({
        ...makeCommon(),
        hook_event_name: 'Stop',
        stop_hook_active: false,
      } as StopHookInput);

      expect(bridge.isInSubagentContext()).toBe(false);
    });

    it('handleSessionEnd resets orphan subagent state', () => {
      const { bridge } = createBridge();
      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_orphan2',
      } as PreToolUseHookInput);
      expect(bridge.isInSubagentContext()).toBe(true);

      bridge.handleSessionEnd({
        ...makeCommon(),
        hook_event_name: 'SessionEnd',
        reason: 'user_exit',
      } as SessionEndHookInput);

      expect(bridge.isInSubagentContext()).toBe(false);
    });

    it('handleStopFailure resets orphan subagent state', () => {
      const { bridge } = createBridge();
      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_orphan3',
      } as PreToolUseHookInput);
      expect(bridge.isInSubagentContext()).toBe(true);

      bridge.handleStopFailure({
        ...makeCommon(),
        hook_event_name: 'StopFailure',
        error_type: 'network',
        error: 'conn refused',
      } as StopFailureHookInput);

      expect(bridge.isInSubagentContext()).toBe(false);
    });

    it('noteSubagentToolEnd pops a tracked use_id without touching status (#710)', () => {
      const { bridge, statuses } = createBridge();

      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_note_1',
      } as PreToolUseHookInput);
      expect(bridge.isInSubagentContext()).toBe(true);
      statuses.length = 0;

      // The hook-bridge-setup listener calls this directly (instead of
      // handlePostToolUse) for a PostToolUse it drops as subagent-tagged, so
      // it must pop the tracker WITHOUT emitting the normal 'thinking' status.
      bridge.noteSubagentToolEnd('Task', 'tu_note_1');

      expect(bridge.isInSubagentContext()).toBe(false);
      expect(statuses).toEqual([]);
    });

    it('noteSubagentToolEnd on an untracked use_id is a no-op (genuine subagent-internal call)', () => {
      const { bridge } = createBridge();

      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_outer',
      } as PreToolUseHookInput);
      expect(bridge.isInSubagentContext()).toBe(true);

      // A subagent's own internal tool call was never tracked (its PreToolUse
      // was dropped without tracking), so popping it must not affect the
      // outer Task's tracked entry.
      bridge.noteSubagentToolEnd('Bash', 'tu_inner_untracked');

      expect(bridge.isInSubagentContext()).toBe(true);
    });

    it('resetSubagentContext clears tracked state (#710)', () => {
      const { bridge } = createBridge();

      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_reset_1',
      } as PreToolUseHookInput);
      expect(bridge.isInSubagentContext()).toBe(true);

      bridge.resetSubagentContext();

      expect(bridge.isInSubagentContext()).toBe(false);
    });

    it('handleSessionStart resets any stale state from prior session', () => {
      const { bridge } = createBridge();
      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_stale',
      } as PreToolUseHookInput);
      expect(bridge.isInSubagentContext()).toBe(true);

      bridge.handleSessionStart({
        ...makeCommon(),
        session_id: 'new-session-id',
        transcript_path: '/tmp/new.jsonl',
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'claude-opus',
      } as SessionStartHookInput);

      expect(bridge.isInSubagentContext()).toBe(false);
    });
  });
});
