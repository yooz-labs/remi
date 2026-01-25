/**
 * Telegram UI formatting utilities.
 *
 * Formats Remi messages, questions, and status for Telegram display.
 * Uses Telegram's MarkdownV2 formatting where appropriate.
 */

import type { AgentStatus, Message, Question, QuestionOption } from '@remi/shared';
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

/**
 * Format a Question with inline keyboard buttons.
 */
export function formatQuestionKeyboard(question: Question): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (question.options.length > 0) {
    // Add buttons for each option
    for (const option of question.options) {
      const label = formatOptionLabel(option);
      keyboard.text(label, `answer:${question.id}:${option.value}`);
    }

    // Arrange in rows (max 3 buttons per row for readability)
    // grammY automatically handles row arrangement
  } else if (question.allowsFreeText) {
    // No predefined options, just show a hint
    // User will reply with text message
  }

  return keyboard;
}

/**
 * Format an option label for display.
 */
function formatOptionLabel(option: QuestionOption): string {
  let label = option.label;

  // Add visual indicators
  if (option.isRecommended) {
    label = `✓ ${label}`;
  } else if (option.isYes) {
    label = `✅ ${label}`;
  } else if (option.isNo) {
    label = `❌ ${label}`;
  }

  // Truncate long labels (Telegram button text limit)
  if (label.length > 32) {
    label = `${label.slice(0, 29)}...`;
  }

  return label;
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

  // Add hint for free text if allowed and no options
  if (question.allowsFreeText && question.options.length === 0) {
    text += '\n\n💬 Reply with your answer';
  } else if (question.allowsFreeText && question.options.length > 0) {
    text += '\n\n💬 Or reply with custom text';
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
    '/interrupt - Send Esc to Claude (cancel current action)',
    '/pause - Pause the session',
    '/resume - Resume paused session',
    '/status - Show session info',
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
 * Format error message for Telegram.
 */
export function formatErrorMessage(error: string): string {
  return `⚠️ Error: ${error}`;
}
