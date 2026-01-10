/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component with demo state for development.
 */

import { useState, useCallback } from 'react';
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
  // WebSocket connection
  const handleMessage = useCallback((message: ProtocolMessage) => {
    console.log('Received message:', message);
    // TODO: Handle different message types (output, question, status, etc.)
  }, []);

  const {
    status: connectionStatus,
    error: wsError,
    connect,
    disconnect,
    sendInput,
    sessionId: wsSessionId,
  } = useWebSocket({ onMessage: handleMessage });

  // State
  const [sessions] = useState<UISession[]>(DEMO_SESSIONS);
  const [activeSessionId, setActiveSessionId] = useState<UUID | null>(
    DEMO_SESSIONS[0]?.id ?? null,
  );
  const [messages, setMessages] = useState<UIMessage[]>(DEMO_MESSAGES);
  const [question] = useState<UIQuestion | null>(DEMO_QUESTION);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const error = wsError?.message ?? null;

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
        id: crypto.randomUUID() as UUID,
        sessionId: activeSessionId,
        sender: 'user',
        content,
        timestamp: new Date().toISOString(),
        state: 'sending',
        isEditing: false,
      };

      setMessages((prev) => [...prev, newMessage]);

      // Simulate message delivery
      setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMessage.id ? { ...m, state: 'delivered' } : m,
          ),
        );
      }, 500);
    },
    [activeSessionId],
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
