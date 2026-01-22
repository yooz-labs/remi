/**
 * Frontend types for Remi web app.
 *
 * These types extend the shared protocol types with UI-specific state.
 */

import type { MessageState, Timestamp, UUID } from '@remi/shared/types.ts';

/** Peer role in WebRTC connection */
export type PeerRole = 'host' | 'client';

/** Connection status for the daemon */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

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
  readonly sender: MessageSender;
  readonly content: string;
  readonly timestamp: Timestamp;
  readonly state: MessageState;
  readonly isEditing: boolean;
  readonly editedAt?: Timestamp;
  readonly tool?: string;
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
}

/** Session information for the UI */
export interface UISession {
  readonly id: UUID;
  readonly name: string;
  readonly createdAt: Timestamp;
  readonly lastActiveAt: Timestamp;
  readonly status: AgentStatus;
  readonly connectionStatus: ConnectionStatus;
  readonly unreadCount: number;
  /** Current working directory of the agent */
  readonly cwd?: string;
  /** Last agent output preview */
  readonly preview?: string;
}

/** Question from the agent requiring user response */
export interface UIQuestion {
  readonly id: UUID;
  readonly sessionId: UUID;
  readonly type: 'yes_no' | 'numbered' | 'permission' | 'free_text';
  readonly prompt: string;
  readonly options?: readonly string[];
  readonly timestamp: Timestamp;
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

/** App state */
export interface AppState {
  readonly sessions: readonly UISession[];
  readonly activeSessionId: UUID | null;
  readonly messages: Record<UUID, readonly UIMessage[]>;
  readonly pendingQuestions: Record<UUID, UIQuestion>;
  readonly connectionStatus: ConnectionStatus;
  readonly settings: AppSettings;
  readonly error: string | null;
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
