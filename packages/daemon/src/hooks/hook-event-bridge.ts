/**
 * Bridges Claude Code hook events to Remi's status/question system.
 *
 * Maps hook events to the same AgentStatus and Question types that
 * the OutputProcessor previously produced from terminal parsing.
 * This is the hook-based replacement for terminal output parsing.
 */

import { generateId } from '@remi/shared';
import type { AgentStatus, Question, QuestionOption, UUID } from '@remi/shared';
import { parseNumberedOptions } from '../parser/question-parser.ts';
import type { HookServerEvents } from './hook-server.ts';
import type {
  NotificationHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  StopHookInput,
} from './hook-types.ts';

export interface HookBridgeEvents {
  onStatusChange: (status: AgentStatus, context?: string) => void;
  onQuestion: (question: Question) => void;
  onSessionInfo: (claudeSessionId: string, transcriptPath: string) => void;
}

export class HookEventBridge {
  private readonly sessionId: UUID;
  private readonly events: HookBridgeEvents;

  constructor(sessionId: UUID, events: HookBridgeEvents) {
    this.sessionId = sessionId;
    this.events = events;
  }

  /** Returns HookServerEvents handlers wired to this bridge */
  hookHandlers(): Partial<HookServerEvents> {
    return {
      onPreToolUse: (input) => this.handlePreToolUse(input),
      onPostToolUse: (input) => this.handlePostToolUse(input),
      onNotification: (input) => this.handleNotification(input),
      onStop: (input) => this.handleStop(input),
      onSessionStart: (input) => this.handleSessionStart(input),
    };
  }

  handlePreToolUse(input: PreToolUseHookInput): void {
    this.events.onStatusChange('executing', input.tool_name);
  }

  handlePostToolUse(_input: PostToolUseHookInput): void {
    this.events.onStatusChange('thinking');
  }

  handleNotification(input: NotificationHookInput): void {
    if (input.notification_type === 'permission_prompt') {
      const question = this.buildPermissionQuestion(input.message);
      this.events.onQuestion(question);
      this.events.onStatusChange('waiting');
    } else if (input.notification_type === 'idle_prompt') {
      this.events.onStatusChange('idle');
    } else {
      // Intentionally unhandled notification types:
      // - 'auth_success': informational only, no status change needed
      // - 'elicitation_dialog': not yet supported by Remi
    }
  }

  handleStop(input: StopHookInput): void {
    // When stop_hook_active is true, the stop hook is intercepting and the
    // session is NOT actually stopping; it remains active.
    if (!input.stop_hook_active) {
      this.events.onStatusChange('idle');
    }
  }

  handleSessionStart(input: SessionStartHookInput): void {
    if (!input.session_id || !input.transcript_path) {
      return;
    }
    this.events.onSessionInfo(input.session_id, input.transcript_path);
  }

  private buildPermissionQuestion(message: string): Question {
    // Try to parse numbered options from the message text.
    // Claude Code sends messages like:
    //   "Do you want to proceed?\n1) Yes\n2) Yes, and don't ask again\n3) No"
    // or inline: "Allow? (1) Yes (2) Always (3) No"
    const parsed = message ? parseNumberedOptions(message) : null;

    if (parsed) {
      // Tag yes/no semantics on parsed options
      const taggedOptions: QuestionOption[] = parsed.options.map((opt) => {
        const lower = opt.label.toLowerCase();
        const isYes = lower.startsWith('yes') || lower === 'allow' || lower === 'always';
        const isNo = lower.startsWith('no') || lower === 'deny' || lower === 'reject';
        return {
          ...opt,
          isYes,
          isNo,
        };
      });

      return {
        id: generateId(),
        text: parsed.questionText,
        options: taggedOptions,
        allowsFreeText: false,
        isAnswered: false,
      };
    }

    // Fallback: simple Yes/No when no numbered options found
    const yesOption: QuestionOption = {
      label: 'Yes',
      value: 'y',
      isRecommended: true,
      isYes: true,
      isNo: false,
    };

    const noOption: QuestionOption = {
      label: 'No',
      value: 'n',
      isRecommended: false,
      isYes: false,
      isNo: true,
    };

    return {
      id: generateId(),
      text: message || 'Allow this action?',
      options: [yesOption, noOption],
      allowsFreeText: false,
      isAnswered: false,
    };
  }
}
