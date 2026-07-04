/**
 * Multi-daemon connection manager hook.
 *
 * Manages N simultaneous WebSocket connections to different daemons.
 * Each connection has its own auth state, session, and message routing.
 * WebSocketClient instances are created per connection and stored in a Map.
 * Connections are keyed by host:port; connecting to the same endpoint replaces any existing connection.
 */

import {
  checkKnownHost,
  ensureIdentity,
  isIdentityEncrypted,
  trustHost,
  unlockStoredIdentity,
} from '@/lib/identity-client';
import { DAEMON_BASE_PORT, errorToString } from '@remi/shared';
import { WebSocketClient, type WebSocketClientConfig } from '@/lib/websocket-client';
import type { ConnectionId, ConnectionState, ConnectionStatus } from '@/types';
import type { UnlockedIdentity } from '@remi/shared';
import {
  allocateStaggerSlot,
  collectPendingChallengeConnections,
  type ForceReconnectCandidate,
  getOrCreateDeviceId,
  planForceReconnect,
} from './connection-manager-helpers';
import { splitConnectionId } from '@/lib/connection-id';
import { buildWsUrl, parseHostInput, resolveDaemonPort } from '@/lib/port-discovery';
import { createAuthResponse, fromBase64, importPublicKey, sign, verify } from '@remi/shared';
import type { AnswerSelection, ProtocolMessage } from '@remi/shared/protocol.ts';
import {
  createAnswer,
  createAuqAnswer,
  createBulletExpandRequest,
  createCancelQuestion,
  createCreateSessionRequest,
  createHello,
  createResumeSessionRequest,
  createSessionHistoryRequest,
  createSessionListRequest,
  createTranscriptLoadRequest,
  createUserInput,
} from '@remi/shared/protocol.ts';
import type { UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

function makeConnectionId(raw: string): ConnectionId {
  return raw as ConnectionId;
}

/**
 * Stagger tuning shared by both reconnect-stampede fixes: fixed spacing per
 * connection slot, so N daemons don't all visibly drop and reconnect in the
 * same instant -- whether triggered by an explicit app-force-reconnect sweep
 * (#664, `staggerStepMs` below) or by each connection's own heartbeat
 * independently detecting staleness (#685, `reconnectStaggerMs` below).
 */
const CONNECTION_STAGGER_STEP_MS = 300;
const FORCE_RECONNECT_STAGGER_JITTER_MS = 2000;

/** Internal per-connection state */
interface ManagedConnection {
  client: WebSocketClient;
  connectionId: ConnectionId;
  url: string;
  mode: 'direct' | 'relay';
  status: ConnectionStatus;
  error: Error | null;
  sessionId: UUID | null;
  /**
   * Whether this connection holds the session's exclusive write lock
   * ('attached') or is read-only, queued behind another connection
   * ('queued') (#662). `undefined` before the first hello_ack, or when the
   * daemon didn't send the field (older daemon, or a hello_ack sent outside
   * the attach flow). Surfaced so a follow-up (#663) can render a
   * read-only/waiting state instead of the user believing their input sent.
   */
  attachState?: 'attached' | 'queued';
  helloSent: boolean;
  pendingChallenge: {
    challenge: string;
    serverPublicKey: string;
    serverFingerprint: string;
  } | null;
  needsPassphrase: boolean;
  serverFingerprint: string | null;
  directory?: string;
  /** True while escalateReconnect is probing; prevents concurrent escalations
   *  racing reconnectWithUrl against themselves (#435). */
  escalating?: boolean;
  /** Heartbeat-reconnect stagger slot allocated to this connection's
   *  `WebSocketClient` (#685, `allocateStaggerSlot`). Released back to
   *  `usedStaggerSlotsRef` when this connection is torn down, so a later
   *  connection can reuse it instead of growing the offset forever. */
  staggerSlot: number;
}

/** Hook options */
export interface UseConnectionManagerOptions {
  /** Message handler: receives connectionId and the protocol message */
  onMessage?: (connectionId: ConnectionId, message: ProtocolMessage) => void;
  /** Pre-unlocked identity (shared across all connections) */
  unlockedIdentity?: UnlockedIdentity | null;
  /** Client ID for identification */
  clientId?: string;
  /** Client version */
  clientVersion?: string;
  /** Whether to automatically reconnect on connection drop (default: true) */
  autoReconnect?: boolean;
}

/** Hook return value */
export interface UseConnectionManagerReturn {
  /** All active connections (reactive) */
  connections: readonly ConnectionState[];
  /** Add a new direct connection. Returns connectionId. */
  connectDirect: (url: string, directory?: string) => ConnectionId;
  /** Disconnect a specific connection */
  disconnect: (connectionId: ConnectionId) => void;
  /** Retry a connection by re-running port discovery against its host (#435). */
  reconnect: (connectionId: ConnectionId) => void;
  /** Disconnect all connections */
  disconnectAll: () => void;
  /**
   * Send user input routed to the correct connection. `id`, when passed,
   * is used as the wire message id instead of generating a fresh one --
   * callers retrying a timed-out send (#663) pass the ORIGINAL id back in
   * so the daemon's dedup makes the retry idempotent.
   */
  sendInput: (
    connectionId: ConnectionId,
    sessionId: UUID,
    content: string,
    claudeSessionId?: UUID,
    id?: UUID,
  ) => boolean;
  /** Send a bare Esc keystroke to the session (interrupt / escape any prompt). */
  sendEscape: (connectionId: ConnectionId, sessionId: UUID, claudeSessionId?: UUID) => boolean;
  /** Send answer to a question via the correct connection */
  sendAnswer: (
    connectionId: ConnectionId,
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    claudeSessionId?: UUID,
  ) => boolean;
  /** #627: send a structured AskUserQuestion answer (per-sub-question selections). */
  sendAuqAnswer: (
    connectionId: ConnectionId,
    sessionId: UUID,
    questionId: UUID,
    selections: readonly AnswerSelection[],
    claudeSessionId?: UUID,
  ) => boolean;
  /** #627: cancel/escape the active prompt (sends Esc to the TUI). */
  sendCancelQuestion: (
    connectionId: ConnectionId,
    sessionId: UUID,
    questionId: UUID,
    claudeSessionId?: UUID,
  ) => boolean;
  /** Send a raw protocol message to a specific connection */
  sendMessage: (connectionId: ConnectionId, message: ProtocolMessage) => boolean;
  /** Request bullet expand via a specific connection */
  requestBulletExpand: (connectionId: ConnectionId, sessionId: UUID, bulletId: number) => boolean;
  /** Request session list from a specific connection */
  requestSessionList: (connectionId: ConnectionId, includeExternal?: boolean) => boolean;
  /** Request transcript load via a specific connection */
  requestTranscriptLoad: (connectionId: ConnectionId, sessionId: string) => boolean;
  /** Request new session via a specific connection */
  requestNewSession: (connectionId: ConnectionId, directory?: string) => boolean;
  /** Request resume session via a specific connection */
  requestResumeSession: (connectionId: ConnectionId, sessionId: string) => boolean;
  /** Request session history via a specific connection */
  requestSessionHistory: (connectionId: ConnectionId, limit?: number) => boolean;
  /** Provide unlocked identity for a connection needing passphrase */
  provideIdentity: (connectionId: ConnectionId, identity: UnlockedIdentity) => void;
  /** Get the hello_ack session ID for a connection (reads from live state, not React state) */
  getSessionId: (connectionId: ConnectionId) => string | null;
  /** Whether any connection needs a passphrase */
  needsPassphrase: boolean;
  /** The connectionId that needs a passphrase (if any) */
  passphraseConnectionId: ConnectionId | null;
  /** Server fingerprint for the connection needing passphrase */
  passphraseServerFingerprint: string | null;
}

/** Derive connectionId (host:port) from a WebSocket URL. Falls back to the
 * default daemon port if not specified. */
export function parseConnectionId(url: string): ConnectionId {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || 'localhost';
    const port = parsed.port || String(DAEMON_BASE_PORT);
    return makeConnectionId(`${host}:${port}`);
  } catch (err) {
    console.warn(`[ConnectionManager] Failed to parse URL "${url}":`, err);
    return makeConnectionId(url);
  }
}

/** Sign an auth challenge with the given identity */
async function signChallenge(
  identity: UnlockedIdentity,
  challenge: string,
): Promise<ProtocolMessage> {
  const challengeData = fromBase64(challenge);
  const signature = await sign(identity.privateKey, challengeData);
  return createAuthResponse(identity.publicKeyRaw, signature, identity.fingerprint);
}

/** Derive ConnectionState from ManagedConnection (for React state) */
function toConnectionState(mc: ManagedConnection): ConnectionState {
  return {
    connectionId: mc.connectionId,
    url: mc.url,
    status: mc.status,
    mode: mc.mode,
    needsPassphrase: mc.needsPassphrase,
    serverFingerprint: mc.serverFingerprint,
    error: mc.error?.message ?? null,
    sessionId: mc.sessionId,
    attachState: mc.attachState ?? null,
  };
}

export function useConnectionManager(
  options: UseConnectionManagerOptions = {},
): UseConnectionManagerReturn {
  const {
    onMessage,
    unlockedIdentity,
    clientId = 'remi-web',
    clientVersion = '0.0.1',
    autoReconnect = true,
  } = options;

  const connectionsMapRef = useRef<Map<ConnectionId, ManagedConnection>>(new Map());
  const [connectionsState, setConnectionsState] = useState<readonly ConnectionState[]>([]);
  const onMessageRef = useRef(onMessage);
  const identityRef = useRef<UnlockedIdentity | null>(unlockedIdentity ?? null);
  const autoReconnectRef = useRef(autoReconnect);
  /** Stagger slots currently held by live connections (#685,
   *  `allocateStaggerSlot`). Each new WebSocketClient claims the smallest
   *  free slot for its heartbeat-reconnect offset (`slot *
   *  CONNECTION_STAGGER_STEP_MS`); a connection's slot is released back to
   *  this set when it's torn down, so a long session that repeatedly
   *  recreates a still-unreachable connection can't grow offsets forever or
   *  collide with a stable sibling. */
  const usedStaggerSlotsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (unlockedIdentity) {
      identityRef.current = unlockedIdentity;
    }
  }, [unlockedIdentity]);

  useEffect(() => {
    autoReconnectRef.current = autoReconnect;
  }, [autoReconnect]);

  /** Re-derive React state from the Map */
  const syncState = useCallback(() => {
    const states = Array.from(connectionsMapRef.current.values()).map(toConnectionState);
    setConnectionsState(states);
  }, []);

  /** Get a managed connection by ID */
  const getMc = useCallback((connectionId: ConnectionId): ManagedConnection | undefined => {
    return connectionsMapRef.current.get(connectionId);
  }, []);

  /** Send hello to a specific connection's client */
  const sendHello = useCallback(
    (mc: ManagedConnection) => {
      if (mc.helloSent) return;
      mc.helloSent = true;
      const resumeId = mc.sessionId ?? undefined;
      mc.client.send(
        createHello(clientId, clientVersion, {
          directory: mc.directory,
          resumeSessionId: resumeId,
          // Same-device lock reclaim (#662): lets the daemon recognize this
          // hello as the same physical client reconnecting after a dead
          // connection, instead of queuing it behind a socket that will
          // never come back.
          deviceId: getOrCreateDeviceId(window.localStorage),
        }),
      );
    },
    [clientId, clientVersion],
  );

  /** Handle auth_challenge for a specific connection */
  const handleAuthChallenge = useCallback(
    async (
      mc: ManagedConnection,
      challenge: string,
      srvFingerprint: string,
      srvPublicKey: string,
    ) => {
      mc.serverFingerprint = srvFingerprint;

      // Trust On First Use (TOFU): check known hosts
      const tofuResult = checkKnownHost(mc.url, srvFingerprint);
      if (tofuResult === 'mismatch') {
        mc.error = new Error(
          `Server fingerprint changed for ${mc.url}. ` +
            'This could indicate a MITM attack. Connection rejected.',
        );
        mc.client.disconnect();
        syncState();
        return;
      }

      mc.pendingChallenge = {
        challenge,
        serverPublicKey: srvPublicKey,
        serverFingerprint: srvFingerprint,
      };

      let identity = identityRef.current;
      if (!identity) {
        try {
          await ensureIdentity();
          if (!isIdentityEncrypted()) {
            identity = await unlockStoredIdentity();
            identityRef.current = identity;
          } else {
            mc.needsPassphrase = true;
            syncState();
            return;
          }
        } catch (err) {
          mc.error = new Error(
            `Identity setup failed: ${errorToString(err)}`,
          );
          mc.client.disconnect();
          syncState();
          return;
        }
      }

      try {
        const response = await signChallenge(identity, challenge);
        mc.client.send(response);
      } catch (err) {
        mc.error = new Error(`Auth failed: ${errorToString(err)}`);
        mc.client.disconnect();
        syncState();
      }
    },
    [syncState],
  );

  /** Handle auth_result for a specific connection */
  const handleAuthResult = useCallback(
    async (
      mc: ManagedConnection,
      success: boolean,
      authError: string | undefined,
      srvSignature: string | undefined,
    ) => {
      if (!success) {
        mc.error = new Error(`Authentication failed: ${authError ?? 'unknown error'}`);
        mc.client.disconnect();
        syncState();
        return;
      }

      if (!srvSignature || !mc.pendingChallenge) {
        mc.error = new Error('Server did not provide mutual authentication signature');
        mc.client.disconnect();
        syncState();
        return;
      }

      try {
        const serverPubKey = await importPublicKey(fromBase64(mc.pendingChallenge.serverPublicKey));
        const challengeData = fromBase64(mc.pendingChallenge.challenge);
        const valid = await verify(serverPubKey, challengeData, srvSignature);
        if (!valid) {
          mc.error = new Error('Server signature verification failed');
          mc.client.disconnect();
          syncState();
          return;
        }
      } catch (err) {
        mc.error = new Error(
          `Server verification error: ${errorToString(err)}`,
        );
        mc.client.disconnect();
        syncState();
        return;
      }

      // TOFU: trust on first use
      const pending = mc.pendingChallenge;
      trustHost(mc.url, pending.serverFingerprint, pending.serverPublicKey);

      mc.pendingChallenge = null;
      mc.needsPassphrase = false;

      // Auth complete; reset helloSent flag so sendHello dispatches the authenticated hello
      mc.helloSent = false;
      mc.client.setConnected();
      sendHello(mc);
      syncState();
    },
    [sendHello, syncState],
  );

  /** Create message handler for a specific connectionId */
  const createMessageHandler = useCallback(
    (connectionId: ConnectionId) => {
      return (message: ProtocolMessage) => {
        const mc = connectionsMapRef.current.get(connectionId);
        if (!mc) {
          console.debug(
            `[ConnectionManager] Dropping message for disconnected connection "${connectionId}":`,
            message.type,
          );
          return;
        }

        // Intercept auth messages
        if (message.type === 'auth_challenge') {
          handleAuthChallenge(
            mc,
            message.challenge,
            message.serverFingerprint,
            message.serverPublicKey,
          ).catch((err) => {
            mc.error = err instanceof Error ? err : new Error(String(err));
            mc.client.disconnect();
            syncState();
          });
          return;
        }

        if (message.type === 'auth_result') {
          handleAuthResult(mc, message.success, message.error, message.serverSignature).catch(
            (err) => {
              mc.error = err instanceof Error ? err : new Error(String(err));
              mc.client.disconnect();
              syncState();
            },
          );
          return;
        }

        // Track session ID + attach state from hello_ack
        if (message.type === 'hello_ack') {
          mc.sessionId = message.sessionId;
          mc.attachState = message.attachState;
          if (mc.client && !mc.client.isConnected) {
            mc.client.setConnected();
          }
          syncState();
        }

        // Forward to app handler with connectionId context
        onMessageRef.current?.(connectionId, message);
      };
    },
    [handleAuthChallenge, handleAuthResult, syncState],
  );

  // Reconnect escalation: auto-reconnect exhausted the ceiling on the current
  // port. Re-resolve the daemon's port from the host (the old port is hinted
  // first, then the full range is scanned). Reconnect on the winner, or fall
  // to a terminal 'unreachable' state if nothing answers. (#435 Phase 1 / P3)
  //
  // Self-contained error handling: callers dispatch this as `void
  // escalateReconnect(mc)`, so any throw must NOT become an unhandled rejection
  // (which would freeze the connection in 'reconnecting'). The re-entry guard
  // prevents a concurrent probe from racing reconnectWithUrl against itself.
  const escalateReconnect = useCallback(
    async (mc: ManagedConnection): Promise<void> => {
      if (mc.escalating) return;
      mc.escalating = true;

      const { host, port } = splitConnectionId(mc.connectionId);
      // Set 'reconnecting' directly (the client emits onReconnectExhausted,
      // not a status). The client's own keep-alive already stopped itself
      // when the transport closed (WebSocketClient#handleClose).
      mc.status = 'reconnecting';
      mc.error = null;
      syncState();
      console.debug(`[ConnectionManager] escalate ${mc.connectionId}: probing ${host}`);

      try {
        const resolved = await resolveDaemonPort(host, port);
        // Bail if the connection was torn down (or replaced) while probing.
        if (connectionsMapRef.current.get(mc.connectionId) !== mc) return;

        if (resolved === null) {
          console.warn(`[ConnectionManager] no daemon on ${host}; marking unreachable`);
          mc.status = 'unreachable';
          mc.error = new Error(`No daemon answered on ${host}`);
          syncState();
          return;
        }

        const newUrl = buildWsUrl(parseHostInput(host), resolved);
        mc.url = newUrl;
        console.debug(`[ConnectionManager] resolved ${host}:${resolved}; reconnecting`);
        // status flows back to 'connecting'/'authenticating' via onStatusChange.
        mc.client.reconnectWithUrl(newUrl);
      } catch (err) {
        // resolveDaemonPort is reject-proof today, but a runtime fault here must
        // not freeze the connection. Surface it as the terminal state.
        if (connectionsMapRef.current.get(mc.connectionId) === mc) {
          console.error(`[ConnectionManager] escalateReconnect failed on ${mc.connectionId}:`, err);
          mc.status = 'unreachable';
          mc.error = err instanceof Error ? err : new Error(String(err));
          syncState();
        }
      } finally {
        mc.escalating = false;
      }
    },
    [syncState],
  );

  // Connect to a daemon (direct WebSocket)
  const connectDirect = useCallback(
    (url: string, directory?: string): ConnectionId => {
      const connectionId = parseConnectionId(url);

      // If already connected/connecting to this host:port, skip
      const existing = connectionsMapRef.current.get(connectionId);
      if (existing) {
        const s = existing.status;
        if (
          s === 'connected' ||
          s === 'connecting' ||
          s === 'authenticating' ||
          s === 'reconnecting'
        ) {
          return connectionId;
        }
        // Tear down the rest (error / disconnected / unreachable) before reconnecting.
        existing.client.disconnect();
        connectionsMapRef.current.delete(connectionId);
        // Free its stagger slot: this connection may be recreated repeatedly
        // (e.g. App.tsx's session_list_response handler re-calling
        // connectDirect for a still-unreachable sibling port on every
        // reconnect / app resume) -- without releasing the slot here, a
        // monotonic-counter design would hand it a fresh, ever-growing
        // offset each time (#685 review).
        usedStaggerSlotsRef.current.delete(existing.staggerSlot);
      }

      // Each connection gets a distinct offset so that if several daemons'
      // heartbeats independently detect staleness at ~the same wall-clock
      // tick, their automatic reconnects don't cluster within the same
      // few-hundred-ms window (#685). The slot is reused from the pool of
      // currently-free slots (not a monotonic counter), so it stays bounded
      // by how many connections are live RIGHT NOW and never collides with
      // a live sibling no matter how many connect/disconnect cycles a long
      // session goes through.
      const staggerSlot = allocateStaggerSlot(usedStaggerSlotsRef.current);
      usedStaggerSlotsRef.current.add(staggerSlot);
      const reconnectStaggerMs = staggerSlot * CONNECTION_STAGGER_STEP_MS;

      const mc: ManagedConnection = {
        // client is initialized after this object because WebSocketClient callbacks
        // reference mc. The client is assigned on the next line after new WebSocketClient().
        // No callbacks fire synchronously during construction, so this is safe.
        client: null as unknown as WebSocketClient,
        connectionId,
        url,
        mode: 'direct',
        status: 'disconnected',
        error: null,
        sessionId: null,
        helloSent: false,
        pendingChallenge: null,
        needsPassphrase: false,
        serverFingerprint: null,
        directory,
        staggerSlot,
      };

      const config: WebSocketClientConfig = {
        url,
        autoReconnect: autoReconnectRef.current,
        reconnectStaggerMs,
      };

      const messageHandler = createMessageHandler(connectionId);

      const client = new WebSocketClient(config, {
        onStatusChange: (newStatus) => {
          mc.status = newStatus;

          if (newStatus === 'authenticating') {
            // Clear previous errors on successful transport open
            mc.error = null;
            sendHello(mc);
          }

          if (newStatus === 'connected') {
            mc.error = null;
          }

          if (newStatus === 'disconnected' || newStatus === 'reconnecting') {
            mc.sessionId = null;
            mc.helloSent = false;
          }

          syncState();
        },
        onMessage: messageHandler,
        onError: (err) => {
          console.error(`[ConnectionManager] Error on ${connectionId}:`, err);
          mc.error = err;
          syncState();
        },
        onReconnectExhausted: () => {
          void escalateReconnect(mc);
        },
      });

      mc.client = client;
      connectionsMapRef.current.set(connectionId, mc);
      client.connect();
      syncState();

      return connectionId;
    },
    [createMessageHandler, sendHello, syncState, escalateReconnect],
  );

  // Retry a connection that gave up ('unreachable'/'error'/'disconnected') by
  // re-running port discovery against its host. Ignored while a connection is
  // live or already (re)connecting, so a stray tap can't disrupt it. (#435)
  const reconnect = useCallback(
    (connectionId: ConnectionId) => {
      const mc = connectionsMapRef.current.get(connectionId);
      if (!mc) return;
      if (
        mc.status === 'connected' ||
        mc.status === 'connecting' ||
        mc.status === 'authenticating' ||
        mc.status === 'reconnecting'
      ) {
        return;
      }
      void escalateReconnect(mc);
    },
    [escalateReconnect],
  );

  // Disconnect a specific connection
  const disconnect = useCallback(
    (connectionId: ConnectionId) => {
      const mc = connectionsMapRef.current.get(connectionId);
      if (!mc) return;
      mc.client.disconnect();
      connectionsMapRef.current.delete(connectionId);
      // Free the stagger slot (#685) so a later connection can reuse it.
      usedStaggerSlotsRef.current.delete(mc.staggerSlot);
      syncState();
    },
    [syncState],
  );

  // Disconnect all
  const disconnectAll = useCallback(() => {
    for (const mc of connectionsMapRef.current.values()) {
      mc.client.disconnect();
    }
    connectionsMapRef.current.clear();
    usedStaggerSlotsRef.current.clear();
    syncState();
  }, [syncState]);

  const sendToConnection = useCallback(
    (connectionId: ConnectionId, message: ProtocolMessage): boolean => {
      const mc = getMc(connectionId);
      if (!mc) {
        console.warn(
          `[ConnectionManager] Cannot send ${message.type}: connection "${connectionId}" not found`,
        );
        return false;
      }
      return mc.client.send(message);
    },
    [getMc],
  );

  const sendInput = useCallback(
    (
      connectionId: ConnectionId,
      sessionId: UUID,
      content: string,
      claudeSessionId?: UUID,
      id?: UUID,
    ): boolean => {
      return sendToConnection(
        connectionId,
        createUserInput(sessionId, content, undefined, claudeSessionId, id),
      );
    },
    [sendToConnection],
  );

  // Send a bare Esc keystroke (raw, no Enter) to the session's PTY — the
  // persistent escape: interrupts Claude's running work AND cancels/escapes an
  // on-screen prompt, available any time (not tied to a question card).
  const sendEscape = useCallback(
    (connectionId: ConnectionId, sessionId: UUID, claudeSessionId?: UUID): boolean => {
      return sendToConnection(
        connectionId,
        createUserInput(sessionId, '\x1b', true, claudeSessionId),
      );
    },
    [sendToConnection],
  );

  const sendAnswer = useCallback(
    (
      connectionId: ConnectionId,
      sessionId: UUID,
      questionId: UUID,
      answer: string,
      claudeSessionId?: UUID,
    ): boolean => {
      return sendToConnection(
        connectionId,
        createAnswer(sessionId, questionId, answer, claudeSessionId),
      );
    },
    [sendToConnection],
  );

  // #627: a structured AskUserQuestion answer (per-sub-question selections); the
  // daemon drives the interactive TUI and verifies the review before submitting.
  const sendAuqAnswer = useCallback(
    (
      connectionId: ConnectionId,
      sessionId: UUID,
      questionId: UUID,
      selections: readonly AnswerSelection[],
      claudeSessionId?: UUID,
    ): boolean => {
      return sendToConnection(
        connectionId,
        createAuqAnswer(sessionId, questionId, selections, claudeSessionId),
      );
    },
    [sendToConnection],
  );

  // #627: cancel/escape the active prompt — the daemon sends Esc to the TUI. The
  // universal unstick, available even when a prompt can't be auto-answered.
  const sendCancelQuestion = useCallback(
    (
      connectionId: ConnectionId,
      sessionId: UUID,
      questionId: UUID,
      claudeSessionId?: UUID,
    ): boolean => {
      return sendToConnection(
        connectionId,
        createCancelQuestion(sessionId, questionId, claudeSessionId),
      );
    },
    [sendToConnection],
  );

  const sendMessage = useCallback(
    (connectionId: ConnectionId, message: ProtocolMessage): boolean => {
      return sendToConnection(connectionId, message);
    },
    [sendToConnection],
  );

  const requestBulletExpand = useCallback(
    (connectionId: ConnectionId, sessionId: UUID, bulletId: number): boolean => {
      return sendToConnection(connectionId, createBulletExpandRequest(sessionId, bulletId));
    },
    [sendToConnection],
  );

  const requestSessionList = useCallback(
    (connectionId: ConnectionId, includeExternal?: boolean): boolean => {
      return sendToConnection(connectionId, createSessionListRequest(includeExternal));
    },
    [sendToConnection],
  );

  const requestTranscriptLoad = useCallback(
    (connectionId: ConnectionId, sessionId: string): boolean => {
      return sendToConnection(connectionId, createTranscriptLoadRequest(sessionId));
    },
    [sendToConnection],
  );

  const requestNewSession = useCallback(
    (connectionId: ConnectionId, directory?: string): boolean => {
      return sendToConnection(connectionId, createCreateSessionRequest(directory));
    },
    [sendToConnection],
  );

  const requestResumeSession = useCallback(
    (connectionId: ConnectionId, sessionId: string): boolean => {
      return sendToConnection(connectionId, createResumeSessionRequest(sessionId));
    },
    [sendToConnection],
  );

  const requestSessionHistory = useCallback(
    (connectionId: ConnectionId, limit?: number): boolean => {
      return sendToConnection(connectionId, createSessionHistoryRequest(limit));
    },
    [sendToConnection],
  );

  // Provide identity for connections waiting on passphrase, and seed the
  // identity ref synchronously for any future auto-connect (#257).
  //
  // After the user unlocks once, ALL connections with a pending challenge
  // get signed silently — including sibling daemons we auto-discovered or
  // restored from localStorage on launch. Without this, the modal would
  // re-prompt for every sibling port even though the same identity unlocks
  // all of them. The pre-flight modal path also calls this with no pending
  // connection (empty connectionId) so the WebSocket opened just after gets
  // a populated identity ref before the daemon's challenge arrives.
  const provideIdentity = useCallback(
    (connectionId: ConnectionId, identity: UnlockedIdentity) => {
      identityRef.current = identity;

      const pending = collectPendingChallengeConnections(connectionsMapRef.current.values());
      if (pending.length === 0) {
        // No-op when called as a pre-flight seed (empty connectionId).
        // Warn only if a real connectionId was passed, since that means
        // the caller expected a pending challenge and there was none.
        if (connectionId) {
          console.warn(
            `[ConnectionManager] No pending auth challenge for "${connectionId}" or any sibling`,
          );
        }
        syncState();
        return;
      }

      for (const mc of pending) {
        // Type guard already established by collectPendingChallengeConnections
        const challenge = mc.pendingChallenge?.challenge;
        if (!challenge) continue;
        mc.needsPassphrase = false;
        signChallenge(identity, challenge)
          .then((response) => mc.client.send(response))
          .catch((err) => {
            mc.error = new Error(`Auth failed: ${errorToString(err)}`);
            mc.client.disconnect();
            syncState();
          });
      }
      syncState();
    },
    [syncState],
  );

  // Get hello_ack session ID directly from mutable state (avoids React state timing issues)
  const getSessionId = useCallback(
    (connectionId: ConnectionId): string | null => {
      return getMc(connectionId)?.sessionId ?? null;
    },
    [getMc],
  );

  // Derived: passphrase state (from React state, not mutable ref)
  const passphraseConnection = connectionsState.find((c) => c.needsPassphrase);
  const needsPassphrase = passphraseConnection != null;
  const passphraseConnectionId = passphraseConnection?.connectionId ?? null;
  const passphraseServerFingerprint = passphraseConnection?.serverFingerprint ?? null;

  // Force reconnect on network change or app resume (iOS, main.tsx). Before
  // #664 this unconditionally force-closed EVERY connected/authenticating
  // connection at once: with ~5 daemons, foregrounding the phone guaranteed a
  // full simultaneous reconnect cycle even when every socket was still
  // perfectly healthy. planForceReconnect (#664) decides per-connection
  // whether a reconnect is even needed, and staggers the ones that are.
  useEffect(() => {
    const handleForceReconnect = () => {
      const mcs: ManagedConnection[] = [];
      const candidates: ForceReconnectCandidate<ConnectionId>[] = [];
      for (const mc of connectionsMapRef.current.values()) {
        if (mc.status !== 'connected' && mc.status !== 'authenticating') continue;
        mcs.push(mc);
        candidates.push({
          connectionId: mc.connectionId,
          isOpen: mc.client.isTransportOpen,
          isHealthy: mc.client.isHealthy,
        });
      }
      if (candidates.length === 0) return;

      const plan = planForceReconnect(candidates, {
        staggerStepMs: CONNECTION_STAGGER_STEP_MS,
        staggerJitterMs: FORCE_RECONNECT_STAGGER_JITTER_MS,
      });
      const byId = new Map(mcs.map((mc) => [mc.connectionId, mc]));

      for (const decision of plan) {
        if (!decision.shouldReconnect) continue;
        const mc = byId.get(decision.connectionId);
        if (!mc) continue;

        if (decision.delayMs <= 0) {
          mc.client.forceReconnect();
          continue;
        }
        setTimeout(() => {
          // Re-check both connection identity (it may have been replaced or
          // torn down during the delay) and current health (isHealthy already
          // implies the transport is open) -- a connection that self-healed
          // during its stagger delay (e.g. its own heartbeat probe finally
          // got a reply) should be left alone, not torn down anyway.
          if (connectionsMapRef.current.get(decision.connectionId) === mc && !mc.client.isHealthy) {
            mc.client.forceReconnect();
          }
        }, decision.delayMs);
      }
    };
    document.addEventListener('app-force-reconnect', handleForceReconnect);
    return () => document.removeEventListener('app-force-reconnect', handleForceReconnect);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const mc of connectionsMapRef.current.values()) {
        mc.client.disconnect();
      }
      connectionsMapRef.current.clear();
      usedStaggerSlotsRef.current.clear();
    };
  }, []);

  return {
    connections: connectionsState,
    connectDirect,
    disconnect,
    reconnect,
    disconnectAll,
    sendInput,
    sendEscape,
    sendAnswer,
    sendAuqAnswer,
    sendCancelQuestion,
    sendMessage,
    requestBulletExpand,
    requestSessionList,
    requestTranscriptLoad,
    requestNewSession,
    requestResumeSession,
    requestSessionHistory,
    provideIdentity,
    getSessionId,
    needsPassphrase,
    passphraseConnectionId,
    passphraseServerFingerprint,
  };
}
