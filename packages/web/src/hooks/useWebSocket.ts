/**
 * React hook for WebSocket connection to daemon.
 *
 * Provides reactive connection state and message handling.
 * Handles auth handshake when daemon requires authentication.
 */

import {
  checkKnownHost,
  ensureIdentity,
  isIdentityEncrypted,
  trustHost,
  unlockStoredIdentity,
} from '@/lib/identity-client';
import { errorToString } from '@remi/shared';
import { WebSocketClient, type WebSocketClientConfig } from '@/lib/websocket-client';
import type { ConnectionStatus } from '@/types';
import type { UnlockedIdentity } from '@remi/shared';
import { createAuthResponse, fromBase64, importPublicKey, sign, verify } from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import {
  createAnswer,
  createBulletExpandRequest,
  createCreateSessionRequest,
  createHello,
  createPing,
  createResumeSessionRequest,
  createSessionHistoryRequest,
  createSessionListRequest,
  createTranscriptLoadRequest,
  createUserInput,
} from '@remi/shared/protocol.ts';
import type { UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Hook return value */
export interface UseWebSocketReturn {
  /** Current connection status */
  status: ConnectionStatus;
  /** Last error */
  error: Error | null;
  /** Connect to daemon */
  connect: (url: string, directory?: string) => void;
  /** Disconnect from daemon */
  disconnect: () => void;
  /** Send user input */
  sendInput: (sessionId: UUID, content: string) => boolean;
  /** Send an answer to a question */
  sendAnswer: (sessionId: UUID, questionId: UUID, answer: string) => boolean;
  /** Send raw message */
  sendMessage: (message: ProtocolMessage) => boolean;
  /** Request full content for a truncated bullet */
  requestBulletExpand: (sessionId: UUID, bulletId: number) => boolean;
  /** Request list of sessions from daemon */
  requestSessionList: (includeExternal?: boolean) => boolean;
  /** Request transcript history for an external session */
  requestTranscriptLoad: (sessionId: string) => boolean;
  /** Request creation of a new Claude Code session */
  requestNewSession: (directory?: string) => boolean;
  /** Request resume of a dead Claude Code session */
  requestResumeSession: (sessionId: string) => boolean;
  /** Request recent directories from session history */
  requestSessionHistory: (limit?: number) => boolean;
  /** Current session ID (after hello_ack) */
  sessionId: UUID | null;
  /** Whether the daemon requires authentication */
  authRequired: boolean;
  /** Server fingerprint (from auth_challenge) */
  serverFingerprint: string | null;
  /** Whether auth is awaiting passphrase from user */
  needsPassphrase: boolean;
  /** Provide unlocked identity to complete auth */
  provideIdentity: (identity: UnlockedIdentity) => void;
}

/** Hook options */
export interface UseWebSocketOptions {
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Client ID for identification */
  clientId?: string;
  /** Client version */
  clientVersion?: string;
  /** Message handler */
  onMessage?: (message: ProtocolMessage) => void;
  /** Session ID to resume on initial connect (e.g., from localStorage after page reload) */
  initialResumeSessionId?: UUID;
  /** Pre-unlocked identity (if user already provided passphrase) */
  unlockedIdentity?: UnlockedIdentity | null;
}

/** Sign an auth challenge with the given identity and return an auth_response message. */
async function signChallenge(
  identity: UnlockedIdentity,
  challenge: string,
): Promise<ProtocolMessage> {
  const challengeData = fromBase64(challenge);
  const signature = await sign(identity.privateKey, challengeData);
  return createAuthResponse(identity.publicKeyRaw, signature, identity.fingerprint);
}

/**
 * React hook for managing WebSocket connection.
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const {
    autoReconnect = true,
    clientId = 'remi-web',
    clientVersion = '0.0.1',
    onMessage,
    initialResumeSessionId,
    unlockedIdentity,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const [sessionId, setSessionId] = useState<UUID | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [serverFingerprint, setServerFingerprint] = useState<string | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);

  const clientRef = useRef<WebSocketClient | null>(null);
  const onMessageRef = useRef(onMessage);
  const lastSessionIdRef = useRef<UUID | null>(initialResumeSessionId ?? null);
  const directoryRef = useRef<string | undefined>(undefined);
  const urlRef = useRef<string>('');
  const identityRef = useRef<UnlockedIdentity | null>(unlockedIdentity ?? null);
  const pendingChallengeRef = useRef<{
    challenge: string;
    serverPublicKey: string;
    serverFingerprint: string;
  } | null>(null);
  const helloSentRef = useRef(false);

  // Keep refs updated
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (unlockedIdentity) {
      identityRef.current = unlockedIdentity;
    }
  }, [unlockedIdentity]);

  /** Send hello message */
  const sendHello = useCallback(
    (client: WebSocketClient) => {
      if (helloSentRef.current) return;
      helloSentRef.current = true;
      const resumeId = lastSessionIdRef.current ?? undefined;
      client.send(
        createHello(clientId, clientVersion, {
          directory: directoryRef.current,
          resumeSessionId: resumeId,
        }),
      );
    },
    [clientId, clientVersion],
  );

  /** Handle auth_challenge: sign and respond */
  const handleAuthChallenge = useCallback(
    async (
      challenge: string,
      srvFingerprint: string,
      srvPublicKey: string,
      client: WebSocketClient,
    ) => {
      setAuthRequired(true);
      setServerFingerprint(srvFingerprint);

      // TOFU: check known hosts
      const tofuResult = checkKnownHost(urlRef.current, srvFingerprint);
      if (tofuResult === 'mismatch') {
        setError(
          new Error(
            `Server fingerprint changed for ${urlRef.current}. ` +
              'This could indicate a MITM attack. Connection rejected.',
          ),
        );
        client.disconnect();
        return;
      }

      // Always store for mutual auth verification in handleAuthResult
      pendingChallengeRef.current = {
        challenge,
        serverPublicKey: srvPublicKey,
        serverFingerprint: srvFingerprint,
      };

      let identity = identityRef.current;
      if (!identity) {
        // Auto-generate identity if missing, auto-unlock if unencrypted
        try {
          await ensureIdentity();
          if (!isIdentityEncrypted()) {
            identity = await unlockStoredIdentity();
            identityRef.current = identity;
          } else {
            // Encrypted identity needs passphrase from user
            setNeedsPassphrase(true);
            return;
          }
        } catch (err) {
          setError(
            new Error(`Identity setup failed: ${errorToString(err)}`),
          );
          client.disconnect();
          return;
        }
      }

      // Sign the challenge
      try {
        const response = await signChallenge(identity, challenge);
        client.send(response);
      } catch (err) {
        setError(new Error(`Auth failed: ${errorToString(err)}`));
        client.disconnect();
      }
    },
    [],
  );

  /** Handle auth_result */
  const handleAuthResult = useCallback(
    async (
      success: boolean,
      authError: string | undefined,
      srvSignature: string | undefined,
      client: WebSocketClient,
    ) => {
      if (!success) {
        setError(new Error(`Authentication failed: ${authError ?? 'unknown error'}`));
        client.disconnect();
        return;
      }

      // Server signature is mandatory when auth was performed (prevents MITM bypass)
      if (!srvSignature || !pendingChallengeRef.current) {
        setError(new Error('Server did not provide mutual authentication signature'));
        client.disconnect();
        return;
      }

      // Verify server signature for mutual auth
      try {
        const serverPubKey = await importPublicKey(
          fromBase64(pendingChallengeRef.current.serverPublicKey),
        );
        const challengeData = fromBase64(pendingChallengeRef.current.challenge);
        const valid = await verify(serverPubKey, challengeData, srvSignature);
        if (!valid) {
          setError(new Error('Server signature verification failed'));
          client.disconnect();
          return;
        }
      } catch (err) {
        setError(
          new Error(
            `Server verification error: ${errorToString(err)}`,
          ),
        );
        client.disconnect();
        return;
      }

      // TOFU: trust the server on first use (or update lastSeen)
      const pending = pendingChallengeRef.current;
      trustHost(urlRef.current, pending.serverFingerprint, pending.serverPublicKey);

      pendingChallengeRef.current = null;
      setNeedsPassphrase(false);

      // Auth passed; re-send hello (reset flag since the pre-auth hello was rejected)
      helloSentRef.current = false;
      client.setConnected();
      sendHello(client);
    },
    [sendHello],
  );

  // Handle incoming messages
  const handleMessage = useCallback(
    (message: ProtocolMessage) => {
      const client = clientRef.current;
      if (!client) return;

      // Intercept auth messages (both are async; attach .catch to surface errors)
      if (message.type === 'auth_challenge') {
        handleAuthChallenge(
          message.challenge,
          message.serverFingerprint,
          message.serverPublicKey,
          client,
        ).catch((err) => {
          setError(err instanceof Error ? err : new Error(String(err)));
          client.disconnect();
        });
        return;
      }

      if (message.type === 'auth_result') {
        handleAuthResult(message.success, message.error, message.serverSignature, client).catch(
          (err) => {
            setError(err instanceof Error ? err : new Error(String(err)));
            client.disconnect();
          },
        );
        return;
      }

      // Handle hello_ack to get session ID and ensure connected state
      if (message.type === 'hello_ack') {
        setSessionId(message.sessionId);
        lastSessionIdRef.current = message.sessionId;
        // Ensure connected state (for non-auth path where setConnected wasn't called)
        if (client && !client.isConnected) {
          client.setConnected();
        }
      }

      // Forward to user handler
      onMessageRef.current?.(message);
    },
    [handleAuthChallenge, handleAuthResult],
  );

  /** Provide identity after passphrase unlock (called from UI) */
  const provideIdentity = useCallback((identity: UnlockedIdentity) => {
    identityRef.current = identity;
    setNeedsPassphrase(false);

    const client = clientRef.current;
    const pending = pendingChallengeRef.current;
    if (!client || !pending) return;

    // Sign the pending challenge
    signChallenge(identity, pending.challenge)
      .then((response) => client.send(response))
      .catch((err) => {
        setError(new Error(`Auth failed: ${errorToString(err)}`));
        client.disconnect();
      });
  }, []);

  // Connect to daemon
  const connect = useCallback(
    (url: string, directory?: string) => {
      // Clean up existing connection
      clientRef.current?.disconnect();

      // Reset state
      helloSentRef.current = false;
      pendingChallengeRef.current = null;
      setAuthRequired(false);
      setServerFingerprint(null);
      setNeedsPassphrase(false);

      // Store URL and directory for reconnects/TOFU
      urlRef.current = url;
      if (directory !== undefined) {
        directoryRef.current = directory;
      }

      const config: WebSocketClientConfig = {
        url,
        autoReconnect,
        // Legacy single-connection hook (superseded by useConnectionManager,
        // which escalates via onReconnectExhausted). It has no escalation
        // handler, so keep its historical retry-forever behavior rather than
        // inherit the new finite default and silently give up. (#435)
        maxReconnectAttempts: Number.POSITIVE_INFINITY,
      };

      const client = new WebSocketClient(config, {
        onStatusChange: (newStatus) => {
          setStatus(newStatus);

          if (newStatus === 'authenticating') {
            // Transport is open. Send hello immediately; if the daemon requires
            // auth, it will send auth_challenge first and reject this hello with
            // AUTH_REQUIRED (benign). After auth completes, hello is re-sent.
            // For daemons without auth, this hello is accepted directly.
            sendHello(client);
          }

          if (newStatus === 'disconnected') {
            setSessionId(null);
            helloSentRef.current = false;
          }
        },
        onMessage: handleMessage,
        onError: (err) => {
          console.error('[WebSocket] Error:', err);
          setError(err);
        },
      });

      clientRef.current = client;
      client.connect();
    },
    [autoReconnect, handleMessage],
  );

  // Disconnect from daemon
  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    setSessionId(null);
  }, []);

  // Send user input
  const sendInput = useCallback((targetSessionId: UUID, content: string): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createUserInput(targetSessionId, content));
  }, []);

  // Send answer to a question
  const sendAnswer = useCallback((sessionId: UUID, questionId: UUID, answer: string): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createAnswer(sessionId, questionId, answer));
  }, []);

  // Send raw message
  const sendMessage = useCallback((message: ProtocolMessage): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(message);
  }, []);

  // Request bullet expansion
  const requestBulletExpand = useCallback((targetSessionId: UUID, bulletId: number): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createBulletExpandRequest(targetSessionId, bulletId));
  }, []);

  // Request session list
  const requestSessionList = useCallback((includeExternal?: boolean): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createSessionListRequest(includeExternal));
  }, []);

  // Request transcript load for external session
  const requestTranscriptLoad = useCallback((targetSessionId: string): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createTranscriptLoadRequest(targetSessionId));
  }, []);

  // Request creation of a new Claude Code session
  const requestNewSession = useCallback((directory?: string): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createCreateSessionRequest(directory));
  }, []);

  // Request resume of a dead Claude Code session
  const requestResumeSession = useCallback((sessionId: string): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createResumeSessionRequest(sessionId));
  }, []);

  // Request recent directories from session history
  const requestSessionHistory = useCallback((limit?: number): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createSessionHistoryRequest(limit));
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  // Ping keep-alive
  useEffect(() => {
    if (status !== 'connected') return;

    const pingInterval = setInterval(() => {
      clientRef.current?.send(createPing());
    }, 30000);

    return () => clearInterval(pingInterval);
  }, [status]);

  return {
    status,
    error,
    connect,
    disconnect,
    sendInput,
    sendAnswer,
    sendMessage,
    requestBulletExpand,
    requestSessionList,
    requestTranscriptLoad,
    requestNewSession,
    requestResumeSession,
    requestSessionHistory,
    sessionId,
    authRequired,
    serverFingerprint,
    needsPassphrase,
    provideIdentity,
  };
}
