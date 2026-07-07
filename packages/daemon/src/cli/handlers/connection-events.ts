/**
 * sharedEvents handlers for connection lifecycle:
 *   onConnect    - tracks a new connection, sends helloAck (optionally with
 *                  replay), and auto-attaches to the primary session unless
 *                  the client declared query mode
 *   onDisconnect - detaches from the session registry, untracks on the
 *                  AdapterRegistry, and decrements the StatusWriter
 *                  connection count. Device tokens deliberately persist:
 *                  see the inline note for the APNS rationale.
 *
 * The two handlers share the same "who owns a connection" machinery so they
 * live in one module, with a single dep bundle, to keep the wiring in cli.ts
 * consistent.
 */

import { createError, createHelloAck, createReplayBatch } from '@remi/shared';
import type { UUID } from '@remi/shared';

import type { AdapterMetadata } from '../../adapters/index.ts';
import type { SessionRegistry } from '../../session/index.ts';
import type { CurrentOwnedSession } from '../current-session.ts';
import { log } from '../logger.ts';
import { getPrimarySessionId } from '../session-state.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface ConnectionHandlerDeps {
  sessionRegistry: SessionRegistry;
  /** Resolves the daemon's current owned session so every hello_ack carries the
   *  authoritative claudeSessionId + transcriptPath the client must follow (#499). */
  currentOwnedSession: () => CurrentOwnedSession | null;
  /** Forward to AdapterRegistry.trackConnection. */
  trackConnection: (connectionId: UUID, adapterType: string) => void;
  /** Forward to AdapterRegistry.untrackConnection. */
  untrackConnection: (connectionId: UUID) => void;
  /** Increment StatusWriter connection count. */
  onConnectionAdded: () => void;
  /** Decrement StatusWriter connection count. */
  onConnectionRemoved: () => void;
  /** Cancel the SIGHUP orphan-shutdown timer after a remote client attaches. */
  cancelOrphanTimeout: () => void;
  send: SendToConnection;
}

export type ConnectionHandlers = ReturnType<typeof createConnectionHandlers>;

export function createConnectionHandlers(deps: ConnectionHandlerDeps) {
  const {
    sessionRegistry,
    currentOwnedSession,
    trackConnection,
    untrackConnection,
    onConnectionAdded,
    onConnectionRemoved,
    cancelOrphanTimeout,
    send,
  } = deps;

  /** The current binding for hello_ack: {claudeSessionId, transcriptPath}. */
  const currentBinding = (): { claudeSessionId: UUID | null; transcriptPath: string | null } => {
    const current = currentOwnedSession();
    return {
      claudeSessionId: current?.claudeSessionId ?? null,
      transcriptPath: current?.transcriptPath ?? null,
    };
  };

  return {
    onConnect: async (connectionId: UUID, metadata: AdapterMetadata): Promise<void> => {
      log(`Client connected: ${connectionId} (${metadata.adapterType})`);

      trackConnection(connectionId, metadata.adapterType);
      onConnectionAdded();

      // resumeSessionId, mode, deviceId, and clientFingerprint are only
      // carried by the websocket adapter. Telegram and relay clients have no
      // equivalent (their adapter selects session ownership differently).
      const platformData = metadata.platformData;
      const resumeSessionId =
        platformData?.kind === 'websocket'
          ? (platformData.resumeSessionId ?? undefined)
          : undefined;
      const deviceId =
        platformData?.kind === 'websocket' ? (platformData.deviceId ?? undefined) : undefined;
      // Authenticated identity bound to deviceId (#671); undefined when this
      // connection has no authenticated identity (auth disabled, or a
      // loopback-exempt peer) — attachConnection then falls back to
      // deviceId-only reclaim matching.
      const clientFingerprint =
        platformData?.kind === 'websocket'
          ? (platformData.clientFingerprint ?? undefined)
          : undefined;
      const currentPrimary = getPrimarySessionId();

      // Unified connection flow: one session per daemon, both modes behave the same.
      // If a resumeSessionId is provided, validate it matches our session.
      if (resumeSessionId && currentPrimary && resumeSessionId !== currentPrimary) {
        log(`Resume ID mismatch: requested ${resumeSessionId}, daemon has ${currentPrimary}`);
        send(
          connectionId,
          createError(
            'SESSION_NOT_FOUND',
            `Session ${resumeSessionId} not found on this daemon. Active session: ${currentPrimary}.`,
          ),
        );
        return;
      }

      // Try to attach to the primary (only) session.
      const isQueryMode = platformData?.kind === 'websocket' && platformData.mode === 'query';
      if (currentPrimary) {
        // Only auto-attach if the client wants to attach, not a utility client like ls/kill.
        if (!isQueryMode) {
          const result = sessionRegistry.attachConnection(
            currentPrimary,
            connectionId,
            deviceId,
            clientFingerprint,
          );
          if (result.success) {
            send(
              connectionId,
              createHelloAck(
                '1.0.0',
                currentPrimary,
                {
                  isResume: result.replayMessages.length > 0,
                  replayCount: result.replayMessages.length,
                  nextBulletId: result.nextBulletId,
                },
                currentBinding(),
                result.attachState,
              ),
            );
            if (result.replayMessages.length > 0) {
              send(connectionId, createReplayBatch(currentPrimary, result.replayMessages, true));
            }
            cancelOrphanTimeout();
            log(
              `${result.attachState === 'queued' ? 'Queued' : 'Attached'} connection ${connectionId} ${result.attachState === 'queued' ? 'behind' : 'to'} session ${currentPrimary}`,
            );
            return;
          }
        }

        // Query mode or attach failed (session busy); send hello_ack without
        // attach so utility clients (ls, kill) can still send requests. Still
        // carry the binding so the client follows the current session (#499).
        send(connectionId, createHelloAck('1.0.0', currentPrimary, undefined, currentBinding()));
        log(
          `Connection ${connectionId} connected without attach (${isQueryMode ? 'query mode' : 'session busy'})`,
        );
        return;
      }

      // No session available.
      send(connectionId, createError('NO_SESSION', 'No active session available'));
    },

    onDisconnect: async (connectionId: UUID, reason: string): Promise<void> => {
      log(`Client disconnected: ${connectionId}`);
      log(`   Reason: ${reason}`);

      // Device tokens persist across disconnect on purpose: APNS push exists
      // precisely to deliver a notification while the iOS app is suspended
      // (i.e. disconnected). Removing the token on every drop made push a
      // no-op for the suspended-app case (issue #286). Tokens stay until
      // an explicit unregister_device_token message arrives or APNS reports
      // the token as bad. See #308 for the explicit-disconnect follow-up.

      // Explicitly remove from the waiting queue, then detach if active.
      // detachConnection also handles waiting removal, but this ensures
      // cleanup even if detachConnection's early-return path changes.
      sessionRegistry.removeWaitingConnection(connectionId);
      sessionRegistry.detachConnection(connectionId);
      untrackConnection(connectionId);
      onConnectionRemoved();
    },
  };
}
