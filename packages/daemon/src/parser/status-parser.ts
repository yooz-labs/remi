/**
 * Status Parser - Detects Claude Code agent status from output.
 *
 * Detects states:
 * - idle: Not doing anything, waiting for input
 * - thinking: Processing, analyzing, planning
 * - executing: Running a tool (bash, file edit, etc.)
 * - waiting: Asking a question, waiting for user response
 */

import type { AgentStatus } from '@remi/shared';
import { cleanForParsing } from './ansi.ts';

/** Status detection result */
export interface StatusResult {
  /** Detected status */
  readonly status: AgentStatus;

  /** Confidence 0-1 */
  readonly confidence: number;

  /** Additional context (e.g., tool name) */
  readonly context?: string;
}

/** Tool patterns for detecting executing state */
const TOOL_PATTERNS: ReadonlyArray<{ pattern: RegExp; tool: string }> = [
  { pattern: /^Reading\s+(.+)/i, tool: 'read' },
  { pattern: /^Writing\s+(.+)/i, tool: 'write' },
  { pattern: /^Editing\s+(.+)/i, tool: 'edit' },
  { pattern: /^Running\s+(.+)/i, tool: 'bash' },
  { pattern: /^\$\s+(.+)/, tool: 'bash' },
  { pattern: /^Searching\s+(.+)/i, tool: 'search' },
  { pattern: /^Fetching\s+(.+)/i, tool: 'fetch' },
  { pattern: /^Downloading\s+(.+)/i, tool: 'download' },
  { pattern: /^Installing\s+(.+)/i, tool: 'install' },
  { pattern: /^Building\s+(.+)/i, tool: 'build' },
  { pattern: /^Testing\s+(.+)/i, tool: 'test' },
  { pattern: /^Compiling\s+(.+)/i, tool: 'compile' },
  // Claude Code agent response marker (actively streaming a response)
  { pattern: /^⏺\s+(.+)/, tool: 'responding' },
];

/** Thinking indicators */
const THINKING_PATTERNS: readonly RegExp[] = [
  /^thinking\.\.\./i,
  /^analyzing/i,
  /^planning/i,
  /^considering/i,
  /^let me think/i,
  /^processing/i,
  /^examining/i,
  /^reviewing/i,
  // Claude Code uses funny verb animations: Germinating..., Seasoning..., etc.
  // Generic pattern: spinner + word ending in "ing" + "..." or "..."
  /[✳✢·✶✻\*]\s*\w+ing\.{2,}/i,
  /[✳✢·✶✻\*]\s*\w+ing…/i,
  /\w+ing\.\.\.\s*\(esc to interrupt/i,
  // Claude Code thinking indicator with parenthetical
  /\w+ing…\s*\(thinking\)/i,
  // Bare spinner characters followed by any word
  /^[✳✢]\s*$/,
];

/** Waiting indicators (question or input prompt).
 *
 * A bare trailing `?` is deliberately NOT here: prose ending in `?` is not a
 * prompt (it was a false-positive source). Claude's own prompts are matched by
 * the selection-box chrome; the remaining patterns catch subprocess prompts. */
const WAITING_PATTERNS: readonly RegExp[] = [
  // Claude Code selection-box chrome (❯ cursor on a numbered option); spacing
  // collapses after ANSI stripping, kept single-line via [^\S\n].
  /❯[^\S\n]*\d+[.)]/,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /waiting for/i,
  /enter your/i,
  /please (type|enter|provide)/i,
  /what would you like/i,
];

/** Idle indicators (task complete, ready for input) */
const IDLE_PATTERNS: readonly RegExp[] = [
  /^done\.?$/i,
  /^complete\.?$/i,
  /^finished\.?$/i,
  /^ready\.?$/i,
  /task completed/i,
  /successfully/i,
  /^\>\s*$/, // Empty prompt
  /^❯\s*$/, // Claude Code prompt (empty)
  /❯\s*$/, // Claude Code prompt at end of line
];

/**
 * Parse output to detect agent status.
 *
 * @param rawOutput - Raw terminal output
 * @returns Status detection result
 */
export function parseStatus(rawOutput: string): StatusResult {
  const text = cleanForParsing(rawOutput);

  // Empty output suggests idle
  if (text.trim().length === 0) {
    return { status: 'idle', confidence: 0.3 };
  }

  // Try detecting in order of specificity

  // 1. Check for tool execution (most specific)
  const toolResult = detectToolExecution(text);
  if (toolResult) {
    return toolResult;
  }

  // 2. Check for waiting/question state
  const waitingResult = detectWaiting(text);
  if (waitingResult) {
    return waitingResult;
  }

  // 3. Check for thinking state
  const thinkingResult = detectThinking(text);
  if (thinkingResult) {
    return thinkingResult;
  }

  // 4. Check for idle state
  const idleResult = detectIdle(text);
  if (idleResult) {
    return idleResult;
  }

  // Default: assume idle if no specific pattern matched
  // This is more conservative - only show "thinking" when we're confident
  return {
    status: 'idle',
    confidence: 0.3,
  };
}

/** Detect tool execution */
function detectToolExecution(text: string): StatusResult | null {
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    for (const { pattern, tool } of TOOL_PATTERNS) {
      const match = pattern.exec(trimmed);
      if (match) {
        return {
          status: 'executing',
          confidence: 0.85,
          context: tool,
        };
      }
    }
  }

  return null;
}

/** Detect waiting state */
function detectWaiting(text: string): StatusResult | null {
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1]?.trim() ?? '';

  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(lastLine) || pattern.test(text)) {
      return {
        status: 'waiting',
        confidence: 0.8,
      };
    }
  }

  return null;
}

/** Detect thinking state */
function detectThinking(text: string): StatusResult | null {
  for (const pattern of THINKING_PATTERNS) {
    if (pattern.test(text)) {
      return {
        status: 'thinking',
        confidence: 0.75,
      };
    }
  }

  return null;
}

/** Detect idle state */
function detectIdle(text: string): StatusResult | null {
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1]?.trim() ?? '';

  for (const pattern of IDLE_PATTERNS) {
    if (pattern.test(lastLine)) {
      return {
        status: 'idle',
        confidence: 0.7,
      };
    }
  }

  return null;
}

/**
 * Extract tool name from status context.
 * Returns undefined if not executing a tool.
 */
export function getToolFromStatus(result: StatusResult): string | undefined {
  if (result.status === 'executing') {
    return result.context;
  }
  return undefined;
}

/**
 * Simple check for whether output indicates activity.
 */
export function isActive(rawOutput: string): boolean {
  const result = parseStatus(rawOutput);
  return result.status !== 'idle';
}
