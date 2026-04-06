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
  | 'error';

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

/** Agent status as displayed in the UI */
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting';

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
}

/** App settings */
export interface AppSettings {
  readonly theme: 'light' | 'dark' | 'system';
  readonly fontSize: 'small' | 'medium' | 'large';
  readonly notifications: boolean;
  readonly sound: boolean;
  readonly vibration: boolean;
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
  vibration: true,
  autoReconnect: true,
  showTimestamps: true,
};
