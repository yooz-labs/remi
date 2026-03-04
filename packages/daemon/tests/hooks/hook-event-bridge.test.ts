import { describe, expect, it } from 'bun:test';
import type { AgentStatus, Question } from '@remi/shared';
import { HookEventBridge } from '../../src/hooks/hook-event-bridge.ts';
import type {
  NotificationHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  StopHookInput,
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

    const bridge = new HookEventBridge('session-1', {
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

  it('maps Notification(permission_prompt) to question + waiting status', () => {
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

  it('provides default text for empty permission prompt', () => {
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
});
