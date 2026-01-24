/**
 * Core types for Remi messaging protocol.
 *
 * Design principles:
 * - Every message has a unique ID for deduplication
 * - Every message has delivery states (like WhatsApp)
 * - Messages can be edited (agent updates progressively)
 * - All timestamps are ISO 8601 strings for serialization
 */

/** Unique identifier for messages, sessions, etc. */
export type UUID = string;

/** ISO 8601 timestamp string */
export type Timestamp = string;

/** Message delivery states (like WhatsApp checkmarks) */
export type MessageState = 'sending' | 'sent' | 'delivered' | 'read';

/** Who sent the message */
export type MessageSender = 'agent' | 'user' | 'system';

/** Agent status while working */
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting';

/**
 * Core message type.
 * Immutable after creation except for state transitions and edits.
 */
export interface Message {
  /** Unique message ID (UUID v4) */
  readonly id: UUID;

  /** Session this message belongs to */
  readonly sessionId: UUID;

  /** Who sent this message */
  readonly sender: MessageSender;

  /** Message content (may be updated via edits) */
  content: string;

  /** When the message was created */
  readonly createdAt: Timestamp;

  /** Current delivery state */
  state: MessageState;

  /** When state last changed */
  stateChangedAt: Timestamp;

  /** If edited, when was the last edit */
  editedAt?: Timestamp | undefined;

  /** Is the agent still working on this message */
  isEditing: boolean;

  /** Tool being used (e.g., "Reading file.txt") */
  tool?: string | undefined;
}

/** Bullet point type detected in message content */
export type BulletType = 'dash' | 'asterisk' | 'bullet' | 'numbered';

/**
 * A bullet point extracted from message content.
 * Used for tracking and deduplication across edits.
 */
export interface Bullet {
  /** Session-scoped sequential ID (starts at 1) */
  readonly bulletId: number;

  /** Text content of the bullet (without the marker) */
  readonly content: string;

  /** Type of bullet marker used */
  readonly type: BulletType;

  /** For numbered bullets, the original number (e.g., "1", "2") */
  readonly originalNumber?: string | undefined;

  /** Start line index within the message content (0-based) */
  readonly startLine: number;

  /** End line index inclusive (for multi-line bullets with code blocks) */
  readonly endLine: number;

  /** Whether this bullet contains a code block */
  readonly hasCodeBlock: boolean;

  /** Whether content was truncated (full content available via expand request) */
  readonly isTruncated?: boolean | undefined;

  /** Full content length in bytes (present only if truncated) */
  readonly fullLength?: number | undefined;
}

/**
 * A message with structured bullet information.
 * Extends Message with parsed bullet data for tracking edits.
 */
export interface StructuredMessage extends Message {
  /** Extracted bullets from content */
  readonly bullets: readonly Bullet[];

  /** First bullet ID in this message (for quick reference) */
  readonly firstBulletId?: number | undefined;

  /** Last bullet ID in this message */
  readonly lastBulletId?: number | undefined;
}

/**
 * Acknowledgment sent when message is received/read.
 */
export interface Acknowledgment {
  /** ID of the message being acknowledged */
  readonly messageId: UUID;

  /** New state being acknowledged */
  readonly state: 'delivered' | 'read';

  /** When this ack was created */
  readonly timestamp: Timestamp;
}

/**
 * Question detected in agent output.
 * Parsed from Claude Code's output patterns.
 */
export interface Question {
  /** Unique ID for this question */
  readonly id: UUID;

  /** The question text */
  readonly text: string;

  /** Available options (if any) */
  readonly options: readonly QuestionOption[];

  /** Can user type free-form response */
  readonly allowsFreeText: boolean;

  /** Has this question been answered */
  isAnswered: boolean;

  /** The answer that was given (if answered) */
  answer?: string | undefined;
}

/**
 * Option for a question (e.g., Yes/No, numbered choices).
 */
export interface QuestionOption {
  /** Display label */
  readonly label: string;

  /** Value to send to agent */
  readonly value: string;

  /** Is this the recommended option */
  readonly isRecommended: boolean;

  /** Is this a "yes" type answer */
  readonly isYes: boolean;

  /** Is this a "no" type answer */
  readonly isNo: boolean;
}

/**
 * Claude Code session being monitored.
 */
export interface Session {
  /** Unique session ID */
  readonly id: UUID;

  /** Session name (derived from command or project) */
  name: string;

  /** When session started */
  readonly startedAt: Timestamp;

  /** When session ended (if ended) */
  endedAt?: Timestamp | undefined;

  /** Current agent status */
  status: AgentStatus;

  /** Current pending question (if any) */
  pendingQuestion?: Question | undefined;

  /** Is session still active */
  isActive: boolean;
}

/**
 * Connection info for establishing peer connection.
 */
export interface ConnectionInfo {
  /** Connection code (e.g., "AXBY-1234") */
  readonly code: string;

  /** Direct addresses if available */
  readonly directAddresses: readonly string[];

  /** When this connection info expires */
  readonly expiresAt: Timestamp;
}

/**
 * Result type for operations that can fail.
 * Prefer this over throwing exceptions for expected failures.
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Create a successful result */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Create a failed result */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Check if result is successful */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Check if result is failed */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/** How a session was discovered */
export type SessionSource = 'daemon' | 'transcript';

/** Session status for discovery */
export type DiscoverableSessionStatus = 'active' | 'idle' | 'orphaned' | 'completed';

/**
 * A session visible through the discovery mechanism.
 * Combines daemon-managed sessions and externally-discovered transcript files.
 */
export interface DiscoverableSession {
  /** Session ID (daemon UUID or Claude Code session ID from transcript path) */
  readonly sessionId: string;

  /** Project path this session is working in */
  readonly projectPath: string;

  /** Current session status */
  readonly status: DiscoverableSessionStatus;

  /** When the session was last active */
  readonly lastActivity: Timestamp;

  /** Number of messages in the session */
  readonly messageCount: number;

  /** Model being used (if known) */
  readonly model?: string | undefined;

  /** Preview of the last message (truncated) */
  readonly lastMessage?: string | undefined;

  /** How this session was discovered */
  readonly source: SessionSource;

  /** Whether this session can be attached to (daemon-managed only) */
  readonly canAttach: boolean;
}
