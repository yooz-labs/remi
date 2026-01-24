/**
 * Types for Claude Code transcript (.jsonl) entries.
 *
 * These represent the structure of entries in Claude Code's
 * transcript files at ~/.claude/projects/<path>/<session-id>.jsonl
 *
 * We treat these files as READ-ONLY and sync their contents
 * into Remi's own in-memory store.
 */

/** Content block types within a message */
export type ContentBlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result';

/** A text content block */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** A thinking content block */
export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string;
}

/** A tool use content block */
export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** A tool result content block */
export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string | readonly ContentBlock[];
}

/** Union of all content block types */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

/** Base fields shared by all transcript entries */
interface TranscriptEntryBase {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly isSidechain?: boolean;
  readonly cwd?: string;
  readonly version?: string;
  readonly gitBranch?: string;
}

/** A user message entry */
export interface UserEntry extends TranscriptEntryBase {
  readonly type: 'user';
  readonly message: {
    readonly role: 'user';
    readonly content: string | readonly ContentBlock[];
  };
}

/** An assistant message entry */
export interface AssistantEntry extends TranscriptEntryBase {
  readonly type: 'assistant';
  readonly message: {
    readonly model?: string;
    readonly id?: string;
    readonly role: 'assistant';
    readonly content: readonly ContentBlock[];
    readonly stop_reason?: string | null;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
    };
  };
  readonly requestId?: string;
}

/** A summary entry (conversation summaries for context management) */
export interface SummaryEntry {
  readonly type: 'summary';
  readonly summary: string;
  readonly leafUuid: string;
}

/** A file history snapshot entry */
export interface FileHistoryEntry {
  readonly type: 'file-history-snapshot';
  readonly [key: string]: unknown;
}

/** Union of all transcript entry types */
export type TranscriptEntry = UserEntry | AssistantEntry | SummaryEntry | FileHistoryEntry;

/** Events emitted by the transcript watcher */
export interface TranscriptWatcherEvents {
  /** New user message entry */
  onUserMessage?: (entry: UserEntry) => void;

  /** New assistant message entry */
  onAssistantMessage?: (entry: AssistantEntry) => void;

  /** New summary entry */
  onSummary?: (entry: SummaryEntry) => void;

  /** Error reading or parsing transcript */
  onError?: (error: Error) => void;
}

/** Configuration for transcript watcher */
export interface TranscriptWatcherConfig {
  /** Path to the JSONL transcript file */
  readonly filePath: string;

  /** Poll interval in ms for file changes (fallback if fs.watch is unreliable) */
  readonly pollIntervalMs?: number;

  /** Whether to read existing entries on start (vs only new ones) */
  readonly readExisting?: boolean;
}
