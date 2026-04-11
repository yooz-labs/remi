import { afterEach, describe, expect, it } from 'bun:test';
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
  let activeBridge: HookEventBridge | null = null;

  function createBridge(mergeWindowMs = 200) {
    const statuses: Array<{ status: AgentStatus; context?: string }> = [];
    const questions: Question[] = [];
    const sessionInfos: Array<{ claudeSessionId: string; transcriptPath: string }> = [];

    const bridge = new HookEventBridge(
      'session-1',
      {
        onStatusChange: (status, context) => {
          if (context !== undefined) {
            statuses.push({ status, context });
          } else {
            statuses.push({ status });
          }
        },
        onQuestion: (q) => questions.push(q),
        onSessionInfo: (id, path) =>
          sessionInfos.push({ claudeSessionId: id, transcriptPath: path }),
      },
      mergeWindowMs,
    );

    activeBridge = bridge;
    return { bridge, statuses, questions, sessionInfos };
  }

  afterEach(() => {
    if (activeBridge) {
      activeBridge.dispose();
      activeBridge = null;
    }
  });

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

  it('maps standalone Notification(permission_prompt) to question + waiting', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handleNotification({
      ...makeCommon(),
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Allow Bash: npm test?',
    } as NotificationHookInput);

    expect(statuses).toEqual([{ status: 'waiting' }]);
    expect(questions.length).toBe(1);
    expect(questions[0]?.text).toBe('Allow Bash: npm test?');
    expect(questions[0]?.options.length).toBe(2);
    expect(questions[0]?.options[0]?.isYes).toBe(true);
    expect(questions[0]?.options[1]?.isNo).toBe(true);
    expect(questions[0]?.allowsFreeText).toBe(false);
    expect(questions[0]?.isAnswered).toBe(false);
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

  it('maps PermissionRequest with permission_suggestions to numbered options immediately', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: {},
      permission_suggestions: ['Yes', 'Always', 'No'],
    } as PermissionRequestHookInput);

    // Emitted immediately (no timer)
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

  it('PermissionRequest without suggestions defers and waits for Notification', () => {
    const { bridge, statuses, questions } = createBridge();

    bridge.handlePermissionRequest({
      ...makeCommon(),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    } as PermissionRequestHookInput);

    // Nothing emitted yet; waiting for Notification
    expect(statuses.length).toBe(0);
    expect(questions.length).toBe(0);
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

  describe('PermissionRequest + Notification merge', () => {
    it('merges PermissionRequest (tool context) with Notification (numbered options)', () => {
      const { bridge, questions, statuses } = createBridge();

      // PermissionRequest fires first with no suggestions (e.g. Bash)
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      } as PermissionRequestHookInput);

      expect(questions.length).toBe(0); // Deferred

      // Notification arrives with numbered options
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: "Do you want to proceed?\n1) Yes\n2) Yes, and don't ask again\n3) No",
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      // Question text comes from PermissionRequest (has tool context)
      expect(questions[0]?.text).toBe('Allow Bash: npm test');
      // Options come from Notification message (has numbered options)
      expect(questions[0]?.options.length).toBe(3);
      expect(questions[0]?.options[0]?.label).toBe('Yes');
      expect(questions[0]?.options[0]?.value).toBe('1');
      expect(questions[0]?.options[0]?.isYes).toBe(true);
      expect(questions[0]?.options[1]?.label).toBe("Yes, and don't ask again");
      expect(questions[0]?.options[1]?.value).toBe('2');
      expect(questions[0]?.options[1]?.isYes).toBe(true);
      expect(questions[0]?.options[2]?.label).toBe('No');
      expect(questions[0]?.options[2]?.value).toBe('3');
      expect(questions[0]?.options[2]?.isNo).toBe(true);
      expect(statuses).toEqual([{ status: 'waiting' }]);
    });

    it('falls back to Yes/No if Notification does not arrive in time', async () => {
      // Use a very short merge window to avoid slow tests
      const { bridge, questions, statuses } = createBridge(10);

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      } as PermissionRequestHookInput);

      expect(questions.length).toBe(0);

      // Wait for the timer to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(questions.length).toBe(1);
      expect(questions[0]?.text).toBe('Allow Bash: rm -rf /');
      expect(questions[0]?.options.length).toBe(2);
      expect(questions[0]?.options[0]?.isYes).toBe(true);
      expect(questions[0]?.options[1]?.isNo).toBe(true);
      expect(statuses).toEqual([{ status: 'waiting' }]);
    });

    it('suppresses Notification after PermissionRequest with suggestions', () => {
      const { bridge, questions } = createBridge();

      // PermissionRequest with suggestions emits immediately
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/foo.ts' },
        permission_suggestions: ['Yes', 'Always', 'No'],
      } as PermissionRequestHookInput);

      expect(questions.length).toBe(1);

      // Notification arrives after; should be suppressed
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Edit: /tmp/foo.ts?\n1) Yes\n2) Always\n3) No',
      } as NotificationHookInput);

      // Still only 1 question
      expect(questions.length).toBe(1);
    });

    it('merges with Notification that has no parseable options (falls back to Yes/No)', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      } as PermissionRequestHookInput);

      // Notification with plain text, no numbered options
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Bash?',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      // Falls back to Yes/No using PermissionRequest prompt text
      expect(questions[0]?.text).toBe('Allow Bash: echo hello');
      expect(questions[0]?.options.length).toBe(2);
      expect(questions[0]?.options[0]?.isYes).toBe(true);
      expect(questions[0]?.options[1]?.isNo).toBe(true);
    });

    it('cancels previous pending merge if new PermissionRequest arrives', () => {
      const { bridge, questions } = createBridge();

      // First PermissionRequest (no suggestions)
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'cmd1' },
      } as PermissionRequestHookInput);

      // Second PermissionRequest before Notification arrives; replaces the first
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/bar.ts' },
      } as PermissionRequestHookInput);

      // Notification arrives; should merge with second PermissionRequest
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Proceed?\n1) Yes\n2) No',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      // Prompt text from the second PermissionRequest
      expect(questions[0]?.text).toBe('Allow Edit: /tmp/bar.ts');
    });

    it('dispose cancels pending timer', async () => {
      const { bridge, questions } = createBridge(10);

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo test' },
      } as PermissionRequestHookInput);

      bridge.dispose();

      // Wait past the merge window
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Timer was cancelled; no question emitted
      expect(questions.length).toBe(0);
    });

    it('standalone Notification works after merge window expires', async () => {
      const { bridge, questions } = createBridge(10);

      // PermissionRequest without suggestions
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo 1' },
      } as PermissionRequestHookInput);

      // Let timer fire (Yes/No fallback)
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(questions.length).toBe(1);

      // Later, a standalone Notification (not related to a PermissionRequest)
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Another question?\n1) A\n2) B\n3) C',
      } as NotificationHookInput);

      expect(questions.length).toBe(2);
      expect(questions[1]?.options.length).toBe(3);
    });
  });

  describe('numbered option parsing in permission_prompt', () => {
    it('parses multiline numbered options with parenthesis format via standalone Notification', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: "Do you want to proceed?\n1) Yes\n2) Yes, and don't ask again\n3) No",
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.text).toBe('Do you want to proceed?');
      expect(questions[0]?.options.length).toBe(3);
      expect(questions[0]?.options[0]?.label).toBe('Yes');
      expect(questions[0]?.options[0]?.value).toBe('1');
      expect(questions[0]?.options[0]?.isYes).toBe(true);
      expect(questions[0]?.options[1]?.label).toBe("Yes, and don't ask again");
      expect(questions[0]?.options[1]?.value).toBe('2');
      expect(questions[0]?.options[1]?.isYes).toBe(true);
      expect(questions[0]?.options[2]?.label).toBe('No');
      expect(questions[0]?.options[2]?.value).toBe('3');
      expect(questions[0]?.options[2]?.isNo).toBe(true);
    });

    it('parses multiline numbered options with dot format', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Bash?\n1. Yes\n2. Always\n3. No',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.text).toBe('Allow Bash?');
      expect(questions[0]?.options.length).toBe(3);
      expect(questions[0]?.options[0]?.label).toBe('Yes');
      expect(questions[0]?.options[1]?.label).toBe('Always');
      expect(questions[0]?.options[1]?.isYes).toBe(true);
      expect(questions[0]?.options[2]?.label).toBe('No');
      expect(questions[0]?.options[2]?.isNo).toBe(true);
    });

    it('parses inline numbered options', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow? (1) Yes (2) Always (3) No',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.options.length).toBe(3);
      expect(questions[0]?.options[0]?.label).toBe('Yes');
      expect(questions[0]?.options[0]?.value).toBe('1');
      expect(questions[0]?.options[1]?.label).toBe('Always');
      expect(questions[0]?.options[2]?.label).toBe('No');
    });

    it('falls back to Yes/No when no numbered options in standalone Notification', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Bash: npm test?',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.text).toBe('Allow Bash: npm test?');
      expect(questions[0]?.options.length).toBe(2);
      expect(questions[0]?.options[0]?.label).toBe('Yes');
      expect(questions[0]?.options[0]?.isYes).toBe(true);
      expect(questions[0]?.options[1]?.label).toBe('No');
      expect(questions[0]?.options[1]?.isNo).toBe(true);
    });

    it('falls back to Yes/No for empty message', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: '',
      } as NotificationHookInput);

      expect(questions[0]?.text).toBe('Allow this action?');
      expect(questions[0]?.options.length).toBe(2);
    });

    it('falls back to Yes/No when only one numbered option', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Something\n1) Only one option here',
      } as NotificationHookInput);

      // Single option should not be treated as numbered; fall back
      expect(questions[0]?.options.length).toBe(2);
      expect(questions[0]?.options[0]?.label).toBe('Yes');
    });

    it('tags deny/reject as isNo', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Confirm?\n1) Allow\n2) Deny',
      } as NotificationHookInput);

      expect(questions[0]?.options[0]?.isYes).toBe(true);
      expect(questions[0]?.options[0]?.isNo).toBe(false);
      expect(questions[0]?.options[1]?.isYes).toBe(false);
      expect(questions[0]?.options[1]?.isNo).toBe(true);
    });

    it('sets allowsFreeText to false for numbered permission options', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Proceed?\n1) Yes\n2) No',
      } as NotificationHookInput);

      expect(questions[0]?.allowsFreeText).toBe(false);
    });

    it('marks first option as recommended', () => {
      const { bridge, questions } = createBridge();

      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow?\n1) Yes\n2) Yes, always\n3) No',
      } as NotificationHookInput);

      expect(questions[0]?.options[0]?.isRecommended).toBe(true);
      expect(questions[0]?.options[1]?.isRecommended).toBe(false);
      expect(questions[0]?.options[2]?.isRecommended).toBe(false);
    });
  });
});
