/**
 * @remi/daemon - Daemon for managing Claude Code sessions.
 *
 * This package provides:
 * - PTY management for terminal sessions
 * - Output parsing (questions, status, messages)
 * - WebSocket server for client connections
 * - Session lifecycle management
 *
 * Used by the daemon process that runs alongside Claude Code.
 */

// PTY module
export {
  PTYSession,
  PTYManager,
} from './pty/index.ts';
export type {
  PTYSessionConfig,
  PTYSessionEvents,
  TerminalSize,
  PTYManagerEvents,
} from './pty/index.ts';

// Parser module
export {
  stripAnsi,
  hasAnsi,
  cleanForParsing,
  splitLines,
  parseQuestion,
  hasQuestionIndicator,
  parseStatus,
  getToolFromStatus,
  isActive,
  OutputProcessor,
  processOutput,
} from './parser/index.ts';
export type {
  QuestionType,
  ParseResult,
  StatusResult,
  OutputEvents,
  ProcessorConfig,
} from './parser/index.ts';

// Server module
export {
  Connection,
  WebSocketServer,
} from './server/index.ts';
export type {
  ConnectionState,
  ConnectionEvents,
  ConnectionConfig,
  ServerConfig,
  ServerEvents,
} from './server/index.ts';

// Transcript module
export {
  TranscriptWatcher,
  TranscriptDiscovery,
} from './transcript/index.ts';
export type {
  TranscriptWatcherConfig,
  TranscriptWatcherEvents,
  TranscriptDiscoveryConfig,
  TranscriptEntry,
  UserEntry,
  AssistantEntry,
  ContentBlock,
} from './transcript/index.ts';
