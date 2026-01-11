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

import type { Acknowledgment, Message, Question, Session, UUID, Timestamp } from './types.ts';

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
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10

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
  | UserInputMessage
  | AckMessage
  | EditMessage
  | QuestionMessage
  | AnswerMessage
  | SessionUpdateMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;

/** Client hello - initiates connection */
export interface HelloMessage {
  readonly type: 'hello';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly clientVersion: string;
  readonly clientId: UUID;
}

/** Server hello ack - confirms connection */
export interface HelloAckMessage {
  readonly type: 'hello_ack';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly serverVersion: string;
  readonly sessionId: UUID;
}

/** Agent output - message from Claude */
export interface AgentOutputMessage {
  readonly type: 'agent_output';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly message: Message;
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
    'user_input',
    'ack',
    'edit',
    'question',
    'answer',
    'session_update',
    'ping',
    'pong',
    'error',
  ];

  return validTypes.includes(obj['type'] as string);
}

/**
 * Create a hello message.
 */
export function createHello(clientId: UUID, clientVersion: string): HelloMessage {
  return {
    type: 'hello',
    id: generateId(),
    timestamp: now(),
    clientVersion,
    clientId,
  };
}

/**
 * Create a hello ack message.
 */
export function createHelloAck(serverVersion: string, sessionId: UUID): HelloAckMessage {
  return {
    type: 'hello_ack',
    id: generateId(),
    timestamp: now(),
    serverVersion,
    sessionId,
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
  tool?: string
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
  details?: Record<string, unknown>
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
 * Message ID tracker for deduplication.
 * Uses an LRU-style approach with max capacity.
 */
export class MessageIdTracker {
  private readonly seen: Set<UUID> = new Set();
  private readonly order: UUID[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
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
