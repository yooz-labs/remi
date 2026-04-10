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
import { WebSocketClient, type WebSocketClientConfig } from '@/lib/websocket-client';
import type { ConnectionId, ConnectionState, ConnectionStatus } from '@/types';
import type { UnlockedIdentity } from '@remi/shared';
import { createAuthResponse, fromBase64, importPublicKey, sign, verify } from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import {
  createBulletExpandRequest,
  createCreateSessionRequest,
  createHello,
  createPing,
  createResumeSessionRequest,
  createSessionHistoryRequest,
  createSessionListRequest,
  createTranscriptLoadRequest,
  createUserInput,
  generateId,
  now,
} from '@remi/shared/protocol.ts';
import type { UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

function makeConnectionId(raw: string): ConnectionId {
  return raw as ConnectionId;
}

/** Internal per-connection state */
interface ManagedConnection {
  client: WebSocketClient;
  connectionId: ConnectionId;
  url: string;
  mode: 'direct' | 'relay';
  status: ConnectionStatus;
  error: Error | null;
  sessionId: UUID | null;
  helloSent: boolean;
  pendingChallenge: {
    challenge: string;
    serverPublicKey: string;
    serverFingerprint: string;
  } | null;
  needsPassphrase: boolean;
  serverFingerprint: string | null;
  directory?: string;
  pingInterval?: ReturnType<typeof setInterval>;
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
  /** Disconnect all connections */
  disconnectAll: () => void;
  /** Send user input routed to the correct connection */
  sendInput: (connectionId: ConnectionId, sessionId: UUID, content: string) => boolean;
  /** Send answer to a question via the correct connection */
  sendAnswer: (connectionId: ConnectionId, questionId: UUID, answer: string) => boolean;
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

/** Derive connectionId (host:port) from a WebSocket URL. Falls back to port 18765 if not specified. */
export function parseConnectionId(url: string): ConnectionId {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || 'localhost';
    const port = parsed.port || '18765';
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
      mc.client.send(createHello(clientId, clientVersion, mc.directory, resumeId));
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
            `Identity setup failed: ${err instanceof Error ? err.message : String(err)}`,
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
        mc.error = new Error(`Auth failed: ${err instanceof Error ? err.message : String(err)}`);
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
          `Server verification error: ${err instanceof Error ? err.message : String(err)}`,
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

        // Track session ID from hello_ack
        if (message.type === 'hello_ack') {
          mc.sessionId = message.sessionId;
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

  /** Start ping keep-alive for a connection */
  const startPing = useCallback((mc: ManagedConnection) => {
    if (mc.pingInterval) clearInterval(mc.pingInterval);
    mc.pingInterval = setInterval(() => {
      mc.client.send(createPing());
    }, 30000);
  }, []);

  /** Stop ping keep-alive for a connection */
  const stopPing = useCallback((mc: ManagedConnection) => {
    if (mc.pingInterval) {
      clearInterval(mc.pingInterval);
      mc.pingInterval = undefined;
    }
  }, []);

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
        // Only tear down errored or disconnected connections
        stopPing(existing);
        existing.client.disconnect();
        connectionsMapRef.current.delete(connectionId);
      }

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
      };

      const config: WebSocketClientConfig = {
        url,
        autoReconnect: autoReconnectRef.current,
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
            startPing(mc);
          }

          if (newStatus === 'disconnected' || newStatus === 'reconnecting') {
            mc.sessionId = null;
            mc.helloSent = false;
            stopPing(mc);
          }

          syncState();
        },
        onMessage: messageHandler,
        onError: (err) => {
          console.error(`[ConnectionManager] Error on ${connectionId}:`, err);
          mc.error = err;
          syncState();
        },
      });

      mc.client = client;
      connectionsMapRef.current.set(connectionId, mc);
      client.connect();
      syncState();

      return connectionId;
    },
    [createMessageHandler, sendHello, startPing, stopPing, syncState],
  );

  // Disconnect a specific connection
  const disconnect = useCallback(
    (connectionId: ConnectionId) => {
      const mc = connectionsMapRef.current.get(connectionId);
      if (!mc) return;
      stopPing(mc);
      mc.client.disconnect();
      connectionsMapRef.current.delete(connectionId);
      syncState();
    },
    [stopPing, syncState],
  );

  // Disconnect all
  const disconnectAll = useCallback(() => {
    for (const mc of connectionsMapRef.current.values()) {
      stopPing(mc);
      mc.client.disconnect();
    }
    connectionsMapRef.current.clear();
    syncState();
  }, [stopPing, syncState]);

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
    (connectionId: ConnectionId, sessionId: UUID, content: string): boolean => {
      return sendToConnection(connectionId, createUserInput(sessionId, content));
    },
    [sendToConnection],
  );

  const sendAnswer = useCallback(
    (connectionId: ConnectionId, questionId: UUID, answer: string): boolean => {
      const msg: ProtocolMessage = {
        type: 'answer',
        id: generateId(),
        timestamp: now(),
        questionId,
        answer,
      };
      return sendToConnection(connectionId, msg);
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

  // Provide identity for a connection waiting on passphrase
  const provideIdentity = useCallback(
    (connectionId: ConnectionId, identity: UnlockedIdentity) => {
      identityRef.current = identity;

      const mc = getMc(connectionId);
      if (!mc) {
        console.warn(
          `[ConnectionManager] Cannot provide identity: connection "${connectionId}" not found`,
        );
        return;
      }
      if (!mc.pendingChallenge) {
        console.warn(`[ConnectionManager] No pending auth challenge for "${connectionId}"`);
        return;
      }

      mc.needsPassphrase = false;
      syncState();

      signChallenge(identity, mc.pendingChallenge.challenge)
        .then((response) => mc.client.send(response))
        .catch((err) => {
          mc.error = new Error(`Auth failed: ${err instanceof Error ? err.message : String(err)}`);
          mc.client.disconnect();
          syncState();
        });
    },
    [getMc, syncState],
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

  // Force reconnect on network change or app resume (iOS)
  useEffect(() => {
    const handleForceReconnect = () => {
      for (const mc of connectionsMapRef.current.values()) {
        if (mc.status === 'connected' || mc.status === 'authenticating') {
          mc.client.forceReconnect();
        }
      }
    };
    document.addEventListener('app-force-reconnect', handleForceReconnect);
    return () => document.removeEventListener('app-force-reconnect', handleForceReconnect);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const mc of connectionsMapRef.current.values()) {
        if (mc.pingInterval) clearInterval(mc.pingInterval);
        mc.client.disconnect();
      }
      connectionsMapRef.current.clear();
    };
  }, []);

  return {
    connections: connectionsState,
    connectDirect,
    disconnect,
    disconnectAll,
    sendInput,
    sendAnswer,
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
