/**
 * Messaging protocol for Remi.
 *
 * All messages are JSON-encoded with a type discriminator.
 * Binary data (if any) is base64 encoded.
 *
 * Protocol guarantees:
 * - Every message has a unique ID
 * - Every message gets an acknowledgment
 * - Messages are ordered within a session
 * - Duplicates are detected and ignored (but still acked)
 */

import type {
  Acknowledgment,
  AgentStatus,
  Message,
  Question,
  Session,
  StructuredMessage,
  Timestamp,
  UUID,
} from './types.ts';

/** Generate a UUID v4 (browser and Node compatible) */
export function generateId(): UUID {
  // Use native crypto.randomUUID if available (Node 16+, modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID() as UUID;
  }

  // Fallback for older browsers using crypto.getRandomValues
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Last resort: Math.random (not cryptographically secure, but works)
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Set version (4) and variant bits
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // Variant 10

  // Convert to hex string with hyphens
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as UUID;
}

/** Get current timestamp as ISO string */
export function now(): Timestamp {
  return new Date().toISOString();
}

/**
 * Protocol message types.
 * Discriminated union for type-safe message handling.
 */
export type ProtocolMessage =
  | HelloMessage
  | HelloAckMessage
  | AgentOutputMessage
  | StructuredAgentOutputMessage
  | UserInputMessage
  | AckMessage
  | EditMessage
  | QuestionMessage
  | AnswerMessage
  | SessionUpdateMessage
  | PingMessage
  | PongMessage
  | ErrorMessage
  | ReplayBatchMessage
  | BulletExpandRequestMessage
  | BulletExpandResponseMessage;

/** Client hello - initiates connection */
export interface HelloMessage {
  readonly type: 'hello';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly clientVersion: string;
  readonly clientId: UUID;
  /** Working directory for the Claude Code session (optional) */
  readonly directory?: string;
  /** Session ID to resume (optional, for reconnecting to existing session) */
  readonly resumeSessionId?: UUID | undefined;
  /** Index of last received message (for efficient replay) */
  readonly lastReceivedIndex?: number | undefined;
}

/** Server hello ack - confirms connection */
export interface HelloAckMessage {
  readonly type: 'hello_ack';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly serverVersion: string;
  readonly sessionId: UUID;
  /** Whether this is a resumed session */
  readonly isResume?: boolean | undefined;
  /** Number of messages to be replayed (if resume) */
  readonly replayCount?: number | undefined;
  /** Next bullet ID for continuation (if resume) */
  readonly nextBulletId?: number | undefined;
}

/** Agent output - message from Claude */
export interface AgentOutputMessage {
  readonly type: 'agent_output';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly message: Message;
}

/** Agent output with structured bullet information */
export interface StructuredAgentOutputMessage {
  readonly type: 'structured_agent_output';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly message: StructuredMessage;
  /** Which bullet IDs changed (for updates) */
  readonly changedBulletIds?: readonly number[] | undefined;
  /** Whether this is an update to an existing message */
  readonly isUpdate: boolean;
}

/** User input - message from user */
export interface UserInputMessage {
  readonly type: 'user_input';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly sessionId: UUID;
  readonly content: string;
}

/** Acknowledgment */
export interface AckMessage {
  readonly type: 'ack';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly ack: Acknowledgment;
}

/** Edit an existing message */
export interface EditMessage {
  readonly type: 'edit';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly messageId: UUID;
  readonly newContent: string;
  readonly isEditing: boolean;
  readonly tool?: string | undefined;
}

/** Question detected */
export interface QuestionMessage {
  readonly type: 'question';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly question: Question;
}

/** Answer to a question */
export interface AnswerMessage {
  readonly type: 'answer';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly questionId: UUID;
  readonly answer: string;
}

/** Session state update */
export interface SessionUpdateMessage {
  readonly type: 'session_update';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly session: Session;
}

/** Keep-alive ping */
export interface PingMessage {
  readonly type: 'ping';
  readonly id: UUID;
  readonly timestamp: Timestamp;
}

/** Keep-alive pong */
export interface PongMessage {
  readonly type: 'pong';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly pingId: UUID;
}

/** Error message */
export interface ErrorMessage {
  readonly type: 'error';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}

/** Batch of messages to replay on session resume */
export interface ReplayBatchMessage {
  readonly type: 'replay_batch';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly sessionId: UUID;
  /** Messages to replay */
  readonly messages: readonly ProtocolMessage[];
  /** Whether this is the last batch (all messages replayed) */
  readonly isComplete: boolean;
}

/** Request to expand a truncated bullet */
export interface BulletExpandRequestMessage {
  readonly type: 'bullet_expand_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly sessionId: UUID;
  /** The bullet ID to expand */
  readonly bulletId: number;
}

/** Response with full bullet content */
export interface BulletExpandResponseMessage {
  readonly type: 'bullet_expand_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** The bullet ID this responds to */
  readonly bulletId: number;
  /** Full untruncated content of the bullet */
  readonly fullContent: string;
  /** ID of the request message this responds to */
  readonly requestId: UUID;
}

/**
 * Serialize a protocol message to JSON string.
 * Throws if message is invalid.
 */
export function serialize(message: ProtocolMessage): string {
  return JSON.stringify(message);
}

/**
 * Deserialize a JSON string to protocol message.
 * Returns null if parsing fails or message is invalid.
 */
export function deserialize(data: string): ProtocolMessage | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isValidMessage(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Type guard to check if parsed JSON is a valid protocol message.
 */
function isValidMessage(value: unknown): value is ProtocolMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // Must have type, id, timestamp
  if (typeof obj['type'] !== 'string') return false;
  if (typeof obj['id'] !== 'string') return false;
  if (typeof obj['timestamp'] !== 'string') return false;

  // Validate by type
  const validTypes = [
    'hello',
    'hello_ack',
    'agent_output',
    'structured_agent_output',
    'user_input',
    'ack',
    'edit',
    'question',
    'answer',
    'session_update',
    'ping',
    'pong',
    'error',
    'replay_batch',
    'bullet_expand_request',
    'bullet_expand_response',
  ];

  return validTypes.includes(obj['type'] as string);
}

/**
 * Create a hello message.
 */
export function createHello(
  clientId: UUID,
  clientVersion: string,
  directory?: string,
  resumeSessionId?: UUID,
  lastReceivedIndex?: number,
): HelloMessage {
  return {
    type: 'hello',
    id: generateId(),
    timestamp: now(),
    clientVersion,
    clientId,
    ...(directory && { directory }),
    ...(resumeSessionId && { resumeSessionId }),
    ...(lastReceivedIndex !== undefined && { lastReceivedIndex }),
  };
}

/**
 * Create a hello ack message.
 */
export function createHelloAck(
  serverVersion: string,
  sessionId: UUID,
  resumeInfo?: { isResume: boolean; replayCount: number; nextBulletId: number },
): HelloAckMessage {
  return {
    type: 'hello_ack',
    id: generateId(),
    timestamp: now(),
    serverVersion,
    sessionId,
    ...(resumeInfo && {
      isResume: resumeInfo.isResume,
      replayCount: resumeInfo.replayCount,
      nextBulletId: resumeInfo.nextBulletId,
    }),
  };
}

/**
 * Create an agent output message.
 */
export function createAgentOutput(message: Message): AgentOutputMessage {
  return {
    type: 'agent_output',
    id: generateId(),
    timestamp: now(),
    message,
  };
}

/**
 * Create a structured agent output message with bullet information.
 */
export function createStructuredAgentOutput(
  message: StructuredMessage,
  isUpdate: boolean,
  changedBulletIds?: readonly number[],
): StructuredAgentOutputMessage {
  return {
    type: 'structured_agent_output',
    id: generateId(),
    timestamp: now(),
    message,
    isUpdate,
    changedBulletIds,
  };
}

/**
 * Create a user input message.
 */
export function createUserInput(sessionId: UUID, content: string): UserInputMessage {
  return {
    type: 'user_input',
    id: generateId(),
    timestamp: now(),
    sessionId,
    content,
  };
}

/**
 * Create an acknowledgment message.
 */
export function createAck(ack: Acknowledgment): AckMessage {
  return {
    type: 'ack',
    id: generateId(),
    timestamp: now(),
    ack,
  };
}

/**
 * Create an edit message.
 */
export function createEdit(
  messageId: UUID,
  newContent: string,
  isEditing: boolean,
  tool?: string,
): EditMessage {
  return {
    type: 'edit',
    id: generateId(),
    timestamp: now(),
    messageId,
    newContent,
    isEditing,
    tool,
  };
}

/**
 * Create a ping message.
 */
export function createPing(): PingMessage {
  return {
    type: 'ping',
    id: generateId(),
    timestamp: now(),
  };
}

/**
 * Create a pong message.
 */
export function createPong(pingId: UUID): PongMessage {
  return {
    type: 'pong',
    id: generateId(),
    timestamp: now(),
    pingId,
  };
}

/**
 * Create an error message.
 */
export function createError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorMessage {
  return {
    type: 'error',
    id: generateId(),
    timestamp: now(),
    code,
    message,
    details,
  };
}

/**
 * Create a question message.
 */
export function createQuestion(question: Question): QuestionMessage {
  return {
    type: 'question',
    id: generateId(),
    timestamp: now(),
    question,
  };
}

/**
 * Create a session update message.
 */
export function createSessionUpdate(
  sessionId: UUID,
  status: AgentStatus,
  statusContext?: string,
): SessionUpdateMessage {
  // Create minimal session object for status update
  const session: Session = {
    id: sessionId,
    name: '',
    startedAt: now(),
    status,
    isActive: status !== 'idle',
  };
  return {
    type: 'session_update',
    id: generateId(),
    timestamp: now(),
    session,
  };
}

/**
 * Create a replay batch message for session resume.
 */
export function createReplayBatch(
  sessionId: UUID,
  messages: readonly ProtocolMessage[],
  isComplete: boolean,
): ReplayBatchMessage {
  return {
    type: 'replay_batch',
    id: generateId(),
    timestamp: now(),
    sessionId,
    messages,
    isComplete,
  };
}

/**
 * Create a bullet expand request message.
 */
export function createBulletExpandRequest(
  sessionId: UUID,
  bulletId: number,
): BulletExpandRequestMessage {
  return {
    type: 'bullet_expand_request',
    id: generateId(),
    timestamp: now(),
    sessionId,
    bulletId,
  };
}

/**
 * Create a bullet expand response message.
 */
export function createBulletExpandResponse(
  bulletId: number,
  fullContent: string,
  requestId: UUID,
): BulletExpandResponseMessage {
  return {
    type: 'bullet_expand_response',
    id: generateId(),
    timestamp: now(),
    bulletId,
    fullContent,
    requestId,
  };
}

/**
 * Message ID tracker for deduplication.
 * Uses an LRU-style approach with max capacity.
 */
export class MessageIdTracker {
  private readonly seen: Set<UUID> = new Set();
  private readonly order: UUID[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Check if we've seen this ID before.
   * If not seen, marks it as seen and returns false.
   * If seen, returns true (duplicate).
   */
  checkAndMark(id: UUID): boolean {
    if (this.seen.has(id)) {
      return true; // Duplicate
    }

    // Add to tracker
    this.seen.add(id);
    this.order.push(id);

    // Evict oldest if over capacity
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest) {
        this.seen.delete(oldest);
      }
    }

    return false; // Not a duplicate
  }

  /** Get current count of tracked IDs */
  get size(): number {
    return this.seen.size;
  }

  /** Clear all tracked IDs */
  clear(): void {
    this.seen.clear();
    this.order.length = 0;
  }
}
