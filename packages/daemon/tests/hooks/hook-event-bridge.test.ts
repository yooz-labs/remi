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

  it('maps standalone Notification(permission_prompt) to 3-option question', () => {
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
    // Default 3-option set (not parsed from message)
    expect(questions[0]?.options.length).toBe(3);
    expect(questions[0]?.options[0]?.label).toBe('Yes');
    expect(questions[0]?.options[0]?.isYes).toBe(true);
    expect(questions[0]?.options[1]?.label).toBe('Yes, always');
    expect(questions[0]?.options[1]?.isYes).toBe(true);
    expect(questions[0]?.options[2]?.label).toBe('No');
    expect(questions[0]?.options[2]?.isNo).toBe(true);
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
    expect(questions[0]?.options.length).toBe(3);
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

  it('PermissionRequest without suggestions emits immediately with default 3 options', () => {
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
    expect(questions[0]?.options.length).toBe(3);
    expect(questions[0]?.options[0]?.label).toBe('Yes');
    expect(questions[0]?.options[1]?.label).toBe('Yes, always');
    expect(questions[0]?.options[2]?.label).toBe('No');
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

  describe('PermissionRequest + Notification dedup', () => {
    it('suppresses Notification after PermissionRequest with suggestions', () => {
      const { bridge, questions } = createBridge();

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
        message: 'Allow Edit: /tmp/foo.ts?',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
    });

    it('suppresses Notification after PermissionRequest without suggestions', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      } as PermissionRequestHookInput);

      expect(questions.length).toBe(1);

      // Notification with "Claude needs your permission" text arrives; suppressed
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
    });

    it('allows standalone Notification when no recent PermissionRequest', () => {
      const { bridge, questions } = createBridge();

      // No preceding PermissionRequest
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      } as NotificationHookInput);

      expect(questions.length).toBe(1);
      expect(questions[0]?.text).toBe('Claude needs your permission to use Bash');
      expect(questions[0]?.options.length).toBe(3);
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
  });

  describe('subagent context filtering (issue #316)', () => {
    it('suppresses PermissionRequest while inside a Task tool call', () => {
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

      // User should NOT see this question
      expect(questions).toHaveLength(0);

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

      // Now a real user-facing PermissionRequest SHOULD pass through
      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'dig example.com' },
      } as PermissionRequestHookInput);

      expect(questions).toHaveLength(1);
      expect(questions[0]?.text).toContain('dig example.com');
    });

    it('suppresses Notification(permission_prompt) while in subagent context', () => {
      const { bridge, questions } = createBridge();

      bridge.handlePreToolUse({
        ...makeCommon(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 'tu_1',
      } as PreToolUseHookInput);

      // Notification(permission_prompt) that would fire during subagent work
      bridge.handleNotification({
        ...makeCommon(),
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      } as NotificationHookInput);

      expect(questions).toHaveLength(0);
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

      bridge.handlePermissionRequest({
        ...makeCommon(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      } as PermissionRequestHookInput);
      expect(questions).toHaveLength(0);

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
