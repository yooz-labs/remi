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

/**
 * Agent status while working.
 *
 * Hook- and auto-approve-sourced lifecycle states (#576):
 *   - `waiting`     — blocked on the user (a permission/question is open).
 *   - `evaluating`  — auto-approve is deciding a permission right now.
 *   - `approved`    — auto-approve just allowed a permission (transient; the
 *                     next hook moves the session back to executing/thinking).
 *   - `starting`    — the session is spinning up before its first hook fires,
 *                     so clients have a defined pill state from hello_ack.
 */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'executing'
  | 'waiting'
  | 'evaluating'
  | 'approved'
  | 'starting';

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

  /**
   * The Claude agent this prompt belongs to: the hook `agent_id` for a
   * subagent, or undefined (MAIN_AGENT_ID) for the primary agent. Used as the
   * key in QuestionPresenceTracker's pending map and as part of the composite
   * key (`${sessionId}#${agentId}`) in the web client's collection, so a
   * main-agent prompt and a concurrent subagent prompt (#419) coexist instead
   * of overwriting each other (#425). The daemon SessionRegistry keys by
   * question id, so concurrency there holds regardless of this field.
   */
  readonly agentId?: string | undefined;

  /**
   * Where this question came from (#574). The daemon emits two hook-derived
   * questions for one permission cycle: a rich `PermissionRequest` (tool +
   * command + agent context) and a generic `Notification(permission_prompt)`
   * ("Claude needs your permission to use Bash"). The
   * QuestionPresenceTracker's merge policy uses this so a trailing generic
   * notification never overwrites the richer permission-request text/options
   * for the same agent. PTY-parsed prompts are `'pty'`. Optional and
   * ignored on the wire; consumed only by the daemon's notification path.
   */
  readonly source?: QuestionSource | undefined;

  /**
   * Shape discriminator (#626). `'permission'` (the default when omitted) is a
   * single prompt described by `text` + `options`. `'multi_question'` is a
   * structured `AskUserQuestion` tool call: the full set of sub-questions is in
   * `questions`, while `text`/`options` mirror `questions[0]` for back-compat
   * (lock-screen summary + the first-question answer path).
   */
  readonly kind?: 'permission' | 'multi_question' | undefined;

  /**
   * The sub-questions for `kind === 'multi_question'` (#626): each carries its
   * own `header`, `text`, `multiSelect`, and `options` (with authored
   * `description`s). Authored by Claude in `AskUserQuestion.tool_input`; the
   * daemon surfaces them verbatim instead of collapsing to the first question.
   */
  readonly questions?: readonly QuestionStep[] | undefined;

  /** Submit-button label for a multi-question form (#626); defaults to "Submit". */
  readonly submitLabel?: string | undefined;

  /**
   * A one-sentence, lock-screen-friendly restatement of what the user is approving
   * (#628), e.g. "Force-push to main?" instead of "Allow Bash: git push --force …".
   * Produced by the deciding auto-approve LLM on an escalate verdict (or a cheap
   * engine call for a rule-escalate). The notification prefers this over the raw
   * tool text; absent for AskUserQuestion (which carries authored content) and for
   * escalations with no model summary.
   */
  readonly summary?: string | undefined;
}

/**
 * One sub-question of a `kind === 'multi_question'` {@link Question} (#626),
 * mirroring an `AskUserQuestion` entry: a short topic `header`, the `text`, a
 * `multiSelect` flag (pick one vs many), and `options` each with an authored
 * `description`.
 */
export interface QuestionStep {
  /** Short topic chip shown above the question (AskUserQuestion `header`). */
  readonly header?: string | undefined;
  /** The sub-question text. */
  readonly text: string;
  /** True when the user may select MORE THAN ONE option. */
  readonly multiSelect: boolean;
  /** Options for this sub-question. */
  readonly options: readonly QuestionOption[];
}

/**
 * Provenance of a {@link Question} (#574). Drives the daemon's
 * QuestionPresenceTracker merge policy (richer hook text must win over the
 * generic notification fallback) and is otherwise inert on the wire.
 */
export type QuestionSource = 'permission_request' | 'notification' | 'pty';

/** Sentinel agent key for the primary (main) agent, whose questions carry no
 *  `agentId`. Normalize `agentId ?? MAIN_AGENT_ID` when building collection keys. */
export const MAIN_AGENT_ID = 'main';

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

  /**
   * Authored per-option explanation (#626). Present for `AskUserQuestion`
   * options, whose `tool_input` carries a `description` for each choice; this is
   * the text that lets the user understand a choice without seeing the terminal.
   * Absent for plain permission options (Yes / Yes, always / No).
   */
  readonly description?: string | undefined;
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

/** Session status for discovery. Daemon sessions use 'active'/'idle'/'orphaned'/'detached'; transcript sessions use 'active'/'idle'/'completed'. */
export type DiscoverableSessionStatus = 'active' | 'idle' | 'orphaned' | 'detached' | 'completed';

/**
 * A session visible through the discovery mechanism.
 * Combines daemon-managed sessions and externally-discovered transcript files.
 */
export interface DiscoverableSession {
  /** Session ID (daemon UUID or Claude Code session ID from transcript path) */
  readonly sessionId: string;

  /** Human-readable session name (e.g. "hostname/project/branch") */
  readonly name?: string | undefined;

  /** Project path this session is working in. For transcript sessions, this is decoded from Claude Code's lossy path encoding and may be inaccurate for paths containing dashes. */
  readonly projectPath: string;

  /** Current session status */
  readonly status: DiscoverableSessionStatus;

  /** When the session was created. For daemon sessions: registration time. For transcript sessions: file creation time. */
  readonly createdAt?: Timestamp | undefined;

  /** When the session was last active. For daemon sessions: last disconnection time (or creation time if still connected). For transcript sessions: file modification time. */
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

  /** Whether this dead session can be resumed via Claude Code --resume */
  readonly canResume: boolean;

  /**
   * Claude Code session UUID this entry's Claude is bound to (#427/#429).
   * For daemon-sourced entries, this is the pre-assigned binding from
   * SessionStore. For transcript-sourced entries it equals sessionId.
   * Optional because the SessionStore lookup may miss on the daemon-list
   * path (e.g. a daemon entry whose sessions.json record was lost across
   * a crash before the client requested the list).
   */
  readonly claudeSessionId?: string | undefined;

  /**
   * Absolute path to the .jsonl transcript Claude writes to. Populated
   * for all entries where the binding is known. Omitted in the same
   * lookup-miss case described above.
   */
  readonly transcriptPath?: string | undefined;

  /** WebSocket port of the daemon hosting this session (for auto-connect) */
  readonly wsPort?: number;

  /** Hostname of the daemon hosting this session */
  readonly daemonHost?: string;
}
