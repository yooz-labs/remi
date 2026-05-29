/**
 * Messaging protocol for Remi.
 *
 * All messages are JSON-encoded with a type discriminator.
 * Binary data (if any) is base64 encoded.
 *
 * Protocol guarantees:
 * - Every message has a unique ID
 * - Messages are acknowledged at the application level (e.g. hello -> hello_ack)
 * - Messages are ordered within a session
 */

import type {
  Acknowledgment,
  AgentStatus,
  DiscoverableSession,
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
  // biome-ignore lint/style/noNonNullAssertion: array is guaranteed 16 elements
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // Version 4
  // biome-ignore lint/style/noNonNullAssertion: array is guaranteed 16 elements
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
  | BulletExpandResponseMessage
  | SessionListRequestMessage
  | SessionListResponseMessage
  | TranscriptContentMessage
  | TranscriptLoadRequestMessage
  | TranscriptLoadCompleteMessage
  | CreateSessionRequestMessage
  | CreateSessionResponseMessage
  | TerminalResizeMessage
  | AuthChallengeMessage
  | AuthResponseMessage
  | AuthResultMessage
  | KillSessionRequestMessage
  | KillSessionResponseMessage
  | RawPtyOutputMessage
  | SessionHistoryRequestMessage
  | SessionHistoryResponseMessage
  | ResumeSessionRequestMessage
  | ResumeSessionResponseMessage
  | DetachSessionMessage
  | DetachSessionAckMessage
  | RegisterDeviceTokenMessage
  | DaemonUpdateAvailableMessage
  | SessionRotatedMessage;

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
  /** Connection mode: 'query' for utility clients (ls, kill) that should not auto-attach */
  readonly mode?: 'query' | undefined;
}

/** Server hello ack - confirms connection */
export interface HelloAckMessage {
  readonly type: 'hello_ack';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly serverVersion: string;
  readonly sessionId: UUID;
  /**
   * Claude Code session UUID this daemon's PTY is bound to (#427/#429).
   * Always populated post-phase-1 because the daemon pre-assigns the id
   * before spawning Claude. Null only on the promotion path when the
   * store lookup misses (crashed daemon, store cleared). Clients should
   * key sessions by (connectionId, claudeSessionId) to keep two daemons
   * in the same cwd from cross-contaminating.
   */
  readonly claudeSessionId?: UUID | null;
  /**
   * Absolute path to the .jsonl transcript file Claude writes to.
   * Pre-assigned alongside claudeSessionId; the file may not yet exist on
   * disk when this ack is sent. Null when claudeSessionId is null.
   */
  readonly transcriptPath?: string | null;
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
  /** When true, content is raw terminal bytes (no Enter appended) */
  readonly raw?: boolean;
  /**
   * Claude Code session UUID the client believed it was talking to when
   * the user typed this. Daemon rejects with code='STALE_BINDING' when
   * present and != current binding (e.g. the PTY swapped to another
   * session via /resume between the user typing and the message
   * landing). Omitted by pre-#429 clients; daemon accepts without
   * checking in that case.
   */
  readonly claudeSessionId?: UUID | undefined;
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
  /** Remi session that owns this question. Mandatory (#437): the client routes
   *  and keys questions by it and must never fall back to "the active session",
   *  which cross-contaminates when multiple sessions/agents have prompts. The
   *  owning agent is carried inside `question.agentId`. */
  readonly sessionId: UUID;
  /**
   * Claude Code session UUID the question came from. The answer carrying
   * this id back lets the daemon reject the write if the binding has
   * moved (e.g. user ran /resume between the question firing and their
   * tap). Populated when the daemon has a binding; omitted otherwise.
   */
  readonly claudeSessionId?: UUID | undefined;
}

/** Answer to a question */
export interface AnswerMessage {
  readonly type: 'answer';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly sessionId: UUID;
  readonly questionId: UUID;
  readonly answer: string;
  /**
   * Echoes the claudeSessionId from the QuestionMessage. Daemon refuses
   * with code='STALE_BINDING' when present and != current binding.
   * Omitted by pre-#429 clients.
   */
  readonly claudeSessionId?: UUID | undefined;
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

/** Request list of discoverable sessions */
export interface SessionListRequestMessage {
  readonly type: 'session_list_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Whether to include external sessions from transcript files. When omitted or false, only daemon-managed sessions are returned. */
  readonly includeExternal?: boolean | undefined;
}

/** Response with list of discoverable sessions */
export interface SessionListResponseMessage {
  readonly type: 'session_list_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Discovered sessions */
  readonly sessions: readonly DiscoverableSession[];
  /** ID of the request this responds to */
  readonly requestId: UUID;
  /** Other daemon ports on this machine (for auto-connect) */
  readonly daemonPorts?: readonly number[];
}

/**
 * One atomic rotation event (#438): the PTY's bound Claude session rotated —
 * the user ran `/clear` or `/resume` inside the PTY, starting a NEW transcript
 * under a new Claude session id. (`/compact` does NOT rotate — it keeps the
 * same id and appends in place — so it never produces this message.)
 *
 * Replaces the former non-atomic pair `session_reset` + `transcript_binding_
 * changed`. On receipt, a client that owns this session clears its messages
 * and pending questions, swaps the binding to the new (claudeSessionId,
 * transcriptPath), re-fetches the new transcript, and un-stales any pending
 * question so the next answer carries the new id (no STALE_BINDING).
 */
export interface SessionRotatedMessage {
  readonly type: 'session_rotated';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Remi session id whose Claude binding rotated (unchanged across rotation). */
  readonly sessionId: UUID;
  /** Claude session id before the rotation, if known. */
  readonly oldClaudeSessionId?: UUID | undefined;
  /** The new Claude session id Claude is now writing under. */
  readonly newClaudeSessionId: UUID;
  /** Absolute path to the new transcript .jsonl. */
  readonly newTranscriptPath: string;
  /** Diagnostic: what triggered the rotation. */
  readonly reason: 'clear' | 'resume' | 'restart';
}

/** Token usage information from a transcript entry */
export interface TranscriptUsage {
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
}

/** Transcript-sourced content message (Phase 2 of two-phase delivery) */
export interface TranscriptContentMessage {
  readonly type: 'transcript_content';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly sessionId: UUID;
  /** Unique transcript entry UUID from Claude Code */
  readonly entryUuid: string;
  /** Message role */
  readonly role: 'user' | 'assistant';
  /** Clean text content (text blocks only, no thinking/tool_use) */
  readonly content: string;
  /** Tool names invoked in this turn */
  readonly tools?: readonly string[] | undefined;
  /** Model used (assistant entries only) */
  readonly model?: string | undefined;
  /** Whether thinking blocks were present */
  readonly hadThinking?: boolean | undefined;
  /** Token usage (if available) */
  readonly usage?: TranscriptUsage | undefined;
  /** Structured message with bullets */
  readonly message: StructuredMessage;
  /** Whether this updates a previously sent entry */
  readonly isUpdate: boolean;
  /** Raw content blocks from the transcript entry (Text, ToolUse, ToolResult) */
  readonly contentBlocks?: readonly TranscriptContentBlock[];
}

/** A content block from the Claude Code transcript */
export interface TranscriptContentBlock {
  readonly type: 'text' | 'tool_use' | 'tool_result';
  /** Text content (for type=text) */
  readonly text?: string;
  /** Tool use ID (for type=tool_use) */
  readonly toolUseId?: string;
  /** Tool name (for type=tool_use or tool_result) */
  readonly toolName?: string;
  /** Tool input as JSON string (for type=tool_use) */
  readonly toolInput?: string;
  /** Tool output (for type=tool_result, truncated) */
  readonly toolOutput?: string;
  /** Whether tool execution failed (for type=tool_result) */
  readonly isError?: boolean;
}

/** Request to load transcript history for an external session */
export interface TranscriptLoadRequestMessage {
  readonly type: 'transcript_load_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Session ID of the external transcript session to load */
  readonly sessionId: string;
}

/** Signals that all transcript content for a load request has been sent */
export interface TranscriptLoadCompleteMessage {
  readonly type: 'transcript_load_complete';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Session ID that was loaded */
  readonly sessionId: string;
  /** Number of messages sent */
  readonly messageCount: number;
  /** ID of the original request */
  readonly requestId: UUID;
}

/** Terminal resize event from attached CLI client */
export interface TerminalResizeMessage {
  readonly type: 'terminal_resize';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** New terminal column count */
  readonly cols: number;
  /** New terminal row count */
  readonly rows: number;
}

/** Request to create a new Claude Code session */
export interface CreateSessionRequestMessage {
  readonly type: 'create_session_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Working directory for the new session */
  readonly directory?: string;
}

/** Response after creating a new session */
export interface CreateSessionResponseMessage {
  readonly type: 'create_session_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Session ID of the newly created session (present on success) */
  readonly sessionId?: UUID;
  /** Whether creation succeeded */
  readonly success: boolean;
  /** Error message if creation failed */
  readonly error?: string;
  /** ID of the original request */
  readonly requestId: UUID;
  /** Port of the new daemon (when session was spawned on a new daemon) */
  readonly port?: number;
}

/** Request to resume a dead/ended Claude Code session */
export interface ResumeSessionRequestMessage {
  readonly type: 'resume_session_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Remi session ID or Claude session ID of the session to resume */
  readonly sessionId: string;
}

/** Response after attempting to resume a session */
export interface ResumeSessionResponseMessage {
  readonly type: 'resume_session_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Session ID to use (existing if still alive, or newly created). Present on success. */
  readonly sessionId?: UUID;
  /** Whether resume succeeded */
  readonly success: boolean;
  /** Error message if resume failed */
  readonly error?: string;
  /** ID of the original request */
  readonly requestId: UUID;
}

/** Authentication challenge from server to client */
export interface AuthChallengeMessage {
  readonly type: 'auth_challenge';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Base64-encoded 32-byte random challenge nonce */
  readonly challenge: string;
  /** Server's public key fingerprint for display */
  readonly serverFingerprint: string;
  /** Base64-encoded server Ed25519 public key */
  readonly serverPublicKey: string;
}

/** Authentication response from client to server */
export interface AuthResponseMessage {
  readonly type: 'auth_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Base64-encoded client Ed25519 public key */
  readonly clientPublicKey: string;
  /** Base64-encoded Ed25519 signature of the challenge */
  readonly signature: string;
  /** Client's fingerprint for display */
  readonly clientFingerprint: string;
}

/** Authentication result from server to client */
export interface AuthResultMessage {
  readonly type: 'auth_result';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Whether authentication succeeded */
  readonly success: boolean;
  /** Error code if failed: UNKNOWN_KEY, INVALID_SIGNATURE, NO_PENDING_CHALLENGE, VERIFICATION_ERROR */
  readonly error?: string;
  /** Server's signature of the challenge (for mutual authentication) */
  readonly serverSignature?: string;
}

/** Raw PTY output - broadcasts terminal bytes to remote attached clients */
export interface RawPtyOutputMessage {
  readonly type: 'raw_pty_output';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Base64-encoded raw PTY bytes */
  readonly data: string;
  /** Session ID this output belongs to */
  readonly sessionId: UUID;
}

/** Request to kill (terminate) a session by ID */
export interface KillSessionRequestMessage {
  readonly type: 'kill_session_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Session ID to kill */
  readonly sessionId: UUID;
}

/** Response after killing a session */
export interface KillSessionResponseMessage {
  readonly type: 'kill_session_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Whether the kill succeeded */
  readonly success: boolean;
  /** Error message if kill failed */
  readonly error?: string;
  /** ID of the original request */
  readonly requestId: UUID;
}

/** Request to detach from a session without killing it (tmux-style) */
export interface DetachSessionMessage {
  readonly type: 'detach_session';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Session ID to detach from */
  readonly sessionId: UUID;
}

/** Acknowledgment that detach was processed; sent before the server closes the connection */
export interface DetachSessionAckMessage {
  readonly type: 'detach_session_ack';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Session ID that was detached */
  readonly sessionId: UUID;
  /** Whether the detach succeeded */
  readonly success: boolean;
  /** Error message if detach failed */
  readonly error?: string;
}

/** Register a device token for push notifications */
export interface RegisterDeviceTokenMessage {
  readonly type: 'register_device_token';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** APNS or FCM device token */
  readonly token: string;
  /** Device platform */
  readonly platform: 'ios' | 'android';
}

/**
 * Daemon notifies attached clients that a newer remi binary is on disk.
 *
 * The running wrapper is locked to its startup-time code and cannot be
 * hot-swapped without disrupting the user's PTY session. This message
 * lets the client surface a "restart this session to pick up vNEW"
 * banner so the user knows their fix landed but is not yet live.
 *
 * Fired at most once per wrapper lifetime by the on-disk binary watcher
 * (cli/update-watcher.ts). Issue #287.
 */
export interface DaemonUpdateAvailableMessage {
  readonly type: 'daemon_update_available';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Version this wrapper is running. */
  readonly currentVersion: string;
  /**
   * Path of the binary detected as updated. Useful for diagnostics if
   * the user has multiple remi installs (Homebrew vs npm vs symlink).
   */
  readonly binaryPath: string;
}

/** A recent project directory aggregated from session history */
export interface RecentDirectory {
  /** Absolute path */
  readonly directory: string;
  /** ISO timestamp of last use */
  readonly lastUsed: Timestamp;
  /** Number of sessions that used this directory */
  readonly sessionCount: number;
  /** basename(directory) for display */
  readonly displayName: string;
}

/** Request session history (recent directories) */
export interface SessionHistoryRequestMessage {
  readonly type: 'session_history_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** Max number of directories to return */
  readonly limit?: number;
}

/** Response with recent directories */
export interface SessionHistoryResponseMessage {
  readonly type: 'session_history_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly directories: readonly RecentDirectory[];
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
    'session_list_request',
    'session_list_response',
    'transcript_content',
    'transcript_load_request',
    'transcript_load_complete',
    'create_session_request',
    'create_session_response',
    'terminal_resize',
    'auth_challenge',
    'auth_response',
    'auth_result',
    'kill_session_request',
    'kill_session_response',
    'raw_pty_output',
    'session_history_request',
    'session_history_response',
    'resume_session_request',
    'resume_session_response',
    'detach_session',
    'detach_session_ack',
    'register_device_token',
    'daemon_update_available',
    'session_rotated',
  ];

  return validTypes.includes(obj['type'] as string);
}

/** Optional fields for {@link createHello}. */
export interface CreateHelloOptions {
  /** Working directory for the Claude Code session. */
  readonly directory?: string | undefined;
  /** Session ID to resume (for reconnecting to an existing session). */
  readonly resumeSessionId?: UUID | undefined;
  /** Index of last received message (for efficient replay). */
  readonly lastReceivedIndex?: number | undefined;
  /** Connection mode: 'query' for utility clients (ls, kill) that should not auto-attach. */
  readonly mode?: 'query' | undefined;
}

/**
 * Create a hello message.
 *
 * Optional fields are passed via the `options` object so adding new optionals
 * never requires threading `undefined` through positional callsites.
 */
export function createHello(
  clientId: UUID,
  clientVersion: string,
  options: CreateHelloOptions = {},
): HelloMessage {
  const { directory, resumeSessionId, lastReceivedIndex, mode } = options;
  return {
    type: 'hello',
    id: generateId(),
    timestamp: now(),
    clientVersion,
    clientId,
    ...(directory !== undefined && { directory }),
    ...(resumeSessionId !== undefined && { resumeSessionId }),
    ...(lastReceivedIndex !== undefined && { lastReceivedIndex }),
    ...(mode !== undefined && { mode }),
  };
}

/**
 * Create a hello ack message.
 */
export function createHelloAck(
  serverVersion: string,
  sessionId: UUID,
  resumeInfo?: { isResume: boolean; replayCount: number; nextBulletId: number },
  binding?: { claudeSessionId: UUID | null; transcriptPath: string | null },
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
    ...(binding && {
      claudeSessionId: binding.claudeSessionId,
      transcriptPath: binding.transcriptPath,
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
export function createUserInput(
  sessionId: UUID,
  content: string,
  raw?: boolean,
  claudeSessionId?: UUID,
): UserInputMessage {
  return {
    type: 'user_input',
    id: generateId(),
    timestamp: now(),
    sessionId,
    content,
    ...(raw && { raw }),
    ...(claudeSessionId !== undefined && { claudeSessionId }),
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
export function createQuestion(
  question: Question,
  sessionId: UUID,
  claudeSessionId?: UUID,
): QuestionMessage {
  return {
    type: 'question',
    id: generateId(),
    timestamp: now(),
    question,
    sessionId,
    ...(claudeSessionId !== undefined && { claudeSessionId }),
  };
}

/**
 * Create an answer message for a question.
 */
export function createAnswer(
  sessionId: UUID,
  questionId: UUID,
  answer: string,
  claudeSessionId?: UUID,
): AnswerMessage {
  return {
    type: 'answer',
    id: generateId(),
    timestamp: now(),
    sessionId,
    questionId,
    answer,
    ...(claudeSessionId !== undefined && { claudeSessionId }),
  };
}

/**
 * Create a session update message.
 */
export function createSessionUpdate(
  sessionId: UUID,
  status: AgentStatus,
  _statusContext?: string,
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
 * Create a session list request. When includeExternal is true, the response
 * will include sessions discovered from transcript files in addition to daemon-managed sessions.
 */
export function createSessionListRequest(includeExternal?: boolean): SessionListRequestMessage {
  return {
    type: 'session_list_request',
    id: generateId(),
    timestamp: now(),
    ...(includeExternal !== undefined && { includeExternal }),
  };
}

/**
 * Create a session list response containing discovered sessions for a given request.
 */
export function createSessionListResponse(
  sessions: readonly DiscoverableSession[],
  requestId: UUID,
  daemonPorts?: readonly number[],
): SessionListResponseMessage {
  return {
    type: 'session_list_response',
    id: generateId(),
    timestamp: now(),
    sessions,
    requestId,
    ...(daemonPorts && daemonPorts.length > 0 && { daemonPorts }),
  };
}

/**
 * Create a transcript content message (Phase 2 content delivery).
 */
export function createTranscriptContent(
  sessionId: UUID,
  entryUuid: string,
  role: 'user' | 'assistant',
  content: string,
  message: StructuredMessage,
  isUpdate: boolean,
  options?: {
    tools?: readonly string[];
    model?: string;
    hadThinking?: boolean;
    usage?: TranscriptUsage;
    contentBlocks?: readonly TranscriptContentBlock[];
  },
): TranscriptContentMessage {
  return {
    type: 'transcript_content',
    id: generateId(),
    timestamp: now(),
    sessionId,
    entryUuid,
    role,
    content,
    message,
    isUpdate,
    ...(options?.tools != null && options.tools.length > 0 && { tools: options.tools }),
    ...(options?.model != null && options.model !== '' && { model: options.model }),
    ...(options?.hadThinking != null && { hadThinking: options.hadThinking }),
    ...(options?.usage != null && { usage: options.usage }),
    ...(options?.contentBlocks != null &&
      options.contentBlocks.length > 0 && { contentBlocks: options.contentBlocks }),
  };
}

/**
 * Create a transcript load request for an external session.
 */
export function createTranscriptLoadRequest(sessionId: string): TranscriptLoadRequestMessage {
  return {
    type: 'transcript_load_request',
    id: generateId(),
    timestamp: now(),
    sessionId,
  };
}

/**
 * Create a transcript load complete message.
 */
export function createTranscriptLoadComplete(
  sessionId: string,
  messageCount: number,
  requestId: UUID,
): TranscriptLoadCompleteMessage {
  return {
    type: 'transcript_load_complete',
    id: generateId(),
    timestamp: now(),
    sessionId,
    messageCount,
    requestId,
  };
}

/**
 * Create a request to spawn a new Claude Code session.
 */
export function createCreateSessionRequest(directory?: string): CreateSessionRequestMessage {
  return {
    type: 'create_session_request',
    id: generateId(),
    timestamp: now(),
    ...(directory !== undefined && { directory }),
  };
}

/**
 * Create a response for a create session request.
 */
export function createCreateSessionResponse(
  success: boolean,
  requestId: UUID,
  sessionId?: UUID,
  error?: string,
  port?: number,
): CreateSessionResponseMessage {
  return {
    type: 'create_session_response',
    id: generateId(),
    timestamp: now(),
    success,
    requestId,
    ...(sessionId !== undefined && { sessionId }),
    ...(error !== undefined && { error }),
    ...(port !== undefined && { port }),
  };
}

/**
 * Create a terminal resize message.
 */
export function createTerminalResize(cols: number, rows: number): TerminalResizeMessage {
  return {
    type: 'terminal_resize',
    id: generateId(),
    timestamp: now(),
    cols,
    rows,
  };
}

/**
 * Create an auth challenge message.
 */
export function createAuthChallenge(
  challenge: string,
  serverFingerprint: string,
  serverPublicKey: string,
): AuthChallengeMessage {
  return {
    type: 'auth_challenge',
    id: generateId(),
    timestamp: now(),
    challenge,
    serverFingerprint,
    serverPublicKey,
  };
}

/**
 * Create an auth response message.
 */
export function createAuthResponse(
  clientPublicKey: string,
  signature: string,
  clientFingerprint: string,
): AuthResponseMessage {
  return {
    type: 'auth_response',
    id: generateId(),
    timestamp: now(),
    clientPublicKey,
    signature,
    clientFingerprint,
  };
}

/**
 * Create an auth result message.
 */
export function createAuthResult(
  success: boolean,
  serverSignature?: string,
  error?: string,
): AuthResultMessage {
  return {
    type: 'auth_result',
    id: generateId(),
    timestamp: now(),
    success,
    ...(serverSignature !== undefined && { serverSignature }),
    ...(error !== undefined && { error }),
  };
}

/**
 * Create a kill session request message.
 */
export function createKillSessionRequest(sessionId: UUID): KillSessionRequestMessage {
  return {
    type: 'kill_session_request',
    id: generateId(),
    timestamp: now(),
    sessionId,
  };
}

/**
 * Create a kill session response message.
 */
export function createKillSessionResponse(
  success: boolean,
  requestId: UUID,
  error?: string,
): KillSessionResponseMessage {
  return {
    type: 'kill_session_response',
    id: generateId(),
    timestamp: now(),
    success,
    requestId,
    ...(error !== undefined && { error }),
  };
}

/**
 * Create a raw PTY output message.
 */
export function createRawPtyOutput(data: string, sessionId: UUID): RawPtyOutputMessage {
  return {
    type: 'raw_pty_output',
    id: generateId(),
    timestamp: now(),
    data,
    sessionId,
  };
}

/**
 * Create a session history request.
 */
export function createSessionHistoryRequest(limit?: number): SessionHistoryRequestMessage {
  return {
    type: 'session_history_request',
    id: generateId(),
    timestamp: now(),
    ...(limit !== undefined && { limit }),
  };
}

/**
 * Create a session history response with recent directories.
 */
export function createSessionHistoryResponse(
  directories: readonly RecentDirectory[],
  requestId: UUID,
): SessionHistoryResponseMessage {
  return {
    type: 'session_history_response',
    id: generateId(),
    timestamp: now(),
    directories,
    requestId,
  };
}

/**
 * Create a request to resume a dead/ended Claude Code session.
 */
export function createResumeSessionRequest(sessionId: string): ResumeSessionRequestMessage {
  return {
    type: 'resume_session_request',
    id: generateId(),
    timestamp: now(),
    sessionId,
  };
}

/**
 * Create a response for a resume session request.
 */
export function createResumeSessionResponse(
  success: boolean,
  requestId: UUID,
  sessionId?: UUID,
  error?: string,
): ResumeSessionResponseMessage {
  return {
    type: 'resume_session_response',
    id: generateId(),
    timestamp: now(),
    success,
    requestId,
    ...(sessionId !== undefined && { sessionId }),
    ...(error !== undefined && { error }),
  };
}

/**
 * Create a detach session request (tmux-style detach without killing).
 */
export function createDetachSession(sessionId: UUID): DetachSessionMessage {
  return {
    type: 'detach_session',
    id: generateId(),
    timestamp: now(),
    sessionId,
  };
}

/**
 * Create a detach session acknowledgment.
 */
export function createDetachSessionAck(
  sessionId: UUID,
  success: boolean,
  error?: string,
): DetachSessionAckMessage {
  return {
    type: 'detach_session_ack',
    id: generateId(),
    timestamp: now(),
    sessionId,
    success,
    ...(error !== undefined && { error }),
  };
}

/** Create a device token registration message */
export function createRegisterDeviceToken(
  token: string,
  platform: 'ios' | 'android',
): RegisterDeviceTokenMessage {
  return {
    type: 'register_device_token',
    id: generateId(),
    timestamp: now(),
    token,
    platform,
  };
}

/**
 * Create a daemon-update-available notification. Daemon fires this once
 * when its on-disk binary has been replaced (issue #287); the client
 * surfaces a "restart to pick up update" prompt.
 */
export function createDaemonUpdateAvailable(
  currentVersion: string,
  binaryPath: string,
): DaemonUpdateAvailableMessage {
  return {
    type: 'daemon_update_available',
    id: generateId(),
    timestamp: now(),
    currentVersion,
    binaryPath,
  };
}

/**
 * Create an atomic session-rotated notification (#438): the PTY's bound Claude
 * session rotated to a new transcript (`/clear` or `/resume`). Replaces the
 * former session_reset + transcript_binding_changed pair.
 */
export function createSessionRotated(
  sessionId: UUID,
  newClaudeSessionId: UUID,
  newTranscriptPath: string,
  reason: 'clear' | 'resume' | 'restart' = 'restart',
  oldClaudeSessionId?: UUID,
): SessionRotatedMessage {
  return {
    type: 'session_rotated',
    id: generateId(),
    timestamp: now(),
    sessionId,
    ...(oldClaudeSessionId !== undefined && { oldClaudeSessionId }),
    newClaudeSessionId,
    newTranscriptPath,
    reason,
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
