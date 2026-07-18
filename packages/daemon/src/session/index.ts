/**
 * Session management module.
 * Handles session lifecycle independently of connections.
 */

export {
  SessionRegistry,
  type AttachResult,
  type ManagedSession,
  type SessionRegistryConfig,
  type SessionRegistryEvents,
} from './session-registry.ts';

export { SessionStore, type StoredSession } from './session-store.ts';

export { SessionBindingStore, type SessionBinding } from './session-binding-store.ts';

export { TranscriptIndex, type TranscriptIndexEntry } from './transcript-index.ts';

export {
  SessionRegistryFile,
  type LiveSessionEntry,
  type PendingQuestionEntry,
  claudeChildLooksAlive,
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
} from './session-registry-file.ts';

export {
  buildPendingQuestionLabel,
  PENDING_QUESTION_LABEL_MAX,
} from './pending-question-label.ts';

export { PendingQuestionCreatedAtTracker } from './pending-question-created-at-tracker.ts';
