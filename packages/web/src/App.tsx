/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component with demo state for development.
 */

import { useState, useCallback, useEffect } from 'react';
import { AppLayout } from '@/components/layout';
import { SessionList, ConnectModal } from '@/components/session';
import { ChatView } from '@/components/chat';
import { useWebSocket } from '@/hooks';
import type {
  UISession,
  UIMessage,
  UIQuestion,
  ConnectionStatus,
} from '@/types';
import type { UUID } from '@remi/shared/types.ts';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { generateId } from '@remi/shared/protocol.ts';

// Demo data for development
const DEMO_SESSIONS: UISession[] = [
  {
    id: 'session-1' as UUID,
    name: 'Project Remi',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'waiting',
    connectionStatus: 'connected',
    unreadCount: 2,
    cwd: '~/Documents/git/yooz/remi',
    preview: 'Ready for your input',
  },
  {
    id: 'session-2' as UUID,
    name: 'API Refactor',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    lastActiveAt: new Date(Date.now() - 1800000).toISOString(),
    status: 'idle',
    connectionStatus: 'connected',
    unreadCount: 0,
    cwd: '~/projects/api',
    preview: 'Refactoring complete',
  },
];

const DEMO_MESSAGES: UIMessage[] = [
  {
    id: 'msg-1' as UUID,
    sessionId: 'session-1' as UUID,
    sender: 'user',
    content: 'Can you help me create a WebSocket server for the daemon?',
    timestamp: new Date(Date.now() - 300000).toISOString(),
    state: 'read',
    isEditing: false,
  },
  {
    id: 'msg-2' as UUID,
    sessionId: 'session-1' as UUID,
    sender: 'agent',
    content:
      "I'll help you create a WebSocket server for the daemon. Let me first understand the architecture and then implement the server.\n\nI'll create a WebSocket server using Bun's native WebSocket support, which provides excellent performance and TypeScript integration.",
    timestamp: new Date(Date.now() - 290000).toISOString(),
    state: 'delivered',
    isEditing: false,
    tool: 'Read',
  },
  {
    id: 'msg-3' as UUID,
    sessionId: 'session-1' as UUID,
    sender: 'agent',
    content:
      "I've created the WebSocket server with the following features:\n\n- Protocol message handling\n- Connection management\n- Health check endpoint\n- Automatic cleanup on disconnect\n\nWould you like me to add any additional features?",
    timestamp: new Date(Date.now() - 60000).toISOString(),
    state: 'delivered',
    isEditing: false,
  },
];

const DEMO_QUESTION: UIQuestion = {
  id: 'q-1' as UUID,
  sessionId: 'session-1' as UUID,
  type: 'yes_no',
  prompt: 'Should I run the tests now?',
  timestamp: new Date().toISOString(),
};

function App() {
  // State
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<UUID | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [question] = useState<UIQuestion | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);

  // WebSocket connection
  const handleMessage = useCallback((message: ProtocolMessage) => {
    console.log('Received message type:', message.type, message);

    switch (message.type) {
      case 'hello_ack':
        // Create a session for this connection
        const newSession: UISession = {
          id: message.sessionId,
          name: 'Claude Code Session',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          status: 'idle',
          connectionStatus: 'connected',
          unreadCount: 0,
          cwd: '~/Documents/git/yooz/remi',
          preview: 'Connected to daemon',
        };
        setSessions([newSession]);
        setActiveSessionId(message.sessionId);
        setMessages([]); // Clear demo messages
        break;

      case 'agent_output':
        // Check if this is an update to an existing message or a new message
        const msgContent = message.message;
        setMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === msgContent.id);
          if (existingIndex >= 0) {
            // Update existing message
            return prev.map((m, i) =>
              i === existingIndex
                ? {
                    ...m,
                    content: msgContent.content,
                    isEditing: msgContent.isEditing,
                    tool: msgContent.tool,
                  }
                : m
            );
          } else {
            // Add new message
            const uiMessage: UIMessage = {
              id: msgContent.id,
              sessionId: msgContent.sessionId,
              sender: msgContent.sender,
              content: msgContent.content,
              timestamp: msgContent.createdAt,
              state: msgContent.state,
              isEditing: msgContent.isEditing,
              tool: msgContent.tool,
            };
            return [...prev, uiMessage];
          }
        });

        // Update session last active time
        setSessions((prev) =>
          prev.map((s) =>
            s.id === msgContent.sessionId
              ? { ...s, lastActiveAt: new Date().toISOString() }
              : s
          )
        );
        break;

      case 'status_update':
        // Update session status
        setSessions((prev) =>
          prev.map((s) =>
            s.id === message.sessionId
              ? { ...s, status: message.status }
              : s
          )
        );
        break;

      case 'question':
        // Handle question (TODO: implement question UI)
        console.log('Question received:', message.question);
        break;

      case 'error':
        console.error('Daemon error:', message);
        break;
    }
  }, []);

  const {
    status: connectionStatus,
    error: wsError,
    connect,
    disconnect,
    sendInput,
    sessionId: wsSessionId,
  } = useWebSocket({ onMessage: handleMessage });

  const error = wsError?.message ?? null;

  // Close modal when connected
  useEffect(() => {
    if (connectionStatus === 'connected') {
      setShowConnectModal(false);
    }
  }, [connectionStatus]);

  // Get active session
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionMessages = messages.filter(
    (m) => m.sessionId === activeSessionId,
  );
  const sessionQuestion =
    question?.sessionId === activeSessionId ? question : null;

  // Handlers
  const handleSelectSession = useCallback((id: UUID) => {
    setActiveSessionId(id);
  }, []);

  const handleBack = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      if (!activeSessionId) return;

      const newMessage: UIMessage = {
        id: generateId(),
        sessionId: activeSessionId,
        sender: 'user',
        content,
        timestamp: new Date().toISOString(),
        state: 'sending',
        isEditing: false,
      };

      setMessages((prev) => [...prev, newMessage]);

      // Send via WebSocket
      const success = sendInput(activeSessionId, content);
      if (success) {
        // Update state to sent
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMessage.id ? { ...m, state: 'sent' } : m,
          ),
        );
      } else {
        // Failed to send
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMessage.id ? { ...m, state: 'sending' } : m,
          ),
        );
      }
    },
    [activeSessionId, sendInput],
  );

  const handleConnectDirect = useCallback(
    (url: string) => {
      console.log('Connecting to:', url);
      connect(url);
    },
    [connect],
  );

  const handleConnectCode = useCallback((code: string) => {
    // TODO: Implement WebRTC signaling connection
    console.log('Connecting with code:', code);
    console.warn('WebRTC connection not yet implemented');
  }, []);

  // Sidebar content
  const sidebar = (
    <SessionList
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={handleSelectSession}
      onConnect={() => setShowConnectModal(true)}
      onSettings={() => console.log('Open settings')}
    />
  );

  // Main content
  const main = activeSession ? (
    <ChatView
      session={activeSession}
      messages={sessionMessages}
      question={sessionQuestion}
      error={error}
      onSend={handleSend}
      onBack={handleBack}
      onMore={() => console.log('More options')}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-[--color-text-muted]">
      <p>Select a session to start</p>
    </div>
  );

  return (
    <>
      <AppLayout
        sidebar={sidebar}
        main={main}
        showSidebar={!activeSessionId}
      />

      <ConnectModal
        isOpen={showConnectModal}
        onClose={() => setShowConnectModal(false)}
        onConnectDirect={handleConnectDirect}
        onConnectCode={handleConnectCode}
        connectionStatus={connectionStatus}
        error={null}
      />
    </>
  );
}

export default App;
