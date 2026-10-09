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
  getIdentityRevision,
  loadIdentity,
  trustHost,
  unlockStoredIdentity,
} from '@/lib/identity-client';
import { ConnectionApproval } from '@/lib/connection-approval';
import { DAEMON_BASE_PORT, errorToString, type relayV2 } from '@remi/shared';
import type {
  RelayDevicesResponseMessage,
  RelayDeviceRevokeResponseMessage,
  SecurePushRegisterResponseMessage,
  SecurePushRegistration,
  SecurePushUnregisterResponseMessage,
} from '@remi/shared';
import { WebSocketClient, type WebSocketClientConfig } from '@/lib/websocket-client';
import type { ConnectionId, ConnectionState, ConnectionStatus } from '@/types';
import { type ClientSigningIdentity, signClient } from '@/lib/client-signer';
import { currentNativeIdentity, usesNativeIdentity } from '@/lib/native-identity';
import { isNative } from '@/lib/platform';
import { RelayMachineChannel, type RelayMachinePin } from '@/lib/relay-machine-channel';
import { RelayTransport, type ConnectionTransport } from '@/lib/relay-transport';
import { rememberRelayPin } from '@/lib/relay-pins';
import { beginNativePairingTrust, cancelNativePairingTrust, commitNativePairingTrust, type NativePairingAttempt } from '@/lib/native-push-trust';
import { RelayRequests, type RelayAnswerStatus } from '@/lib/relay-requests';
import {
  allocateStaggerSlot,
  collectPendingChallengeConnections,
  type ForceReconnectCandidate,
  getOrCreateDeviceId,
  isConnectionReplaceable,
  planForceReconnect,
} from './connection-manager-helpers';
import { normalizeConnectionHost, splitConnectionId } from '@/lib/connection-id';
import { buildWsUrl, parseHostInput, resolveDaemonPort } from '@/lib/port-discovery';
import { createAuthResponse, fingerprint, fromBase64, importPublicKey, isEncrypted, isSmallOrderPublicKey, toBase64, verify } from '@remi/shared';
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
  client: ConnectionTransport;
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
  relayPin?: RelayMachinePin;
  relayCancel?: () => void;
  relayConfirmation?: string;
  relayRequests?: RelayRequests;
  sessionAttachments?: Map<string, 'attached' | 'queued'>;
  helloSent: boolean;
  pendingChallenge: {
    challenge: string;
    serverPublicKey: string;
    serverFingerprint: string;
    /** Pinned alongside the fingerprint so answers can be sealed later (#875). */
    answerEncryptionKey?: string;
  } | null;
  approval: ConnectionApproval;
  authAttempt: Awaited<ReturnType<ConnectionApproval['begin']>>;
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

/** Stop a captured identity context and publish that close synchronously. */
function invalidateIdentityConnection(mc: ManagedConnection, message = 'Identity changed. Reconnect with the current identity.') {
  mc.relayCancel?.(); mc.relayRequests?.closed(); mc.client.disconnect();
  mc.status = 'disconnected'; mc.helloSent = false; mc.pendingChallenge = null; mc.authAttempt = null;
  mc.sessionAttachments?.clear(); mc.error = new Error(message);
}

/** Hook options */
export interface UseConnectionManagerOptions {
  /** Message handler: receives connectionId and the protocol message */
  onMessage?: (connectionId: ConnectionId, message: ProtocolMessage) => void;
  onAnswerOutcome?: (connectionId: ConnectionId, status: RelayAnswerStatus) => void;
  /** Pre-unlocked identity (shared across all connections) */
  unlockedIdentity?: ClientSigningIdentity | null;
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
  connectRelay: (tokenOrPin: string | RelayMachinePin, signal?: AbortSignal) => Promise<ConnectionId>;
  requestSessionAttach: (connectionId: ConnectionId, sessionId: string) => boolean;
  listRelayDevices: (connectionId: ConnectionId) => Promise<RelayDevicesResponseMessage>;
  revokeRelayDevice: (connectionId: ConnectionId, fingerprint: string) => Promise<RelayDeviceRevokeResponseMessage>;
  registerRelayPush: (connectionId: ConnectionId, registration: SecurePushRegistration) => Promise<SecurePushRegisterResponseMessage>;
  unregisterRelayPush: (connectionId: ConnectionId) => Promise<SecurePushUnregisterResponseMessage>;
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
  /** #627: cancel the active prompt (through its held hook, #1127, or Esc). */
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
  provideIdentity: (connectionId: ConnectionId, identity: ClientSigningIdentity) => void;
  /** Get the hello_ack session ID for a connection (reads from live state, not React state) */
  getOwnFingerprint: () => string | null;
  getConnectionMode: (connectionId: ConnectionId) => 'direct' | 'relay' | null;
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
    const host = normalizeConnectionHost(parsed.hostname || 'localhost');
    const port = parsed.port || String(DAEMON_BASE_PORT);
    return makeConnectionId(`${host}:${port}`);
  } catch (err) {
    console.warn(`[ConnectionManager] Failed to parse URL "${url}":`, err);
    return makeConnectionId(normalizeConnectionHost(url));
  }
}

/** Sign an auth challenge with the given identity */
async function signChallenge(
  identity: ClientSigningIdentity,
  challenge: string,
): Promise<ProtocolMessage> {
  const challengeData = fromBase64(challenge);
  const signature = await signClient(identity, challengeData);
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
    approval: mc.approval.snapshot,
    relayPin: mc.relayPin,
    relayConfirmation: mc.relayConfirmation,
  };
}

export function useConnectionManager(
  options: UseConnectionManagerOptions = {},
): UseConnectionManagerReturn {
  const {
    onMessage,
    onAnswerOutcome,
    unlockedIdentity,
    clientId = 'remi-web',
    clientVersion = '0.0.1',
    autoReconnect = true,
  } = options;

  const connectionsMapRef = useRef<Map<ConnectionId, ManagedConnection>>(new Map());
  const [connectionsState, setConnectionsState] = useState<readonly ConnectionState[]>([]);
  const onMessageRef = useRef(onMessage);
  const answerOutcomeRef = useRef(onAnswerOutcome);
  useEffect(() => { answerOutcomeRef.current = onAnswerOutcome; }, [onAnswerOutcome]);
  const identityRef = useRef<ClientSigningIdentity | null>(unlockedIdentity ?? null);
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
    autoReconnectRef.current = autoReconnect;
  }, [autoReconnect]);

  /** Re-derive React state from the Map */
  const syncState = useCallback(() => {
    const states = Array.from(connectionsMapRef.current.values()).map(toConnectionState);
    setConnectionsState(states);
  }, []);

  useEffect(() => {
    if (usesNativeIdentity() && !unlockedIdentity) identityRef.current = null;
    if (unlockedIdentity) {
      if (identityRef.current?.publicKeyRaw !== unlockedIdentity.publicKeyRaw) {
        for (const mc of connectionsMapRef.current.values()) {
          mc.approval.reset();
          mc.authAttempt = null;
          mc.pendingChallenge = null;
          if (mc.mode === 'relay') invalidateIdentityConnection(mc);
        }
      }
      identityRef.current = unlockedIdentity;
      syncState();
    }
  }, [unlockedIdentity, syncState]);

  useEffect(() => {
    const changed = () => {
      identityRef.current = null;
      for (const mc of connectionsMapRef.current.values()) {
        mc.approval.reset();
        mc.authAttempt = null;
        if (usesNativeIdentity() || mc.mode === 'relay') invalidateIdentityConnection(mc);
      }
      syncState();
    };
    window.addEventListener('remi:identity-changed', changed);
    return () => window.removeEventListener('remi:identity-changed', changed);
  }, [syncState]);

  useEffect(() => {
    const locked = () => {
      const identity = identityRef.current;
      if (!identity || !('kind' in identity) || !identity.requiresAppUnlock) return;
      identityRef.current = null;
      for (const mc of connectionsMapRef.current.values()) {
        invalidateIdentityConnection(mc, 'Unlock Identity in the foreground before reconnecting.');
      }
      syncState();
    };
    const hidden = () => { if (document.visibilityState !== 'visible') locked(); };
    window.addEventListener('remi:native-identity-locked', locked);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('remi:native-identity-locked', locked); document.removeEventListener('visibilitychange', hidden); };
  }, [syncState]);

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
      answerEncryptionKey?: string,
    ) => {
      if (connectionsMapRef.current.get(mc.connectionId) !== mc) return;
      const pending = {
        challenge,
        serverPublicKey: srvPublicKey,
        serverFingerprint: srvFingerprint,
        // Preserve an older daemon's v1 metadata; v2 answers do not use it (#1202).
        ...(answerEncryptionKey !== undefined && { answerEncryptionKey }),
      };
      mc.authAttempt = null;
      mc.pendingChallenge = pending;
      const currentChallenge = () =>
        connectionsMapRef.current.get(mc.connectionId) === mc && mc.pendingChallenge === pending;
      const challengeRevision = getIdentityRevision();
      let derivedFingerprint: string;
      try {
        const raw = fromBase64(srvPublicKey);
        if (raw.byteLength !== 32 || toBase64(raw) !== srvPublicKey ||
            isSmallOrderPublicKey(new Uint8Array(raw))) {
          throw new Error('Server public key is invalid');
        }
        derivedFingerprint = await fingerprint(raw);
        if (!currentChallenge() || getIdentityRevision() !== challengeRevision) return;
        if (derivedFingerprint !== srvFingerprint) {
          throw new Error('Server public key fingerprint does not match its claim');
        }
        const tofuResult = checkKnownHost(mc.url, derivedFingerprint, srvPublicKey);
        if (tofuResult === 'mismatch') {
          throw new Error(`Server identity changed for ${mc.url}. Connection rejected.`);
        }
        mc.serverFingerprint = derivedFingerprint;
      } catch (err) {
        if (!currentChallenge() || getIdentityRevision() !== challengeRevision) return;
        mc.approval.reset();
        mc.error = new Error(errorToString(err));
        mc.client.disconnect();
        syncState();
        return;
      }

      let identity = identityRef.current;
      if (usesNativeIdentity()) {
        identity = currentNativeIdentity();
        identityRef.current = identity;
        if (!identity) {
          mc.error = new Error('Set up or unlock the durable native identity before connecting.');
          mc.client.disconnect(); syncState(); return;
        }
      }
      if (!identity) {
        const revision = getIdentityRevision();
        const storedBefore = loadIdentity();
        // First-use creation legitimately emits ONE save event. All other
        // identity revisions cancel setup, including removal/re-import of the same key.
        const expectedRevision = revision + (storedBefore ? 0 : 1);
        const currentSetup = (publicKey: string) => currentChallenge() &&
          getIdentityRevision() === expectedRevision && loadIdentity()?.publicKey === publicKey;
        try {
          const stored = await ensureIdentity();
          if (!currentSetup(stored.publicKey)) return;
          if (!isEncrypted(stored)) {
            identity = await unlockStoredIdentity();
            if (!currentSetup(stored.publicKey) || identity.publicKeyRaw !== stored.publicKey) return;
            identityRef.current = identity;
          } else {
            mc.needsPassphrase = true;
            syncState();
            return;
          }
        } catch (err) {
          // An unrelated identity change must not let an obsolete rejection
          // tear down a replacement attempt, or restore its old signer (#873).
          if (!currentChallenge() || (getIdentityRevision() !== revision &&
              getIdentityRevision() !== expectedRevision)) return;
          mc.error = new Error(`Identity setup failed: ${errorToString(err)}`);
          mc.client.disconnect();
          syncState();
          return;
        }
      }

      try {
        if (connectionsMapRef.current.get(mc.connectionId) !== mc || mc.pendingChallenge !== pending || identityRef.current !== identity) return;
        const attempt = await mc.approval.begin(identity, mc.url);
        if (connectionsMapRef.current.get(mc.connectionId) !== mc || mc.pendingChallenge !== pending || identityRef.current !== identity || !attempt) return;
        const response = await signChallenge(identity, challenge);
        if (connectionsMapRef.current.get(mc.connectionId) !== mc || mc.pendingChallenge !== pending || identityRef.current !== identity || !mc.approval.isCurrent(attempt)) return;
        mc.authAttempt = attempt;
        mc.client.send(response);
      } catch (err) {
        if (connectionsMapRef.current.get(mc.connectionId) !== mc || mc.pendingChallenge !== pending) return;
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
      const pending = mc.pendingChallenge;
      const attempt = mc.authAttempt;
      const isCurrent = () =>
        connectionsMapRef.current.get(mc.connectionId) === mc &&
        mc.pendingChallenge === pending && mc.approval.isCurrent(attempt);
      if (!isCurrent()) return;
      if (!success) {
        mc.approval.refuse(attempt, authError);
        mc.error = new Error(`Authentication failed: ${authError ?? 'unknown error'}`);
        mc.client.disconnect();
        syncState();
        return;
      }

      if (!srvSignature || !pending) {
        mc.approval.reset();
        mc.error = new Error('Server did not provide mutual authentication signature');
        mc.client.disconnect();
        syncState();
        return;
      }

      try {
        const serverPubKey = await importPublicKey(fromBase64(pending.serverPublicKey));
        const challengeData = fromBase64(pending.challenge);
        const valid = await verify(serverPubKey, challengeData, srvSignature);
        if (!isCurrent()) return;
        if (!valid) {
          mc.approval.reset();
          mc.error = new Error('Server signature verification failed');
          mc.client.disconnect();
          syncState();
          return;
        }
      } catch (err) {
        if (!isCurrent()) return;
        mc.approval.reset();
        mc.error = new Error(
          `Server verification error: ${errorToString(err)}`,
        );
        mc.client.disconnect();
        syncState();
        return;
      }

      // TOFU: trust on first use
      if (!isCurrent() || !pending) return;
      mc.approval.verified(attempt);
      mc.error = null;
      trustHost(
        mc.url,
        pending.serverFingerprint,
        pending.serverPublicKey,
        pending.answerEncryptionKey,
      );

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
    (mc: ManagedConnection) => {
      const connectionId = mc.connectionId;
      return (message: ProtocolMessage) => {
        if (connectionsMapRef.current.get(connectionId) !== mc) {
          console.debug(
            `[ConnectionManager] Dropping message for disconnected connection "${connectionId}":`,
            message.type,
          );
          return;
        }

        if (mc.mode === 'relay' && !mc.relayRequests?.receive(message)) return;
        // Intercept auth messages
        if (message.type === 'auth_challenge') {
          handleAuthChallenge(
            mc,
            message.challenge,
            message.serverFingerprint,
            message.serverPublicKey,
            message.answerEncryptionKey,
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
          if (mc.mode === 'relay') {
            if (message.sessionId && message.attachState) mc.sessionAttachments?.set(message.sessionId, message.attachState);
          } else {
            mc.sessionId = message.sessionId;
            mc.attachState = message.attachState;
          }
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
        if (mc.url !== newUrl) mc.approval.reset();
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
        if (!isConnectionReplaceable(existing.status)) {
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
        approval: existing?.url === url ? existing.approval : new ConnectionApproval(),
        authAttempt: null,
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

      const messageHandler = createMessageHandler(mc);

      const client = new WebSocketClient(config, {
        onStatusChange: (newStatus) => {
          if (connectionsMapRef.current.get(connectionId) !== mc) return;
          mc.status = newStatus;

          if (newStatus === 'authenticating') {
            // Clear previous errors on successful transport open
            if (!mc.approval.snapshot) mc.error = null;
            sendHello(mc);
          }

          if (newStatus === 'connected') {
            mc.error = null;
          }

          if (newStatus === 'disconnected' || newStatus === 'reconnecting') {
            mc.sessionId = null;
            mc.helloSent = false;
            mc.pendingChallenge = null;
            mc.authAttempt = null;
            mc.approval.disconnected();
          }

          syncState();
        },
        onMessage: messageHandler,
        onError: (err) => {
          if (connectionsMapRef.current.get(connectionId) !== mc) return;
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

  const connectRelay = useCallback(async (input: string | RelayMachinePin, signal?: AbortSignal): Promise<ConnectionId> => {
    // #1199: native relay identities must stay in a platform provider, including cached keys.
    if (isNative() && !usesNativeIdentity()) throw new Error('Relay pairing is unavailable in the Android app until its native identity provider is supported.');
    let tokenOrPin = input;
    let identity = identityRef.current;
    if (!identity) {
      const revision = getIdentityRevision();
      if (usesNativeIdentity()) identity = await currentNativeIdentity();
      else {
        const stored = await ensureIdentity();
        if (signal?.aborted || loadIdentity()?.publicKey !== stored.publicKey) throw new Error('Identity changed during relay setup.');
        if (isEncrypted(stored)) throw new Error('Unlock your identity before pairing.');
        const setupRevision = getIdentityRevision();
        const unlocked = await unlockStoredIdentity();
        if (signal?.aborted || getIdentityRevision() !== setupRevision || loadIdentity()?.publicKey !== stored.publicKey || unlocked.publicKeyRaw !== stored.publicKey) throw new Error('Identity changed during relay setup.');
        identity = unlocked;
      }
      if (!identity || (usesNativeIdentity() && getIdentityRevision() !== revision)) throw new Error('Identity unavailable or replaced.');
      if (signal?.aborted) throw new Error('Pairing canceled.');
      identityRef.current = identity;
    }
    const signedIdentity = identity;
    const revision = getIdentityRevision();
    const currentIdentity = () => {
      const live = identityRef.current;
      return live?.publicKeyRaw === signedIdentity.publicKeyRaw && getIdentityRevision() === revision &&
        (!('kind' in signedIdentity) || (live && 'kind' in live && live.revision === signedIdentity.revision && live.requiresAppUnlock === signedIdentity.requiresAppUnlock));
    };
    const signer: relayV2.Signer = {
      publicKey: new Uint8Array(fromBase64(signedIdentity.publicKeyRaw)),
      sign: async bytes => new Uint8Array(fromBase64(await signClient(signedIdentity, new Uint8Array(bytes).buffer))),
    };
    let first: RelayMachineChannel | null = null;
    let pin: RelayMachinePin;
    if (typeof tokenOrPin === 'string') {
      first = await RelayMachineChannel.pair(tokenOrPin, signer, currentIdentity);
      pin = first.pin;
    } else pin = tokenOrPin;
    if (signal?.aborted || !currentIdentity()) { await first?.close(); throw new Error('Identity changed during pairing.'); }
    const connectionId = makeConnectionId(`relay:${pin.machinePublicKey}`);
    const existing = connectionsMapRef.current.get(connectionId);
    if (existing && !isConnectionReplaceable(existing.status)) { await first?.close(); return connectionId; }
    existing?.relayCancel?.(); existing?.relayRequests?.closed(); existing?.client.disconnect();
    const mc: ManagedConnection = {
      client: null as unknown as ConnectionTransport, connectionId, url: pin.relayUrl, mode: 'relay',
      status: 'connecting', error: null, sessionId: null, helloSent: false, pendingChallenge: null,
      approval: new ConnectionApproval(), authAttempt: null, needsPassphrase: false,
      serverFingerprint: null, staggerSlot: -1, relayPin: pin, sessionAttachments: new Map(),
    };
    const alive = () => currentIdentity() && connectionsMapRef.current.get(connectionId) === mc;
    let nativeAttempt: NativePairingAttempt | null = null;
    const cancelNativeAttempt = () => {
      const pending = nativeAttempt; nativeAttempt = null;
      // A failed cancel cannot authorize a later commit: native attempts also bind
      // document, identity, generation and deadline, and this channel is closed.
      if (pending) void cancelNativePairingTrust(pending).catch(() => {});
    };
    const messages = createMessageHandler(mc);
    mc.relayRequests = new RelayRequests(message => mc.client.send(message), status => {
      if (connectionsMapRef.current.get(connectionId) === mc) answerOutcomeRef.current?.(connectionId, status);
    });
    mc.client = new RelayTransport(async (events, resume) => {
      cancelNativeAttempt();
      if ('kind' in signedIdentity) {
        const pending = await beginNativePairingTrust(signedIdentity);
        if (!alive()) { await cancelNativePairingTrust(pending); throw new Error('Pairing canceled or identity changed.'); }
        nativeAttempt = pending;
      }
      // The initial unconfirmed token is used once. No retry retains it or its secret.
      if (!resume && first) {
        const initialPin = first.pin;
        await first.close(); first = null;
        // Build with the real event callbacks only once, then release token text.
        if (typeof tokenOrPin !== 'string') throw new Error('Pairing token unavailable.');
        const text = tokenOrPin; tokenOrPin = initialPin;
        return RelayMachineChannel.pair(text, signer, alive, events);
      }
      return RelayMachineChannel.resume(pin, signer, alive, events);
    }, alive, autoReconnectRef.current, {
      onMessage: messages,
      onPhase: (phase, fingerprint) => {
        if (!alive()) return;
        mc.relayConfirmation = phase === 'confirmation' ? fingerprint : undefined; syncState();
      },
      onReady: async verifiedPin => {
        if (!alive()) throw new Error('Pairing canceled or identity changed.');
        if ('kind' in signedIdentity) {
          const pending = nativeAttempt;
          if (!pending) throw new Error('Native pairing attempt is no longer available.');
          await commitNativePairingTrust(pending, verifiedPin);
          if (!alive() || nativeAttempt !== pending) throw new Error('Pairing canceled or identity changed.');
          nativeAttempt = null;
        } else rememberRelayPin(verifiedPin);
        if (!alive()) throw new Error('Pairing canceled or identity changed.');
        mc.relayCancel?.(); mc.relayPin = verifiedPin;
      },
      onError: error => { if (alive()) { mc.error = error; syncState(); } },
      onClose: () => { cancelNativeAttempt(); if (connectionsMapRef.current.get(connectionId) === mc) mc.relayRequests?.closed(); },
      onStatus: status => {
        if (!alive()) return;
        mc.status = status;
        if (status === 'connected') { mc.error = null; mc.relayConfirmation = undefined; mc.helloSent = false; sendHello(mc); }
        if (status === 'disconnected') { mc.helloSent = false; mc.sessionAttachments?.clear(); }
        syncState();
      },
    }, typeof tokenOrPin !== 'string');
    connectionsMapRef.current.set(connectionId, mc);
    if (signal && typeof tokenOrPin === 'string') {
      const cancel = () => {
        cancelNativeAttempt();
        mc.relayCancel?.();
        mc.relayRequests?.closed(); mc.client.disconnect();
        void first?.close(); first = null; tokenOrPin = pin;
        if (connectionsMapRef.current.get(connectionId) === mc) connectionsMapRef.current.delete(connectionId);
        syncState();
      };
      mc.relayCancel = () => { signal.removeEventListener('abort', cancel); mc.relayCancel = undefined; };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); throw new Error('Pairing canceled.'); }
    }
    void (mc.client as RelayTransport).connect(); syncState(); return connectionId;
  }, [createMessageHandler, sendHello, syncState]);

  const requestSessionAttach = useCallback((connectionId: ConnectionId, sessionId: string): boolean => {
    const mc = connectionsMapRef.current.get(connectionId);
    if (!mc || mc.mode !== 'relay') return false;
    return mc.client.send(createHello(clientId, clientVersion, { resumeSessionId: sessionId,
      deviceId: getOrCreateDeviceId(window.localStorage) }));
  }, [clientId, clientVersion]);
  const listRelayDevices = useCallback((connectionId: ConnectionId) => {
    const requests = connectionsMapRef.current.get(connectionId)?.relayRequests;
    return requests ? requests.devices() : Promise.reject(new Error('Relay connection unavailable.'));
  }, []);
  const revokeRelayDevice = useCallback((connectionId: ConnectionId, fingerprint: string) => {
    const mc = connectionsMapRef.current.get(connectionId);
    const requests = mc?.relayRequests;
    if (mc && identityRef.current?.fingerprint === fingerprint) (mc.client as RelayTransport).suspendResume();
    return requests ? requests.revoke(fingerprint) : Promise.reject(new Error('Relay connection unavailable.'));
  }, []);
  // Secure push subscription for this device on one relay machine (#1200).
  const registerRelayPush = useCallback((connectionId: ConnectionId, registration: SecurePushRegistration) => {
    const requests = connectionsMapRef.current.get(connectionId)?.relayRequests;
    return requests ? requests.registerPush(registration) : Promise.reject(new Error('Relay connection unavailable.'));
  }, []);
  const unregisterRelayPush = useCallback((connectionId: ConnectionId) => {
    const requests = connectionsMapRef.current.get(connectionId)?.relayRequests;
    return requests ? requests.unregisterPush() : Promise.reject(new Error('Relay connection unavailable.'));
  }, []);

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
      if (mc.mode === 'relay' && mc.relayPin) {
        void connectRelay(mc.relayPin).catch(error => { mc.error = error instanceof Error ? error : new Error('Relay reconnect failed.'); syncState(); });
      }
      else void escalateReconnect(mc);
    },
    [connectRelay, escalateReconnect, syncState],
  );

  // Disconnect a specific connection
  const disconnect = useCallback(
    (connectionId: ConnectionId) => {
      const mc = connectionsMapRef.current.get(connectionId);
      if (!mc) return;
      mc.relayCancel?.();
      mc.relayRequests?.closed();
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
      mc.relayCancel?.();
      mc.relayRequests?.closed();
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
      if (mc.mode === 'relay' && message.type === 'answer') return mc.relayRequests?.answer(message) ?? false;
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

  // #627: a structured AskUserQuestion answer (per-sub-question selections).
  // Since #1127 the daemon validates it and answers through the held hook;
  // an older daemon drove the interactive TUI instead.
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

  // #627: cancel the active prompt, the universal unstick. A held card is
  // cancelled through its hook (#1127); any other prompt gets Esc.
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
    (connectionId: ConnectionId, identity: ClientSigningIdentity) => {
      // Invalidate synchronously: the prop effect runs after this setter and
      // otherwise sees the replacement as already current (#873).
      if (identityRef.current?.publicKeyRaw !== identity.publicKeyRaw) {
        for (const mc of connectionsMapRef.current.values()) {
          mc.approval.reset();
          mc.authAttempt = null;
          if (mc.mode === 'relay') invalidateIdentityConnection(mc);
        }
      }
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
        const pendingChallenge = mc.pendingChallenge;
        if (!pendingChallenge) continue;
        const challenge = pendingChallenge.challenge;
        mc.needsPassphrase = false;
        handleAuthChallenge(mc, challenge, pendingChallenge.serverFingerprint, pendingChallenge.serverPublicKey, pendingChallenge.answerEncryptionKey)
          .catch((err) => {
            mc.error = new Error(`Auth failed: ${errorToString(err)}`);
            mc.client.disconnect();
            syncState();
          });
      }
      syncState();
    },
    [handleAuthChallenge, syncState],
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
        mc.relayCancel?.();
        mc.relayRequests?.closed();
        mc.client.disconnect();
      }
      connectionsMapRef.current.clear();
      usedStaggerSlotsRef.current.clear();
    };
  }, []);

  return {
    connections: connectionsState,
    connectDirect,
    connectRelay,
    requestSessionAttach,
    listRelayDevices,
    revokeRelayDevice,
    registerRelayPush,
    unregisterRelayPush,
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
    getOwnFingerprint: () => identityRef.current?.fingerprint ?? null,
    getConnectionMode: connectionId => connectionsMapRef.current.get(connectionId)?.mode ?? null,
    needsPassphrase,
    passphraseConnectionId,
    passphraseServerFingerprint,
  };
}
