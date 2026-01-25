/**
 * Telegram UI formatting utilities.
 *
 * Formats Remi messages, questions, and status for Telegram display.
 * Uses Telegram's MarkdownV2 formatting where appropriate.
 */

import type {
  AgentStatus,
  DiscoverableSession,
  Message,
  Question,
  QuestionOption,
  TranscriptContentMessage,
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
    '📂 Session Management:',
    '/start [directory] - Start new session',
    '/stop - End current session',
    '/sessions - List all discoverable sessions',
    '/attach <id> - Attach to existing session',
    '/detach - Detach without ending session',
    '',
    '⚙️ Session Control:',
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
    '- Use /detach to keep session alive when switching devices',
  ].join('\n');
}

/**
 * Format error message for Telegram.
 */
export function formatErrorMessage(error: string): string {
  return `⚠️ Error: ${error}`;
}

/**
 * Format a list of discoverable sessions for Telegram display.
 */
export function formatSessionListForTelegram(sessions: readonly DiscoverableSession[]): string {
  if (sessions.length === 0) {
    return ['📭 No sessions found.', '', 'Use /start [directory] to create a new session.'].join(
      '\n',
    );
  }

  const parts: string[] = ['📋 Available Sessions:', ''];

  // Show up to 10 sessions for readability
  const displayCount = Math.min(sessions.length, 10);
  for (let i = 0; i < displayCount; i++) {
    const session = sessions[i];
    if (session) {
      parts.push(formatDiscoverableSessionForTelegram(session, i + 1));
      parts.push(''); // Empty line between sessions
    }
  }

  if (sessions.length > 10) {
    parts.push(`... and ${sessions.length - 10} more sessions`);
    parts.push('');
  }

  parts.push('Use /attach <session-id> to connect to a session.');

  return parts.join('\n');
}

/**
 * Format a single discoverable session for Telegram display.
 */
export function formatDiscoverableSessionForTelegram(
  session: DiscoverableSession,
  index: number,
): string {
  const statusEmoji: Record<string, string> = {
    active: '🟢',
    idle: '🟡',
    orphaned: '🟠',
    completed: '⚫',
  };

  const emoji = statusEmoji[session.status] ?? '⚪';
  const sourceLabel = session.source === 'daemon' ? 'daemon' : 'transcript';
  const attachLabel = session.canAttach ? '' : ' [view-only]';

  // Truncate path for display, keeping the end (most relevant part)
  let pathDisplay = session.projectPath;
  if (pathDisplay.length > 35) {
    pathDisplay = `...${pathDisplay.slice(-32)}`;
  }

  const lines = [
    `${index}. ${emoji} ${pathDisplay}`,
    `   ID: ${session.sessionId.slice(0, 8)}... (${sourceLabel})${attachLabel}`,
  ];

  // Add last message preview if available
  if (session.lastMessage) {
    let preview = session.lastMessage.slice(0, 40);
    if (session.lastMessage.length > 40) {
      preview += '...';
    }
    lines.push(`   Last: ${preview}`);
  }

  // Add message count if available
  if (session.messageCount !== undefined && session.messageCount > 0) {
    lines.push(`   Messages: ${session.messageCount}`);
  }

  return lines.join('\n');
}

/**
 * Format TranscriptContentMessage for Telegram display.
 * Handles structured content with proper truncation.
 */
export function formatTranscriptContentForTelegram(message: TranscriptContentMessage): string {
  const parts: string[] = [];

  // Header with metadata for assistant messages
  if (message.role === 'assistant') {
    const headerParts: string[] = [];
    if (message.model) {
      // Extract short model name (e.g., "opus-4-5" from "claude-opus-4-5-20251101")
      const modelShort = message.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      headerParts.push(`Model: ${modelShort}`);
    }
    if (message.tools && message.tools.length > 0) {
      headerParts.push(`Tools: ${message.tools.join(', ')}`);
    }
    if (headerParts.length > 0) {
      parts.push(`[${headerParts.join(' | ')}]`);
    }
  } else {
    parts.push('[User]');
  }

  // Add content
  let content = message.content;

  // Strip any terminal codes that might have made it through
  content = stripTerminalCodes(content);

  // Calculate available space for content (4000 limit minus header and footer buffer)
  const headerLength = parts.join('\n').length;
  const footerBuffer = 50; // Space for truncation notice
  const availableChars = 4000 - headerLength - footerBuffer;

  if (content.length > availableChars) {
    content = `${content.slice(0, availableChars - 25)}\n\n[... content truncated]`;
  }

  parts.push(content);

  return parts.join('\n');
}
