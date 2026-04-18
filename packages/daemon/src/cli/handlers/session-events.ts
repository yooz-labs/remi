/**
 * sharedEvents handlers for whole-session lifecycle requests:
 *   onSessionListRequest, enumerate daemon + external sessions
 *   onKillSessionRequest, tear down a session (and notify any active client)
 *   onDetachSession, release a session's active connection without killing it
 *
 * These three are grouped because they all operate on session records via
 * `sessionRegistry` and speak the kill/detach/list protocol back to the
 * caller. External-session discovery (list) and third-party detach (detach)
 * need a couple of extra injected seams: a port getter (PORT is mutated
 * during port probing in daemon mode), a connection-untrack callback on the
 * AdapterRegistry, and a connection-count decrement callback on the
 * StatusWriter. Everything else flows through `sessionRegistry`.
 */

import {
  createDetachSessionAck,
  createError,
  createKillSessionResponse,
  createSessionListResponse,
} from '@remi/shared';
import type { UUID } from '@remi/shared';

import type { SessionRegistry, SessionRegistryFile, SessionStore } from '../../session/index.ts';
import type { TranscriptDiscovery } from '../../transcript/index.ts';
import { log } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface SessionHandlerDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  transcriptDiscovery: TranscriptDiscovery;
  liveSessionsRegistry: SessionRegistryFile;
  /** PORT is reassigned during daemon-mode port probing; read lazily. */
  currentPort: () => number;
  /** Untrack a connection on the AdapterRegistry (third-party detach only). */
  untrackConnection: (connectionId: UUID) => void;
  /** Decrement the statusWriter connection count (third-party detach only). */
  onConnectionRemoved: () => void;
  send: SendToConnection;
}

export type SessionHandlers = ReturnType<typeof createSessionHandlers>;

export function createSessionHandlers(deps: SessionHandlerDeps) {
  const {
    sessionRegistry,
    sessionStore,
    transcriptDiscovery,
    liveSessionsRegistry,
    currentPort,
    untrackConnection,
    onConnectionRemoved,
    send,
  } = deps;

  return {
    onSessionListRequest: (connectionId: UUID, requestId: UUID, includeExternal: boolean): void => {
      const daemonSessions = sessionRegistry.listSessions();
      let allSessions = [...daemonSessions];

      if (includeExternal) {
        const managedIds = new Set<string>(sessionRegistry.getActiveSessionIds());
        // Also exclude by Claude session ID (JSONL filename UUID is a different namespace from remi IDs).
        for (const remiId of [...managedIds]) {
          const stored = sessionStore.findByRemiSessionId(remiId as UUID);
          if (stored?.claudeSessionId) {
            managedIds.add(stored.claudeSessionId);
          }
        }
        const externalSessions = transcriptDiscovery.discoverSessions(managedIds);
        allSessions = [...daemonSessions, ...externalSessions];
      }

      log(
        `Session list request from ${connectionId}: ${allSessions.length} sessions ` +
          `(${daemonSessions.length} daemon, ${allSessions.length - daemonSessions.length} external)`,
      );
      // Include other daemon ports on this machine so the app can auto-connect.
      const port = currentPort();
      const livePorts = liveSessionsRegistry.getLivePorts().filter((p) => p !== port);
      send(connectionId, createSessionListResponse(allSessions, requestId, livePorts));
    },

    onKillSessionRequest: (connectionId: UUID, sessionId: UUID, requestId: UUID): void => {
      log(`Kill session request from ${connectionId} for session ${sessionId}`);

      const session = sessionRegistry.getSession(sessionId);
      if (!session) {
        send(
          connectionId,
          createKillSessionResponse(false, requestId, `Session ${sessionId} not found`),
        );
        return;
      }

      const sessionName = session.name;
      log(`Killing session: ${sessionName} (${sessionId})`);

      // Notify attached client before destroying the session.
      if (session.activeConnectionId && session.activeConnectionId !== connectionId) {
        send(
          session.activeConnectionId,
          createError('SESSION_ENDED', 'Session killed by remote request'),
        );
      }

      const hadActiveClient =
        session.activeConnectionId !== null && session.activeConnectionId !== connectionId;
      sessionRegistry.closeSession(sessionId, 'forced');
      send(connectionId, createKillSessionResponse(true, requestId));
      if (hadActiveClient) {
        log(`Session killed: ${sessionName} (disconnected attached client)`);
      } else {
        log(`Session killed: ${sessionName}`);
      }
    },

    onDetachSession: (connectionId: UUID, sessionId: UUID, _requestId: UUID): void => {
      log(`Detach session request from ${connectionId} for session ${sessionId}`);

      const session = sessionRegistry.getSession(sessionId);
      if (!session) {
        send(
          connectionId,
          createDetachSessionAck(sessionId, false, `Session ${sessionId} not found`),
        );
        return;
      }

      const activeConnId = session.activeConnectionId;
      if (activeConnId === null) {
        send(connectionId, createDetachSessionAck(sessionId, false, 'Session is already detached'));
        return;
      }

      // Send ack to the requesting connection. It may be the active client
      // itself, or a separate query-mode client (like `remi detach <session>`).
      const ackSent = send(connectionId, createDetachSessionAck(sessionId, true));
      if (!ackSent) {
        log(`Warning: detach ack could not be delivered to ${connectionId}`);
      }

      // Detach the ACTIVE connection (not necessarily the requesting one).
      // Only untrack + decrement here for third-party detach
      // (connectionId !== activeConnId). For self-detach, onDisconnect will
      // clean up when the WebSocket actually closes.
      sessionRegistry.detachConnection(activeConnId, true);
      if (activeConnId !== connectionId) {
        untrackConnection(activeConnId);
        onConnectionRemoved();
      }

      log(
        `Session explicitly detached: ${session.name} (active connection ${activeConnId} detached)`,
      );
    },
  };
}
