/**
 * React hook for WebSocket connection to daemon.
 *
 * Provides reactive connection state and message handling.
 * Handles auth handshake when daemon requires authentication.
 */

import { WebSocketClient, type WebSocketClientConfig } from '@/lib/websocket-client';
import type { ConnectionStatus } from '@/types';
import type { UnlockedIdentity } from '@remi/shared';
import {
  createAuthResponse,
  fromBase64,
  importPublicKey,
  sign,
  verify,
} from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import {
  createBulletExpandRequest,
  createCreateSessionRequest,
  createHello,
  createPing,
  createSessionListRequest,
  createTranscriptLoadRequest,
  createUserInput,
  generateId,
  now,
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
  sendAnswer: (questionId: UUID, answer: string) => boolean;
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

/** Time to wait for auth_challenge before assuming no-auth mode (ms) */
const AUTH_CHALLENGE_TIMEOUT = 500;

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
  const identityRef = useRef<UnlockedIdentity | null>(unlockedIdentity ?? null);
  const authChallengeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChallengeRef = useRef<{ challenge: string; serverPublicKey: string } | null>(null);
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
  const sendHello = useCallback((client: WebSocketClient) => {
    if (helloSentRef.current) return;
    helloSentRef.current = true;
    const resumeId = lastSessionIdRef.current ?? undefined;
    client.send(createHello(clientId, clientVersion, directoryRef.current, resumeId));
  }, [clientId, clientVersion]);

  /** Handle auth_challenge: sign and respond */
  const handleAuthChallenge = useCallback(async (
    challenge: string,
    srvFingerprint: string,
    srvPublicKey: string,
    client: WebSocketClient,
  ) => {
    // Clear no-auth timeout
    if (authChallengeTimerRef.current) {
      clearTimeout(authChallengeTimerRef.current);
      authChallengeTimerRef.current = null;
    }

    setAuthRequired(true);
    setServerFingerprint(srvFingerprint);

    const identity = identityRef.current;
    if (!identity) {
      // Need passphrase from user; store pending challenge
      pendingChallengeRef.current = { challenge, serverPublicKey: srvPublicKey };
      setNeedsPassphrase(true);
      return;
    }

    // Sign the challenge
    try {
      const challengeData = fromBase64(challenge);
      const signature = await sign(identity.privateKey, challengeData);
      const response = createAuthResponse(
        identity.publicKeyRaw,
        signature,
        identity.fingerprint,
      );
      client.send(response);
    } catch (err) {
      setError(new Error(`Auth failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }, []);

  /** Handle auth_result */
  const handleAuthResult = useCallback(async (
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

    // Verify server signature for mutual auth
    if (srvSignature && pendingChallengeRef.current) {
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
      } catch {
        // Non-fatal; server signature verification is optional
      }
    }

    pendingChallengeRef.current = null;
    setNeedsPassphrase(false);

    // Auth passed; now send hello
    client.setConnected();
    sendHello(client);
  }, [sendHello]);

  // Handle incoming messages
  const handleMessage = useCallback((message: ProtocolMessage) => {
    const client = clientRef.current;
    if (!client) return;

    // Intercept auth messages
    if (message.type === 'auth_challenge') {
      handleAuthChallenge(
        message.challenge,
        message.serverFingerprint,
        message.serverPublicKey,
        client,
      );
      return;
    }

    if (message.type === 'auth_result') {
      handleAuthResult(
        message.success,
        message.error,
        message.serverSignature,
        client,
      );
      return;
    }

    // Handle hello_ack to get session ID
    if (message.type === 'hello_ack') {
      setSessionId(message.sessionId);
      lastSessionIdRef.current = message.sessionId;
    }

    // Forward to user handler
    onMessageRef.current?.(message);
  }, [handleAuthChallenge, handleAuthResult]);

  /** Provide identity after passphrase unlock (called from UI) */
  const provideIdentity = useCallback((identity: UnlockedIdentity) => {
    identityRef.current = identity;
    setNeedsPassphrase(false);

    const client = clientRef.current;
    const pending = pendingChallengeRef.current;
    if (!client || !pending) return;

    // Sign the pending challenge
    (async () => {
      try {
        const challengeData = fromBase64(pending.challenge);
        const signature = await sign(identity.privateKey, challengeData);
        const response = createAuthResponse(
          identity.publicKeyRaw,
          signature,
          identity.fingerprint,
        );
        client.send(response);
      } catch (err) {
        setError(new Error(`Auth failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    })();
  }, []);

  // Connect to daemon
  const connect = useCallback(
    (url: string, directory?: string) => {
      // Clean up existing connection
      clientRef.current?.disconnect();
      if (authChallengeTimerRef.current) {
        clearTimeout(authChallengeTimerRef.current);
        authChallengeTimerRef.current = null;
      }

      // Reset state
      helloSentRef.current = false;
      pendingChallengeRef.current = null;
      setAuthRequired(false);
      setServerFingerprint(null);
      setNeedsPassphrase(false);

      // Store directory for reconnects
      if (directory !== undefined) {
        directoryRef.current = directory;
      }

      const config: WebSocketClientConfig = {
        url,
        autoReconnect,
      };

      const client = new WebSocketClient(config, {
        onStatusChange: (newStatus) => {
          setStatus(newStatus);

          if (newStatus === 'authenticating') {
            // WebSocket is open; wait for auth_challenge or assume no-auth
            authChallengeTimerRef.current = setTimeout(() => {
              // No auth_challenge received; assume no-auth mode
              authChallengeTimerRef.current = null;
              client.setConnected();
              sendHello(client);
            }, AUTH_CHALLENGE_TIMEOUT);
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
    [autoReconnect, handleMessage, sendHello],
  );

  // Disconnect from daemon
  const disconnect = useCallback(() => {
    if (authChallengeTimerRef.current) {
      clearTimeout(authChallengeTimerRef.current);
      authChallengeTimerRef.current = null;
    }
    clientRef.current?.disconnect();
    setSessionId(null);
  }, []);

  // Send user input
  const sendInput = useCallback((targetSessionId: UUID, content: string): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(createUserInput(targetSessionId, content));
  }, []);

  // Send answer to a question
  const sendAnswer = useCallback((questionId: UUID, answer: string): boolean => {
    if (!clientRef.current) return false;
    const msg: ProtocolMessage = {
      type: 'answer',
      id: generateId(),
      timestamp: now(),
      questionId,
      answer,
    };
    return clientRef.current.send(msg);
  }, []);

  // Send raw message
  const sendMessage = useCallback((message: ProtocolMessage): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(message);
  }, []);

  // Request bullet expansion
  const requestBulletExpand = useCallback(
    (targetSessionId: UUID, bulletId: number): boolean => {
      if (!clientRef.current) return false;
      return clientRef.current.send(createBulletExpandRequest(targetSessionId, bulletId));
    },
    [],
  );

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

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (authChallengeTimerRef.current) {
        clearTimeout(authChallengeTimerRef.current);
      }
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
    sessionId,
    authRequired,
    serverFingerprint,
    needsPassphrase,
    provideIdentity,
  };
}
