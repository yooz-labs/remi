/**
 * Transcript module - Read-only access to Claude Code transcript files.
 *
 * Watches .jsonl transcript files and syncs their entries
 * into Remi's in-memory store for clean content delivery.
 */

export { TranscriptWatcher } from './transcript-watcher.ts';
export { TranscriptDiscovery } from './transcript-discovery.ts';
export { TranscriptMessageBridge } from './transcript-message-bridge.ts';
export { readTranscriptOwnerPort } from './transcript-owner.ts';
export { TranscriptBinder } from './transcript-binder.ts';
export type {
  BinderDecision,
  BinderHookEvent,
  BinderMode,
  TranscriptBinderArgs,
  TranscriptBinderDeps,
} from './transcript-binder.ts';
export type { TranscriptDiscoveryConfig } from './transcript-discovery.ts';
export type {
  TranscriptMessageBridgeConfig,
  TranscriptMessageBridgeEvents,
} from './transcript-message-bridge.ts';
export type {
  AssistantEntry,
  ContentBlock,
  FileHistoryEntry,
  SummaryEntry,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  TranscriptEntry,
  TranscriptWatcherConfig,
  TranscriptWatcherEvents,
  UserEntry,
} from './types.ts';
