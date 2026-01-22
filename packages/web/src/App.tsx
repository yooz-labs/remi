/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component with demo state for development.
 */

import { ChatView } from '@/components/chat';
import { AppLayout } from '@/components/layout';
import { ConnectModal, SessionList } from '@/components/session';
import { useWebSocket } from '@/hooks';
import type { UIBullet, UIMessage, UIQuestion, UISession } from '@/types';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { generateId } from '@remi/shared/protocol.ts';
import type { Bullet, UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useState } from 'react';

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

      case 'structured_agent_output': {
        // Handle structured message with bullets
        const structuredMsg = message.message;

        // Convert Bullet[] to UIBullet[]
        const uiBullets: UIBullet[] = structuredMsg.bullets.map((b: Bullet) => ({
          bulletId: b.bulletId,
          type: b.type,
          content: b.content,
          originalNumber: b.originalNumber,
          startLine: b.startLine,
          endLine: b.endLine,
          hasCodeBlock: b.hasCodeBlock,
          isTruncated: b.isTruncated,
          fullLength: b.fullLength,
        }));

        setMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === structuredMsg.id);
          if (existingIndex >= 0) {
            // Update existing message
            return prev.map((m, i) =>
              i === existingIndex
                ? {
                    ...m,
                    content: structuredMsg.content,
                    isEditing: structuredMsg.isEditing,
                    tool: structuredMsg.tool,
                    bullets: uiBullets,
                    firstBulletId: structuredMsg.firstBulletId,
                    lastBulletId: structuredMsg.lastBulletId,
                  }
                : m,
            );
          } else {
            // Add new message
            const uiMessage: UIMessage = {
              id: structuredMsg.id,
              sessionId: structuredMsg.sessionId,
              sender: structuredMsg.sender,
              content: structuredMsg.content,
              timestamp: structuredMsg.createdAt,
              state: structuredMsg.state,
              isEditing: structuredMsg.isEditing,
              tool: structuredMsg.tool,
              bullets: uiBullets,
              firstBulletId: structuredMsg.firstBulletId,
              lastBulletId: structuredMsg.lastBulletId,
            };
            return [...prev, uiMessage];
          }
        });

        // Update session last active time
        setSessions((prev) =>
          prev.map((s) =>
            s.id === structuredMsg.sessionId
              ? { ...s, lastActiveAt: new Date().toISOString() }
              : s,
          ),
        );
        break;
      }

      case 'session_update': {
        // Update session status (status is nested in session object)
        const sessionData = message.session;
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionData.id ? { ...s, status: sessionData.status } : s)),
        );
        break;
      }

      case 'question':
        // Handle question (TODO: implement question UI)
        console.log('Question received:', message.question);
        break;

      case 'bullet_expand_response': {
        // Update the bullet with full content
        const { bulletId, fullContent } = message;
        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.bullets) return msg;
            const bulletIndex = msg.bullets.findIndex((b) => b.bulletId === bulletId);
            if (bulletIndex < 0) return msg;

            // Update the bullet with full content
            const updatedBullets = msg.bullets.map((b) =>
              b.bulletId === bulletId
                ? { ...b, fullContent, content: fullContent, isExpanding: false }
                : b,
            );
            return { ...msg, bullets: updatedBullets };
          }),
        );
        break;
      }

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
    requestBulletExpand,
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
  const sessionMessages = messages.filter((m) => m.sessionId === activeSessionId);
  const sessionQuestion = question?.sessionId === activeSessionId ? question : null;

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
          prev.map((m) => (m.id === newMessage.id ? { ...m, state: 'sent' } : m)),
        );
      } else {
        // Failed to send
        setMessages((prev) =>
          prev.map((m) => (m.id === newMessage.id ? { ...m, state: 'sending' } : m)),
        );
      }
    },
    [activeSessionId, sendInput],
  );

  const handleConnectDirect = useCallback(
    (url: string, directory?: string) => {
      console.log('Connecting to:', url, 'directory:', directory);
      connect(url, directory);
    },
    [connect],
  );

  const handleConnectCode = useCallback((code: string) => {
    // TODO: Implement WebRTC signaling connection
    console.log('Connecting with code:', code);
    console.warn('WebRTC connection not yet implemented');
  }, []);

  const handleBulletExpand = useCallback(
    (bulletId: number) => {
      if (!activeSessionId) return;

      // Mark bullet as expanding
      setMessages((prev) =>
        prev.map((msg) => {
          if (!msg.bullets) return msg;
          const bulletIndex = msg.bullets.findIndex((b) => b.bulletId === bulletId);
          if (bulletIndex < 0) return msg;

          const updatedBullets = msg.bullets.map((b) =>
            b.bulletId === bulletId ? { ...b, isExpanding: true } : b,
          );
          return { ...msg, bullets: updatedBullets };
        }),
      );

      // Request expansion from daemon
      requestBulletExpand(activeSessionId, bulletId);
    },
    [activeSessionId, requestBulletExpand],
  );

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
      onBulletExpand={handleBulletExpand}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-[--color-text-muted]">
      <p>Select a session to start</p>
    </div>
  );

  return (
    <>
      <AppLayout sidebar={sidebar} main={main} showSidebar={!activeSessionId} />

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
