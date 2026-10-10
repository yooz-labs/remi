/**
 * sharedEvents handlers for connection lifecycle:
 *   onConnect    - tracks a new connection, sends helloAck (optionally with
 *                  replay), and auto-attaches to the primary session unless
 *                  the client declared query mode. Any non-query connection
 *                  that attaches can read AND write (#795) — there is no
 *                  more exclusive write lock or FIFO queue to land in.
 *   onDisconnect - detaches from the session registry, untracks on the
 *                  AdapterRegistry, and decrements the StatusWriter
 *                  connection count. Device tokens deliberately persist
 *                  (until the push lease runs out, #1254): see the inline
 *                  note for the APNS rationale.
 *
 * The two handlers share the same "who owns a connection" machinery so they
 * live in one module, with a single dep bundle, to keep the wiring in cli.ts
 * consistent.
 */

import { createError, createHelloAck, createReplayBatch } from '@remi/shared';
import type { CreateHelloAckOptions, HarnessId, MachineDescriptor, UUID } from '@remi/shared';

import type { AdapterMetadata } from '../../adapters/index.ts';
import type { SessionRegistry } from '../../session/index.ts';
import { DAEMON_CAPABILITIES } from '../capabilities.ts';
import type { CurrentOwnedSession } from '../current-session.ts';
import { log } from '../logger.ts';
import { getPrimarySessionId } from '../session-state.ts';
import { resendPendingQuestions } from './pending-question-resend.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface ConnectionHandlerDeps {
  /** Read after identity initialization; undefined when authentication is disabled (#1234). */
  machine?: () => MachineDescriptor | undefined;
  sessionRegistry: SessionRegistry;
  /** Resolves the daemon's current owned session so every hello_ack carries the
   *  authoritative claudeSessionId + transcriptPath the client must follow (#499). */
  currentOwnedSession: () => CurrentOwnedSession | null;
  /**
   * The harness this daemon hosts. A hello_ack names it even when no session
   * record resolves, so a Codex daemon never claims to be Claude (#1179).
   */
  harnessId: HarnessId;
  /**
   * A hub is session-less by design and hosts no harness, so its session-less ack names none. Any
   * other daemon's does, even before its session exists (#1179 review, G9).
   */
  hubMode: boolean;
  /**
   * The harnesses this daemon can start (`HarnessRegistry.available`), read at
   * each ack so a command installed later is offered without a restart (#1179).
   */
  harnesses: () => readonly HarnessId[];
  /**
   * The capabilities named on every ack (#1237, ADR 0035): {@link DAEMON_CAPABILITIES} unless a
   * test gives another list to see it reach each ack.
   */
  capabilities?: readonly string[];
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
  /** The daemon's remi binary version, stamped on connection-time hello_acks
   *  so clients can flag a daemon running older code than the installed
   *  binary (#539). */
  remiVersion: string;
  /**
   * Hub client census hooks (#650): fired after a connection's hello_ack
   * (with the connect metadata for peer classification) and on disconnect.
   * Wired only by hub-mode daemons; undefined everywhere else.
   */
  onPeerConnect?: ((connectionId: UUID, metadata: AdapterMetadata) => void) | undefined;
  onPeerDisconnect?: ((connectionId: UUID) => void) | undefined;
  /** Any connection closed (#1254): the daemon marks the device behind it as
   *  seen now, so its push lease counts from the moment it left. */
  onConnectionClosed?: ((connectionId: UUID) => void) | undefined;
}

export type ConnectionHandlers = ReturnType<typeof createConnectionHandlers>;

export function createConnectionHandlers(deps: ConnectionHandlerDeps) {
  const {
    sessionRegistry,
    currentOwnedSession,
    harnessId,
    hubMode,
    harnesses,
    capabilities = DAEMON_CAPABILITIES,
    trackConnection,
    untrackConnection,
    onConnectionAdded,
    onConnectionRemoved,
    cancelOrphanTimeout,
    send,
    remiVersion,
    onPeerConnect,
    onPeerDisconnect,
    onConnectionClosed,
  } = deps;

  /**
   * Every hello_ack names the daemon's version, the harnesses it can start and its capabilities
   * (#539, #1179, #1237); `createHelloAck` adds the protocol version.
   */
  const ack = (sessionId: UUID | null, options: CreateHelloAckOptions = {}) => {
    const machine = deps.machine?.();
    return createHelloAck('1.0.0', sessionId, {
      ...options,
      daemonVersion: remiVersion,
      harnesses: machine?.harnesses ?? harnesses(),
      capabilities,
      machine,
    });
  };

  /** The current binding for hello_ack: who the session is, and the transcript it writes. */
  const currentBinding = () => {
    const current = currentOwnedSession();
    return {
      identity: current?.identity ?? { harness: harnessId, harnessSessionId: null },
      transcriptPath: current?.transcriptPath ?? null,
    };
  };

  return {
    onConnect: async (connectionId: UUID, metadata: AdapterMetadata): Promise<void> => {
      log(`Client connected: ${connectionId} (${metadata.adapterType})`);

      trackConnection(connectionId, metadata.adapterType);
      onConnectionAdded();

      // resumeSessionId and mode are only carried by the websocket adapter.
      // Telegram and relay clients have no equivalent (their adapter selects
      // session ownership differently).
      const platformData = metadata.platformData;
      const resumeSessionId =
        platformData?.kind === 'websocket'
          ? (platformData.resumeSessionId ?? undefined)
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
          const result = sessionRegistry.attachConnection(currentPrimary, connectionId);
          if (result.success) {
            send(
              connectionId,
              ack(currentPrimary, {
                resumeInfo: {
                  isResume: result.replayMessages.length > 0,
                  replayCount: result.replayMessages.length,
                  nextBulletId: result.nextBulletId,
                },
                binding: currentBinding(),
                attachState: result.attachState,
              }),
            );
            onPeerConnect?.(connectionId, metadata);
            if (result.replayMessages.length > 0) {
              send(connectionId, createReplayBatch(currentPrimary, result.replayMessages, true));
            }
            // #753: re-send the authoritative pending set as LIVE question
            // messages after the replay (see pending-question-resend.ts for
            // why replayed history cannot be trusted for pendingness).
            const resent = resendPendingQuestions(
              (m) => send(connectionId, m),
              currentPrimary,
              result.currentQuestions,
              currentBinding().identity,
            );
            if (resent > 0) {
              log(`Re-sent ${resent} pending question(s) to connection ${connectionId}`);
            }
            cancelOrphanTimeout();
            log(`Attached connection ${connectionId} to session ${currentPrimary}`);
            return;
          }
        }

        // Query mode, or a race where the session closed between the
        // currentPrimary read above and attachConnection (attach otherwise
        // always succeeds when the session exists, #795); send hello_ack
        // without attach so utility clients (ls, kill) can still send
        // requests. Still carry the binding so the client follows the
        // current session (#499).
        send(connectionId, ack(currentPrimary, { binding: currentBinding() }));
        onPeerConnect?.(connectionId, metadata);
        log(
          `Connection ${connectionId} connected without attach (${isQueryMode ? 'query mode' : 'attach race'})`,
        );
        return;
      }

      // No session available: still ack the connection with a null sessionId
      // rather than erroring out. This is the normal steady state for a
      // session-less hub daemon (#542) and also covers the brief startup
      // window on an ordinary daemon before its primary session is created,
      // whose ack names its harness: a Codex daemon must not read as Claude.
      send(connectionId, ack(null, hubMode ? {} : { harness: harnessId }));
      onPeerConnect?.(connectionId, metadata);
      log(`Connection ${connectionId} connected session-less (no active session)`);
    },

    onDisconnect: async (connectionId: UUID, reason: string): Promise<void> => {
      log(`Client disconnected: ${connectionId}`);
      log(`   Reason: ${reason}`);

      // Device tokens persist across disconnect on purpose: APNS push exists
      // precisely to deliver a notification while the iOS app is suspended
      // (i.e. disconnected). Removing the token on every drop made push a
      // no-op for the suspended-app case (issue #286). Tokens stay until an
      // explicit unregister_device_token message arrives, APNS reports the
      // token as bad, or the push lease runs out (#1254). `onConnectionClosed`
      // below marks the device seen now, so the lease counts from this close.

      sessionRegistry.detachConnection(connectionId);
      untrackConnection(connectionId);
      onConnectionRemoved();
      onPeerDisconnect?.(connectionId);
      onConnectionClosed?.(connectionId);
    },
  };
}
