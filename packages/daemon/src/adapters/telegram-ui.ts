/**
 * Telegram UI formatting utilities.
 *
 * Formats Remi messages, questions, and status for Telegram display.
 * Uses Telegram's MarkdownV2 formatting where appropriate.
 */

import * as path from 'node:path';
import type {
  AgentStatus,
  DiscoverableSession,
  Message,
  Question,
  QuestionOption,
} from '@remi/shared';
import { InlineKeyboard } from 'grammy';

/**
 * Comprehensive ANSI and terminal control sequence stripping.
 * Handles all common terminal escape sequences.
 */
export function stripTerminalCodes(text: string): string {
  return (
    text
      // Standard ANSI escape codes (colors, styles)
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // Private mode sequences [?...h/l (cursor, screen modes)
      .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
      // OSC sequences (title, clipboard, etc.)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // DCS sequences
      .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
      // Cursor position and other CSI sequences
      .replace(/\x1b\[[0-9;]*[ABCDEFGJKST]/g, '')
      // Raw escape character remnants
      .replace(/\x1b/g, '')
      // Leftover bracket sequences like [?25h that weren't caught
      .replace(/\[\?[0-9;]*[a-zA-Z]/g, '')
      // Leftover CSI-like sequences
      .replace(/\[[0-9;]*[a-zA-Z]/g, '')
      // Control characters (except newline, tab)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  );
}

/**
 * Check if content is meaningful (not just garbage/control sequences).
 */
export function isValidContent(text: string): boolean {
  const cleaned = stripTerminalCodes(text).trim();
  // Must have at least some alphanumeric content
  return cleaned.length > 0 && /[a-zA-Z0-9]/.test(cleaned);
}

/**
 * Escape special characters for Telegram MarkdownV2.
 * These characters must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function _escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

/**
 * Format a Message for Telegram display.
 * Strips ANSI codes and formats for readability.
 */
export function formatMessageForTelegram(message: Message): string {
  let content = stripTerminalCodes(message.content);

  // Trim excessive whitespace
  content = content.trim();

  // Return empty if no valid content
  if (!content || !isValidContent(content)) {
    return '';
  }

  // Truncate very long messages (Telegram limit is 4096 chars)
  if (content.length > 4000) {
    content = `${content.slice(0, 3997)}...`;
  }

  // Add tool indicator if present
  if (message.tool && message.isEditing) {
    content = `⚙️ ${message.tool}\n\n${content}`;
  }

  return content;
}

/** Telegram's message limit is 4096 characters; a question body stays
 *  below it. */
const TELEGRAM_QUESTION_MAX = 4000;

/** A question card as Telegram sends it: the message text, and its answer
 *  buttons, or none when the card is answered in the app or the terminal. */
export interface TelegramQuestionCard {
  readonly text: string;
  readonly keyboard: InlineKeyboard | undefined;
}

/** Bound a text to Telegram's limit, marking the cut. */
function boundText(text: string): string {
  return text.length > TELEGRAM_QUESTION_MAX
    ? `${text.slice(0, TELEGRAM_QUESTION_MAX - 3)}...`
    : text;
}

/** `text` followed by `tail`, the text cut (marked) so the tail survives
 *  whole within Telegram's limit. */
function boundTextKeepingTail(text: string, tail: string): string {
  if (tail.length === 0) return boundText(text);
  const room = TELEGRAM_QUESTION_MAX - tail.length;
  if (room < 4) return boundText(`${text}${tail}`);
  return `${text.length > room ? `${text.slice(0, room - 3)}...` : text}${tail}`;
}

/** The longest button text remi sends; a longer label is cut with "...". */
const BUTTON_LABEL_MAX = 32;

/**
 * Whether any option's button would be cut (#1155). The cut used to remove
 * exactly what a standing option grants ("Yes, allow touch x.txt for this
 * session" lost "for this session"), so when it happens the message lists
 * every option's full label (`fullLabelList`) and the buttons are numbered
 * to match. Buttons stay short: a Telegram client shortens a long button on
 * its own, so a longer button would not show the whole label either.
 */
function buttonsAreCut(question: Question): boolean {
  return question.options.some((o) => decoratedLabel(o).length > BUTTON_LABEL_MAX);
}

/** The options' full labels, numbered as their buttons, for the message
 *  body; empty when no button is cut. */
function fullLabelList(question: Question): string {
  if (!buttonsAreCut(question)) return '';
  const lines = question.options.map((o, i) => `${i + 1}. ${o.label}`);
  return `\n\nOptions:\n${lines.join('\n')}`;
}

/**
 * Why a card gets no answer buttons on Telegram (#1127 review S2), or null
 * when its options can be tapped: an AskUserQuestion with several questions
 * or a multi-select (one button cannot answer it), one no phone answer can
 * be applied to (`terminalOnly`), and a plan with no text to read.
 */
function noButtonsReason(question: Question): string | null {
  if (question.terminalOnly === true) {
    return 'Answer this question in the terminal (or cancel it in the app).';
  }
  // A plan whose text is missing or blank (reached only then: a plan with
  // text takes the detail branch of `formatQuestionCard`) is never approved
  // unread either.
  if (question.kind === 'plan_approval') {
    return 'Plan text unavailable; answer in the app or the terminal.';
  }
  const steps = question.questions;
  if (
    question.kind === 'multi_question' &&
    steps !== undefined &&
    (steps.length > 1 || steps.some((s) => s.multiSelect))
  ) {
    return 'Answer in the app.';
  }
  return null;
}

/**
 * The message and buttons a question card is sent with (#1127 review S2).
 * A card about a long text (a plan to approve) carries that text below its
 * ask, so the approval is made reading it; when the text does not fit
 * Telegram's limit it is cut, the message says how much is missing, and NO
 * buttons are offered: a plan is not approved unread. A card one button
 * cannot answer (`noButtonsReason`) gets a line saying where to answer it
 * and no buttons either.
 */
export function formatQuestionCard(question: Question): TelegramQuestionCard {
  const detail = question.detail?.trim() ?? '';
  if (detail.length > 0) {
    const whole = `${question.text}\n\n${detail}${fullLabelList(question)}`;
    if (whole.length <= TELEGRAM_QUESTION_MAX) {
      return { text: whole, keyboard: formatQuestionKeyboard(question) };
    }
    // Leave room for the notice line, whose count is at most 7 digits.
    const notice = (missing: number) =>
      `\n\n[Plan truncated: ${missing} more characters. Read it and answer in the app.]`;
    const room = TELEGRAM_QUESTION_MAX - question.text.length - 2 - notice(9_999_999).length;
    const shown = detail.slice(0, Math.max(0, room));
    return {
      text: `${question.text}\n\n${shown}${notice(detail.length - shown.length)}`,
      keyboard: undefined,
    };
  }
  const reason = noButtonsReason(question);
  if (reason !== null)
    return { text: boundText(`${question.text}\n\n${reason}`), keyboard: undefined };
  return {
    text: boundTextKeepingTail(question.text, fullLabelList(question)),
    keyboard: formatQuestionKeyboard(question),
  };
}

/**
 * Format a Question with inline keyboard buttons.
 */
export function formatQuestionKeyboard(question: Question): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (question.options.length > 0) {
    // Numbered to match the message's full label list when a label is cut
    // (#1155, `fullLabelList`).
    const numbered = buttonsAreCut(question);
    question.options.forEach((option, i) => {
      const label = formatOptionLabel(option, numbered ? i + 1 : null);
      keyboard.text(label, `answer:${question.id}:${option.value}`);
    });

    // Arrange in rows (max 3 buttons per row for readability)
    // grammY automatically handles row arrangement
  } else if (question.allowsFreeText) {
    // No predefined options, just show a hint
    // User will reply with text message
  }

  return keyboard;
}

/** An option's label with its visual indicator. */
function decoratedLabel(option: QuestionOption, number: number | null = null): string {
  const label = number === null ? option.label : `${number}. ${option.label}`;
  if (option.isRecommended) return `✓ ${label}`;
  if (option.isYes) return `✅ ${label}`;
  if (option.isNo) return `❌ ${label}`;
  return label;
}

/**
 * Format an option's button text: its decorated label, numbered when the
 * message lists the full labels, cut to `BUTTON_LABEL_MAX` (the list then
 * carries the whole label, #1155).
 */
function formatOptionLabel(option: QuestionOption, number: number | null): string {
  const label = decoratedLabel(option, number);
  return label.length > BUTTON_LABEL_MAX ? `${label.slice(0, BUTTON_LABEL_MAX - 3)}...` : label;
}

/**
 * Format agent status for display.
 */
export function formatStatusText(status: AgentStatus): string {
  switch (status) {
    case 'idle':
      return '💤 Idle';
    case 'thinking':
      return '🤔 Thinking...';
    case 'executing':
      return '⚡ Executing...';
    case 'waiting':
      return '⏳ Waiting for input';
    // Session-lifecycle states (#576); evaluating/approved come only from a
    // daemon older than #1125 (DeprecatedAgentStatus).
    case 'evaluating':
      return '⏳ Evaluating…';
    case 'approved':
      return '✓ Approved';
    case 'starting':
      return '⚡ Starting';
    default:
      return status;
  }
}

/**
 * Format a question text for Telegram.
 */
export function formatQuestionText(question: Question): string {
  let text = stripTerminalCodes(question.text);

  // Add question indicator
  text = `❓ ${text.trim()}`;

  // Add hint for free text if allowed and no options. A card WITH options takes
  // a pick, not text, so it gets no "or reply with custom text" hint: the
  // parser was the only producer of allowsFreeText together with options (it
  // marked every selection box that way), and since #1140 it does not. Text
  // sent against a menu would only be ignored, with the Enter confirming "1. Yes".
  if (question.allowsFreeText && question.options.length === 0) {
    text += '\n\n💬 Reply with your answer';
  }

  return text;
}

/**
 * Format session info for /status command.
 */
export function formatSessionInfo(session: {
  topicName: string;
  workingDirectory: string;
  startedAt: string;
  status?: AgentStatus;
}): string {
  const parts = [
    `📁 Session: ${session.topicName}`,
    `📂 Directory: ${session.workingDirectory}`,
    `🕐 Started: ${formatTimestamp(session.startedAt)}`,
  ];

  if (session.status) {
    parts.push(`📊 Status: ${formatStatusText(session.status)}`);
  }

  return parts.join('\n');
}

/**
 * Format timestamp for display.
 */
function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return isoString;
  }
}

/**
 * Create welcome message for new session.
 */
export function formatWelcomeMessage(directory: string): string {
  return [
    '🚀 Session started',
    `📂 ${directory}`,
    '',
    'Send a message to talk to Claude.',
    '',
    'Use /help for available commands.',
  ].join('\n');
}

/**
 * Format help message with all available commands.
 */
export function formatHelpMessage(): string {
  return [
    '📖 Available Commands:',
    '',
    '/start [directory] - Start new session',
    '/stop - End current session',
    '/interrupt - Send Escape to Claude (interrupts its work; declines a pending prompt)',
    '/pause - Pause the session',
    '/resume - Resume paused session',
    '/status - Show session info',
    '/sessions - List all discoverable sessions',
    '/load <sessionId> - Load transcript for a session',
    '/clear - Clear and start fresh session',
    '/help - Show this help message',
    '',
    '💡 Tips:',
    '- Send any message to talk to Claude',
    '- Use /interrupt if Claude is stuck',
    '- Each topic = one Claude session',
    '- Paths can use ~ for home directory (e.g., ~/Projects/myapp)',
  ].join('\n');
}

/**
 * Format a list of discoverable sessions for Telegram display.
 */
export function formatSessionList(sessions: readonly DiscoverableSession[]): string {
  if (sessions.length === 0) {
    return 'No sessions found.';
  }

  const lines: string[] = [`Sessions (${sessions.length}):\n`];

  for (const session of sessions) {
    const statusIcon =
      session.status === 'active'
        ? '🟢'
        : session.status === 'idle'
          ? '💤'
          : session.status === 'orphaned'
            ? '🔴'
            : '✅';
    const project = path.basename(session.projectPath);
    lines.push(
      `${statusIcon} ${project} [${session.status}]`,
      `   ID: ${session.sessionId}`,
      `   Messages: ${session.messageCount}`,
      '',
    );
  }

  return lines.join('\n').trim();
}

/**
 * Format error message for Telegram.
 */
export function formatErrorMessage(error: string): string {
  return `⚠️ Error: ${error}`;
}
