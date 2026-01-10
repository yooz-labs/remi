/**
 * Output Processor - Unified processing of Claude Code terminal output.
 *
 * Combines question detection, status parsing, and message extraction
 * into a single streaming processor.
 */

import { generateId, now } from '@remi/shared';
import type { Message, Question, AgentStatus, UUID } from '@remi/shared';
import { cleanForParsing, splitLines } from './ansi.ts';
import { parseQuestion, hasQuestionIndicator } from './question-parser.ts';
import { parseStatus } from './status-parser.ts';

/** Event types emitted by the processor */
export interface OutputEvents {
  /** New message chunk received */
  onMessage: (message: Message) => void;

  /** Existing message updated (progressive output) */
  onMessageUpdate: (messageId: UUID, content: string, tool?: string) => void;

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

  private buffer: string = '';
  private currentMessageId: UUID | null = null;
  private currentMessageContent: string = '';
  private currentStatus: AgentStatus = 'idle';
  private lastUpdateTime: number = 0;
  private pendingQuestion: Question | null = null;

  constructor(config: ProcessorConfig, events: Partial<OutputEvents> = {}) {
    this.config = {
      sessionId: config.sessionId,
      updateThrottleMs: config.updateThrottleMs ?? DEFAULT_UPDATE_THROTTLE_MS,
      bufferSize: config.bufferSize ?? DEFAULT_BUFFER_SIZE,
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

    // Clean for parsing
    const cleaned = cleanForParsing(content);
    const lines = splitLines(cleaned);

    // Update current message content
    this.currentMessageContent += cleaned;

    // Detect status changes
    const statusResult = parseStatus(content);
    if (statusResult.status !== this.currentStatus) {
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

    // Emit message or update
    this.emitMessageUpdate(lines);

    this.lastUpdateTime = Date.now();
  }

  private emitMessageUpdate(lines: readonly string[]): void {
    // Determine tool from status
    const statusResult = parseStatus(this.currentMessageContent);
    const tool = statusResult.status === 'executing' ? statusResult.context : undefined;

    // Create new message if none exists
    if (this.currentMessageId === null) {
      this.currentMessageId = generateId();

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

      this.events.onMessage?.(message);
    } else {
      // Update existing message
      this.events.onMessageUpdate?.(
        this.currentMessageId,
        this.currentMessageContent,
        tool,
      );
    }
  }

  private finalizeMessage(): void {
    if (this.currentMessageId !== null) {
      // Final update with isEditing = false
      this.events.onMessageUpdate?.(
        this.currentMessageId,
        this.currentMessageContent,
        undefined,
      );
    }

    this.currentMessageId = null;
    this.currentMessageContent = '';
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
  const cleaned = cleanForParsing(output);

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
