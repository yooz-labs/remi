/**
 * Output Processor - Unified processing of Claude Code terminal output.
 *
 * Combines question detection, status parsing, and message extraction
 * into a single streaming processor.
 */

import { generateId, now } from '@remi/shared';
import type { AgentStatus, Message, Question, UUID } from '@remi/shared';
import {
  cleanAndFilterOutput,
  cleanForParsing,
  cleanMessageLine,
  detectMessageBoundary,
  splitLines,
} from './ansi.ts';
import { hasQuestionIndicator, parseQuestion } from './question-parser.ts';
import { parseStatus } from './status-parser.ts';

/** Event types emitted by the processor */
export interface OutputEvents {
  /** New message chunk received */
  onMessage: (message: Message) => void;

  /** Existing message updated (progressive output) */
  onMessageUpdate: (messageId: UUID, content: string, tool?: string) => void;

  /** Message is finalized (no longer editing) */
  onMessageFinalized: (messageId: UUID) => void;

  /** Question detected */
  onQuestion: (question: Question) => void;

  /** Status changed */
  onStatusChange: (status: AgentStatus, context?: string) => void;
}

/** Processor configuration */
export interface ProcessorConfig {
  /** Session ID for created messages */
  readonly sessionId: UUID;

  /** Minimum time between message updates (ms) */
  readonly updateThrottleMs?: number;

  /** Buffer size before forcing message creation */
  readonly bufferSize?: number;

  /** If true, only emit status and question events (no message content).
   * Used in two-phase delivery mode where transcript provides clean content. */
  readonly streamStatusOnly?: boolean;
}

const DEFAULT_UPDATE_THROTTLE_MS = 50;
const DEFAULT_BUFFER_SIZE = 4096;

/**
 * Processes terminal output and emits structured events.
 *
 * Handles:
 * - Buffering partial output
 * - Detecting message boundaries
 * - Parsing questions and status
 * - Progressive updates for long outputs
 */
export class OutputProcessor {
  private readonly config: Required<ProcessorConfig>;
  private readonly events: Partial<OutputEvents>;

  private buffer = '';
  private currentMessageId: UUID | null = null;
  private currentMessageContent = '';
  private currentStatus: AgentStatus = 'idle';
  private lastUpdateTime = 0;
  private pendingQuestion: Question | null = null;
  private seenContent: Set<string> = new Set(); // Track unique content chunks
  private hasEmittedCurrentMessage = false; // Track if onMessage was called for currentMessageId

  constructor(config: ProcessorConfig, events: Partial<OutputEvents> = {}) {
    this.config = {
      sessionId: config.sessionId,
      updateThrottleMs: config.updateThrottleMs ?? DEFAULT_UPDATE_THROTTLE_MS,
      bufferSize: config.bufferSize ?? DEFAULT_BUFFER_SIZE,
      streamStatusOnly: config.streamStatusOnly ?? false,
    };
    this.events = events;
  }

  /**
   * Process a chunk of terminal output.
   *
   * @param rawData - Raw output data (may contain ANSI codes)
   */
  process(rawData: string): void {
    this.buffer += rawData;

    // Check if we should process the buffer
    if (this.shouldProcess()) {
      this.processBuffer();
    }
  }

  /**
   * Flush any remaining buffered content.
   * Call when session ends or after timeout.
   */
  flush(): void {
    if (this.buffer.length > 0) {
      this.processBuffer();
    }

    // Finalize current message
    if (this.currentMessageId !== null) {
      this.finalizeMessage();
    }
  }

  /**
   * Reset processor state.
   */
  reset(): void {
    this.buffer = '';
    this.currentMessageId = null;
    this.currentMessageContent = '';
    this.currentStatus = 'idle';
    this.lastUpdateTime = 0;
    this.pendingQuestion = null;
    this.seenContent.clear();
    this.hasEmittedCurrentMessage = false;
  }

  /** Get current accumulated content */
  get currentContent(): string {
    return this.currentMessageContent;
  }

  /** Get current status */
  get status(): AgentStatus {
    return this.currentStatus;
  }

  /** Check if there's a pending question */
  get hasPendingQuestion(): boolean {
    return this.pendingQuestion !== null;
  }

  private shouldProcess(): boolean {
    // Always process if buffer is large
    if (this.buffer.length >= this.config.bufferSize) {
      return true;
    }

    // Process if we have a complete line
    if (this.buffer.includes('\n')) {
      return true;
    }

    // Process if enough time has passed
    const timeSinceUpdate = Date.now() - this.lastUpdateTime;
    if (timeSinceUpdate >= this.config.updateThrottleMs && this.buffer.length > 0) {
      return true;
    }

    return false;
  }

  private processBuffer(): void {
    const content = this.buffer;
    this.buffer = '';

    // First, strip ANSI codes
    const cleaned = cleanForParsing(content);
    const rawLines = splitLines(cleaned);

    // Detect status changes from raw content.
    // Only update status if the new detection has reasonable confidence;
    // low-confidence defaults (0.3) should not overwrite real status.
    const statusResult = parseStatus(content);
    if (statusResult.status !== this.currentStatus && statusResult.confidence >= 0.5) {
      this.currentStatus = statusResult.status;
      this.events.onStatusChange?.(statusResult.status, statusResult.context);
    }

    // Check for questions
    if (hasQuestionIndicator(content)) {
      const parseResult = parseQuestion(content);
      if (parseResult.detected && parseResult.question) {
        this.pendingQuestion = parseResult.question;
        this.events.onQuestion?.(parseResult.question);
      }
    }

    // Process lines and detect message boundaries
    for (const rawLine of rawLines) {
      const boundary = detectMessageBoundary(rawLine);

      if (boundary === 'agent') {
        // New agent message boundary - finalize current message first
        if (this.currentMessageContent.trim().length > 0) {
          this.finalizeMessage();
        }

        // Start new message - ALWAYS set the ID so subsequent lines can be appended
        this.currentMessageId = generateId();
        this.hasEmittedCurrentMessage = false;
        const cleanedLine = cleanMessageLine(rawLine);

        // Extract tool name before filtering (for tool execution lines like "Bash(date)")
        const tool = this.extractToolName(cleanedLine);

        // Filter and deduplicate the content
        const filteredLine = cleanAndFilterOutput(cleanedLine);
        if (filteredLine.trim().length > 0) {
          const newContent = this.deduplicateContent(filteredLine);
          if (newContent.length > 0) {
            this.currentMessageContent = newContent;

            // Emit as new message
            const message: Message = {
              id: this.currentMessageId,
              sessionId: this.config.sessionId,
              sender: 'agent',
              content: this.currentMessageContent,
              createdAt: now(),
              state: 'sent',
              stateChangedAt: now(),
              isEditing: true,
              tool,
            };
            if (!this.config.streamStatusOnly) {
              this.events.onMessage?.(message);
            }
            this.hasEmittedCurrentMessage = true;
          }
        }
        // Note: Even if filteredLine is empty (tool execution line filtered out),
        // currentMessageId is now set, so subsequent content lines will be appended.
      } else if (boundary === 'tool_output') {
        const filteredLine = cleanAndFilterOutput(rawLine);
        const contentLine = cleanMessageLine(filteredLine);
        if (contentLine.trim().length > 0) {
          if (this.currentMessageId === null) {
            this.appendContentLine(contentLine);
            this.finalizeMessage();
          } else {
            this.appendContentLine(contentLine);
          }
        }
      } else if (boundary === 'user' || boundary === 'thinking') {
      } else {
        // Continuation of current message
        const filteredLine = cleanAndFilterOutput(rawLine);
        if (filteredLine.trim().length > 0 && this.currentMessageId !== null) {
          this.appendContentLine(filteredLine);
        }
      }
    }

    this.lastUpdateTime = Date.now();
  }

  /**
   * Extract tool name from a line like "Bash(date)" or "Read(file.ts)"
   */
  private extractToolName(line: string): string | undefined {
    const match = line.match(/^(\w+)\(/);
    return match ? match[1] : undefined;
  }

  private appendContentLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    const newContent = this.deduplicateContent(line);
    if (newContent.length === 0) {
      return;
    }

    if (this.currentMessageId === null) {
      this.currentMessageId = generateId();
      this.currentMessageContent = newContent;
      this.emitMessageUpdate([]);
      return;
    }

    this.currentMessageContent += `\n${newContent}`;
    this.emitMessageUpdate([]);
  }

  private emitMessageUpdate(_lines: readonly string[]): void {
    // Determine tool from status
    const statusResult = parseStatus(this.currentMessageContent);
    const tool = statusResult.status === 'executing' ? statusResult.context : undefined;

    // Create new message if we haven't emitted one yet for current ID
    if (!this.hasEmittedCurrentMessage) {
      // Ensure we have a message ID
      if (this.currentMessageId === null) {
        this.currentMessageId = generateId();
      }

      const message: Message = {
        id: this.currentMessageId,
        sessionId: this.config.sessionId,
        sender: 'agent',
        content: this.currentMessageContent,
        createdAt: now(),
        state: 'sent',
        stateChangedAt: now(),
        isEditing: true,
        tool,
      };

      if (!this.config.streamStatusOnly) {
        this.events.onMessage?.(message);
      }
      this.hasEmittedCurrentMessage = true;
    } else {
      // Update existing message
      if (!this.config.streamStatusOnly) {
        if (this.currentMessageId) {
          this.events.onMessageUpdate?.(this.currentMessageId, this.currentMessageContent, tool);
        }
      }
    }
  }

  private finalizeMessage(): void {
    if (this.currentMessageId !== null) {
      // Final update with isEditing = false
      if (!this.config.streamStatusOnly) {
        this.events.onMessageUpdate?.(this.currentMessageId, this.currentMessageContent, undefined);
        this.events.onMessageFinalized?.(this.currentMessageId);
      }
    }

    this.currentMessageId = null;
    this.currentMessageContent = '';
    this.hasEmittedCurrentMessage = false;
  }

  /**
   * Deduplicate content by tracking seen chunks.
   * Returns only the truly new content that hasn't been seen before.
   */
  private deduplicateContent(content: string): string {
    const lines = content.split('\n');
    const newLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      // Create a normalized key for comparison (ignore whitespace variations)
      const key = trimmed.toLowerCase().replace(/\s+/g, ' ');

      // Skip if we've seen this content before
      if (this.seenContent.has(key)) {
        continue;
      }

      // Mark as seen and add to output
      this.seenContent.add(key);
      newLines.push(line);
    }

    return newLines.join('\n');
  }
}

/**
 * Create a simple processor for one-shot parsing.
 * Useful for testing or processing complete output.
 */
export function processOutput(
  sessionId: UUID,
  output: string,
): { message: Message; question?: Question | undefined; status: AgentStatus } {
  const cleaned = cleanAndFilterOutput(output);

  // Parse question
  const parseResult = parseQuestion(output);
  const question = parseResult.detected ? parseResult.question : undefined;

  // Parse status
  const statusResult = parseStatus(output);
  const tool = statusResult.status === 'executing' ? statusResult.context : undefined;

  // Create message
  const message: Message = {
    id: generateId(),
    sessionId,
    sender: 'agent',
    content: cleaned,
    createdAt: now(),
    state: 'sent',
    stateChangedAt: now(),
    isEditing: false,
    tool,
  };

  return {
    message,
    question,
    status: statusResult.status,
  };
}
