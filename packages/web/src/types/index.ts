/**
 * Frontend types for Remi web app.
 *
 * These types extend the shared protocol types with UI-specific state.
 */

import type { MessageState, Timestamp, UUID } from '@remi/shared/types.ts';

/** Source that produced a UI message */
export type MessageSource = 'optimistic' | 'pty' | 'transcript';

/** Peer role in WebRTC connection */
export type PeerRole = 'host' | 'client';

/** Connection status for the daemon */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'error'
  // Terminal: auto-reconnect exhausted AND port rediscovery found no daemon on
  // the host. Distinct from 'disconnected' (idle) and 'error' (transient). The
  // UI offers a Retry that re-runs discovery. (#435 Phase 1 / P3)
  | 'unreachable';

/** Unique identifier for a daemon connection (e.g. "localhost:18765") */
export type ConnectionId = string & { readonly __brand: 'ConnectionId' };

/** Per-connection state tracked by the connection manager */
export interface ConnectionState {
  readonly connectionId: ConnectionId;
  readonly url: string;
  readonly status: ConnectionStatus;
  readonly mode: 'direct' | 'relay';
  readonly needsPassphrase: boolean;
  readonly serverFingerprint: string | null;
  readonly error: string | null;
  /** The session ID from hello_ack (the directly attached session) */
  readonly sessionId: string | null;
}

/** Agent status as displayed in the UI. Mirrors the daemon's `AgentStatus`
 *  (@remi/shared); `evaluating`/`approved`/`starting` are auto-approve and
 *  session-lifecycle states surfaced on the pill (#576). */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'executing'
  | 'waiting'
  | 'evaluating'
  | 'approved'
  | 'starting';

/** Message sender type */
export type MessageSender = 'user' | 'agent' | 'system';

/** UI bullet representation */
export interface UIBullet {
  readonly bulletId: number;
  readonly type: 'dash' | 'asterisk' | 'numbered' | 'bullet';
  readonly content: string;
  readonly originalNumber?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly hasCodeBlock?: boolean;
  /** Whether content was truncated */
  readonly isTruncated?: boolean;
  /** Full content length if truncated */
  readonly fullLength?: number;
  /** Full content after expansion (populated on demand) */
  readonly fullContent?: string;
  /** Whether expansion is in progress */
  readonly isExpanding?: boolean;
}

/** UI message representation */
export interface UIMessage {
  readonly id: UUID;
  readonly sessionId: UUID;
  /** Which daemon connection this message arrived from */
  readonly connectionId?: ConnectionId;
  readonly sender: MessageSender;
  readonly content: string;
  readonly timestamp: Timestamp;
  readonly state: MessageState;
  readonly isEditing: boolean;
  readonly editedAt?: Timestamp;
  readonly tool?: string;
  /** Transcript entry UUID for deduplication */
  readonly entryUuid?: string;
  /** Source that produced this message (pty stream or transcript file) */
  readonly source?: MessageSource;
  /** Whether this message is currently being streamed */
  readonly isStreaming?: boolean;
  /** Partial content during streaming */
  readonly streamedContent?: string;
  /** Structured bullets (if available) */
  readonly bullets?: readonly UIBullet[];
  /** First bullet ID in this message */
  readonly firstBulletId?: number;
  /** Last bullet ID in this message */
  readonly lastBulletId?: number;
  /** Raw content blocks from transcript (Text, ToolUse, ToolResult) */
  readonly contentBlocks?: readonly import('@remi/shared/protocol.ts').TranscriptContentBlock[];
}

/** Session information for the UI */
export interface UISession {
  readonly id: UUID;
  readonly name: string;
  /** Which daemon connection this session belongs to */
  readonly connectionId: ConnectionId;
  readonly createdAt: Timestamp;
  readonly lastActiveAt: Timestamp;
  readonly status: AgentStatus;
  readonly connectionStatus: ConnectionStatus;
  readonly unreadCount: number;
  /** Current working directory of the agent */
  readonly cwd?: string;
  /** Last agent output preview */
  readonly preview?: string;
  /** Source of this session */
  readonly source?: 'daemon' | 'transcript';
  /** Whether transcript history is loading */
  readonly isLoadingTranscript?: boolean;
  /** Whether the session has a pending question requiring user input */
  readonly questionPending?: boolean;
  /** Whether this dead session can be resumed via Claude Code --resume */
  readonly canResume?: boolean;
  /**
   * Claude Code session UUID this entry's Claude is writing under (#430).
   * Carried in outbound answer/input so the daemon can refuse stale
   * routing when the binding has rotated (e.g. user ran /resume). Shown
   * to the user in the chat header so the binding is verifiable by eye.
   */
  readonly claudeSessionId?: UUID;
  /** Absolute path to the bound .jsonl transcript (#430). */
  readonly transcriptPath?: string;
  /**
   * This entry is a subagent view spawned by a parent session, not a
   * top-level session (epic #499 phase 3). Its `id` is the subagent's
   * `agentId`; tapping it loads `agent-<id>.jsonl` via the normal flow.
   */
  readonly isSubagent?: boolean;
  /** For a subagent view: the parent session's id. */
  readonly parentSessionId?: UUID;
  /** For a subagent view: e.g. "Explore", "pr-review-toolkit:code-reviewer". */
  readonly agentType?: string;
  /** For a subagent view: false once it finished (transcript stays viewable). */
  readonly subagentActive?: boolean;
}

/** Structured option for a question */
export interface UIQuestionOption {
  readonly label: string;
  readonly value: string;
  readonly isYes?: boolean;
  readonly isNo?: boolean;
  readonly isRecommended?: boolean;
}

/** Question from the agent requiring user response */
export interface UIQuestion {
  readonly id: UUID;
  readonly sessionId: UUID;
  readonly type: 'yes_no' | 'multi_option' | 'numbered' | 'permission' | 'free_text';
  readonly prompt: string;
  readonly options?: readonly string[];
  readonly structuredOptions?: readonly UIQuestionOption[];
  readonly timestamp: Timestamp;
  /** The answer that was selected (set after answering) */
  readonly answeredWith?: string;
  /** The Claude agent this prompt belongs to ('main' default). Keys the
   *  collection so a main + subagent prompt coexist rather than overwrite. */
  readonly agentId?: string;
}

/** App settings */
export interface AppSettings {
  readonly theme: 'light' | 'dark' | 'system';
  readonly fontSize: 'small' | 'medium' | 'large';
  readonly notifications: boolean;
  readonly sound: boolean;
  readonly autoReconnect: boolean;
  readonly showTimestamps: boolean;
}

/** Connection configuration */
export interface ConnectionConfig {
  /** Direct connection URL (local daemon) */
  readonly directUrl?: string;
  /** Signaling server URL for WebRTC */
  readonly signalingUrl?: string;
  /** Connection code for remote access */
  readonly connectionCode?: string;
  /** Peer role (host or client) */
  readonly role: PeerRole;
}

/** Default settings */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  fontSize: 'medium',
  notifications: true,
  sound: true,
  autoReconnect: true,
  showTimestamps: true,
};
