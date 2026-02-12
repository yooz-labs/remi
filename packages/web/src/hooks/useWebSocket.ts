/**
 * React hook for WebSocket connection to daemon.
 *
 * Provides reactive connection state and message handling.
 */

import { WebSocketClient, type WebSocketClientConfig } from '@/lib/websocket-client';
import type { ConnectionStatus } from '@/types';
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
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const [sessionId, setSessionId] = useState<UUID | null>(null);

  const clientRef = useRef<WebSocketClient | null>(null);
  const onMessageRef = useRef(onMessage);
  const lastSessionIdRef = useRef<UUID | null>(initialResumeSessionId ?? null);
  const directoryRef = useRef<string | undefined>(undefined);

  // Keep onMessage ref updated
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  // Handle incoming messages
  const handleMessage = useCallback((message: ProtocolMessage) => {
    // Handle hello_ack to get session ID
    if (message.type === 'hello_ack') {
      setSessionId(message.sessionId);
      lastSessionIdRef.current = message.sessionId;
    }

    // Forward to user handler
    onMessageRef.current?.(message);
  }, []);

  // Connect to daemon
  const connect = useCallback(
    (url: string, directory?: string) => {
      // Clean up existing connection
      clientRef.current?.disconnect();

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
          console.log('[WebSocket] Status changed:', newStatus);
          setStatus(newStatus);
          if (newStatus === 'connected') {
            // On reconnect, include resumeSessionId so daemon replays missed messages
            const resumeId = lastSessionIdRef.current ?? undefined;
            console.log('[WebSocket] Sending hello message...', resumeId ? `(resume: ${resumeId})` : '(new)');
            const sent = client.send(createHello(clientId, clientVersion, directoryRef.current, resumeId));
            console.log('[WebSocket] Hello message sent:', sent);
          }
          if (newStatus === 'disconnected') {
            setSessionId(null);
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
    [autoReconnect, clientId, clientVersion, handleMessage],
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
  };
}
