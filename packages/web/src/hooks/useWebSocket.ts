/**
 * React hook for WebSocket connection to daemon.
 *
 * Provides reactive connection state and message handling.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { WebSocketClient, type WebSocketClientConfig } from '@/lib/websocket-client';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { createHello, createUserInput, createPing } from '@remi/shared/protocol.ts';
import type { ConnectionStatus } from '@/types';
import type { UUID } from '@remi/shared/types.ts';

/** Hook return value */
export interface UseWebSocketReturn {
  /** Current connection status */
  status: ConnectionStatus;
  /** Last error */
  error: Error | null;
  /** Connect to daemon */
  connect: (url: string) => void;
  /** Disconnect from daemon */
  disconnect: () => void;
  /** Send user input */
  sendInput: (sessionId: UUID, content: string) => boolean;
  /** Send raw message */
  sendMessage: (message: ProtocolMessage) => boolean;
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
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const [sessionId, setSessionId] = useState<UUID | null>(null);

  const clientRef = useRef<WebSocketClient | null>(null);
  const onMessageRef = useRef(onMessage);

  // Keep onMessage ref updated
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  // Handle incoming messages
  const handleMessage = useCallback((message: ProtocolMessage) => {
    // Handle hello_ack to get session ID
    if (message.type === 'hello_ack') {
      setSessionId(message.sessionId);
    }

    // Forward to user handler
    onMessageRef.current?.(message);
  }, []);

  // Connect to daemon
  const connect = useCallback(
    (url: string) => {
      // Clean up existing connection
      clientRef.current?.disconnect();

      const config: WebSocketClientConfig = {
        url,
        autoReconnect,
      };

      const client = new WebSocketClient(config, {
        onStatusChange: (newStatus) => {
          setStatus(newStatus);
          if (newStatus === 'connected') {
            // Send hello message
            client.send(createHello(clientId, clientVersion));
          }
          if (newStatus === 'disconnected') {
            setSessionId(null);
          }
        },
        onMessage: handleMessage,
        onError: (err) => {
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
  const sendInput = useCallback(
    (targetSessionId: UUID, content: string): boolean => {
      if (!clientRef.current) return false;
      return clientRef.current.send(createUserInput(targetSessionId, content));
    },
    [],
  );

  // Send raw message
  const sendMessage = useCallback((message: ProtocolMessage): boolean => {
    if (!clientRef.current) return false;
    return clientRef.current.send(message);
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
    sendMessage,
    sessionId,
  };
}
