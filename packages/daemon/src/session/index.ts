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

export {
  SessionRegistryFile,
  type LiveSessionEntry,
  claudeChildLooksAlive,
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
} from './session-registry-file.ts';
