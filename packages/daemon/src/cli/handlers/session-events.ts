/**
 * sharedEvents handlers for whole-session lifecycle requests:
 *   onSessionListRequest, enumerate daemon + external sessions
 *   onKillSessionRequest, gracefully end a session (type Claude /exit, with a
 *     force-close fallback) and notify any active client
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
  errorToString,
} from '@remi/shared';
import type { UUID } from '@remi/shared';

import type {
  SessionBindingStore,
  SessionRegistry,
  SessionRegistryFile,
} from '../../session/index.ts';
import type { TranscriptDiscovery } from '../../transcript/index.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface SessionHandlerDeps {
  sessionRegistry: SessionRegistry;
  bindingStore: SessionBindingStore;
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

/**
 * How long to wait for a graceful `/exit` to land before force-closing the
 * session. Covers a Claude that ignores /exit because it is stuck mid-task.
 */
const EXIT_FALLBACK_MS = 8000;

export type SessionHandlers = ReturnType<typeof createSessionHandlers>;

export function createSessionHandlers(deps: SessionHandlerDeps) {
  const {
    sessionRegistry,
    bindingStore,
    transcriptDiscovery,
    liveSessionsRegistry,
    currentPort,
    untrackConnection,
    onConnectionRemoved,
    send,
  } = deps;

  // In-flight graceful stops (#641). A Stop types `/exit` and returns; the
  // success ack + SESSION_ENDED notice are deferred to `resolveStopOnClose`
  // (driven by the registry's onSessionClosed) so "success" means the session
  // actually ended — not merely "stop initiated" — and the third-party notice
  // arrives after PTY output has stopped. Keyed by sessionId.
  interface PendingStop {
    readonly connectionId: UUID;
    readonly requestId: UUID;
    /** Active client to notify with SESSION_ENDED, if it isn't the requester. */
    readonly notifyConnectionId: UUID | null;
    readonly fallbackTimer: ReturnType<typeof setTimeout>;
  }
  const pendingStops = new Map<UUID, PendingStop>();

  /**
   * Resolve a deferred Stop once the session has actually closed. Call from the
   * registry's onSessionClosed for every close reason; a no-op when the session
   * ended on its own (no pending Stop). Cancels the force-fallback, notifies a
   * third-party client, and acks the requester.
   */
  function resolveStopOnClose(sessionId: UUID): void {
    const pending = pendingStops.get(sessionId);
    if (!pending) return;
    pendingStops.delete(sessionId);
    clearTimeout(pending.fallbackTimer);
    if (pending.notifyConnectionId) {
      send(pending.notifyConnectionId, createError('SESSION_ENDED', 'Session ended by request'));
    }
    send(pending.connectionId, createKillSessionResponse(true, pending.requestId));
  }

  return {
    onSessionListRequest: (connectionId: UUID, requestId: UUID, includeExternal: boolean): void => {
      // Decorate daemon-sourced sessions with their pre-assigned Claude
      // binding (#429). transcriptPath is derived from the same encoding
      // rule transcript-discovery uses, so the client can show "you are
      // talking to port X / claude <short-uuid>" without round-tripping.
      // A failed lookup on any one entry must not nuke the entire list
      // response — the connection would hang waiting for a reply. Fall
      // back to the undecorated entry on per-entry failure.
      const daemonSessionsRaw = sessionRegistry.listSessions();
      const daemonSessions = daemonSessionsRaw.map((s) => {
        try {
          const binding = bindingStore.get(s.sessionId as UUID);
          if (!binding?.claudeSessionId) return s;
          const transcriptPath = `${transcriptDiscovery.getProjectTranscriptDir(s.projectPath)}/${binding.claudeSessionId}.jsonl`;
          return { ...s, claudeSessionId: binding.claudeSessionId, transcriptPath };
        } catch (err) {
          logError(
            `[SessionList] Failed to decorate session ${s.sessionId.slice(0, 8)}; serving raw entry: ${errorToString(err)}`,
          );
          return s;
        }
      });
      let allSessions = [...daemonSessions];

      if (includeExternal) {
        const managedIds = new Set<string>(sessionRegistry.getActiveSessionIds());
        // Also exclude by Claude session ID (JSONL filename UUID is a different namespace from remi IDs).
        // Per-entry try/catch (mirrors the decoration loop above): a disk hiccup on
        // one lookup must not throw out of this void handler and hang the whole
        // session-list response — degrade to a possibly-incomplete exclude set.
        for (const remiId of [...managedIds]) {
          try {
            const binding = bindingStore.get(remiId as UUID);
            if (binding?.claudeSessionId) {
              managedIds.add(binding.claudeSessionId);
            }
          } catch (err) {
            logError(
              `[SessionList] binding lookup failed for ${remiId.slice(0, 8)}; external exclusion may be incomplete: ${errorToString(err)}`,
            );
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
      log(`Stop session request from ${connectionId} for session ${sessionId}`);

      const session = sessionRegistry.getSession(sessionId);
      if (!session) {
        send(
          connectionId,
          createKillSessionResponse(false, requestId, `Session ${sessionId} not found`),
        );
        return;
      }

      // Idempotent: a Stop already in flight just re-acks on close.
      if (pendingStops.has(sessionId)) {
        log(`Stop already in flight for ${session.name}; ignoring duplicate request`);
        return;
      }

      const sessionName = session.name;
      log(`Stopping session: ${sessionName} (${sessionId})`);

      // Graceful stop (#641): type `/exit` on our own PTY so Claude quits cleanly
      // (flushing its transcript + emitting the resume hint) and the PTY-exit path
      // tears the session down and frees the daemon. Writing to our own PTY avoids
      // the write-lock requirement a client-side input would have. A force-close
      // fallback covers a Claude that ignores /exit (e.g. stuck mid-task).
      session.pty.submitInput('/exit').catch((err) => {
        logError(
          `[Stop] /exit write failed for ${sessionName}; forcing close: ${errorToString(err)}`,
        );
        sessionRegistry.closeSession(sessionId, 'forced');
      });
      const fallbackTimer = setTimeout(() => {
        if (sessionRegistry.getSession(sessionId)) {
          log(`Session ${sessionName} did not exit on /exit within ${EXIT_FALLBACK_MS}ms; forcing`);
          sessionRegistry.closeSession(sessionId, 'forced');
        }
      }, EXIT_FALLBACK_MS);
      // Don't let the fallback timer keep the event loop (or process) alive.
      fallbackTimer.unref?.();

      // Defer the ack + the third-party SESSION_ENDED notice until the session
      // actually closes (resolveStopOnClose), so success means done and the
      // notice arrives after PTY output stops.
      const notifyConnectionId =
        session.activeConnectionId && session.activeConnectionId !== connectionId
          ? session.activeConnectionId
          : null;
      pendingStops.set(sessionId, { connectionId, requestId, notifyConnectionId, fallbackTimer });
      log(`Session stop initiated: ${sessionName}`);
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

    /** Resolve a deferred Stop on session close; wired to onSessionClosed in cli.ts. */
    resolveStopOnClose,
  };
}
