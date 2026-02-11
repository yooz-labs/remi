/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component wired to real daemon data.
 */

import { ChatView } from '@/components/chat';
import { AppLayout } from '@/components/layout';
import { ConnectModal, SessionList } from '@/components/session';
import { useWebSocket } from '@/hooks';
import type { UIBullet, UIMessage, UIQuestion, UISession } from '@/types';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { generateId } from '@remi/shared/protocol.ts';
import type { Bullet, DiscoverableSession, UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

const LOCALSTORAGE_URL_KEY = 'remi-last-url';

function App() {
  // State
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<UUID | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [question, setQuestion] = useState<UIQuestion | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);

  // Refs for stable callbacks
  const handleMessageRef = useRef<((message: ProtocolMessage) => void) | undefined>(undefined);
  const activeSessionIdRef = useRef<UUID | null>(null);
  const loadedTranscriptsRef = useRef<Set<string>>(new Set());

  // WebSocket connection
  const handleMessage = useCallback((message: ProtocolMessage) => {
    switch (message.type) {
      case 'hello_ack': {
        // Create a session for this connection
        const newSession: UISession = {
          id: message.sessionId,
          name: 'Claude Code Session',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          status: 'idle',
          connectionStatus: 'connected',
          unreadCount: 0,
          preview: 'Connected',
        };
        setSessions((prev) => {
          const exists = prev.find((s) => s.id === message.sessionId);
          if (exists) return prev.map((s) => (s.id === message.sessionId ? { ...s, connectionStatus: 'connected' } : s));
          return [...prev, newSession];
        });
        setActiveSessionId(message.sessionId);
        break;
      }

      case 'transcript_content': {
        const { sessionId, entryUuid, role, content, isUpdate } = message;
        const structuredMsg = message.message;

        // Convert bullets
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
          // Dedup by entryUuid
          if (isUpdate) {
            const idx = prev.findIndex((m) => m.entryUuid === entryUuid);
            if (idx >= 0) {
              return prev.map((m, i) =>
                i === idx
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
            }
          }

          // Check if already exists (dedup on reconnect/replay)
          if (prev.some((m) => m.entryUuid === entryUuid)) {
            return prev;
          }

          // Add new message
          const uiMessage: UIMessage = {
            id: structuredMsg.id,
            sessionId,
            sender: role === 'user' ? 'user' : 'agent',
            content: structuredMsg.content || content,
            timestamp: structuredMsg.createdAt || message.timestamp,
            state: 'delivered',
            isEditing: structuredMsg.isEditing,
            tool: structuredMsg.tool,
            entryUuid,
            bullets: uiBullets.length > 0 ? uiBullets : undefined,
            firstBulletId: structuredMsg.firstBulletId,
            lastBulletId: structuredMsg.lastBulletId,
          };
          return [...prev, uiMessage];
        });

        // Update session last active time
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, lastActiveAt: new Date().toISOString() }
              : s,
          ),
        );
        break;
      }

      case 'structured_agent_output': {
        // Handle structured message with bullets (from PTY stream)
        const structuredMsg = message.message;

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
          }
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
        });

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
        const sessionData = message.session;
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionData.id ? { ...s, status: sessionData.status } : s)),
        );
        break;
      }

      case 'question': {
        const q = message.question;
        // Map daemon Question to UIQuestion
        let questionType: UIQuestion['type'] = 'free_text';
        if (q.options.length > 0) {
          const hasYesNo = q.options.some((o) => o.isYes || o.isNo);
          if (hasYesNo) {
            questionType = 'yes_no';
          } else {
            questionType = 'numbered';
          }
        }

        const uiQuestion: UIQuestion = {
          id: q.id,
          sessionId: activeSessionIdRef.current ?? ('' as UUID),
          type: questionType,
          prompt: q.text,
          options: q.options.length > 0 ? q.options.map((o) => o.label) : undefined,
          timestamp: new Date().toISOString(),
        };
        setQuestion(uiQuestion);
        break;
      }

      case 'replay_batch': {
        // Re-dispatch each message in the batch through handleMessage
        for (const replayMsg of message.messages) {
          handleMessageRef.current?.(replayMsg);
        }
        break;
      }

      case 'session_list_response': {
        // Map DiscoverableSession[] to UISession[]
        const discovered: UISession[] = message.sessions.map((ds: DiscoverableSession) => ({
          id: ds.sessionId as UUID,
          name: ds.projectPath.split('/').pop() || 'Session',
          createdAt: ds.lastActivity,
          lastActiveAt: ds.lastActivity,
          status: ds.status === 'active' ? 'executing' as const :
                  ds.status === 'idle' ? 'idle' as const :
                  ds.status === 'orphaned' ? 'idle' as const :
                  'idle' as const,
          connectionStatus: ds.canAttach ? 'connected' as const : 'disconnected' as const,
          unreadCount: 0,
          cwd: ds.projectPath,
          preview: ds.lastMessage || `${ds.messageCount} messages`,
          source: ds.source,
        }));

        setSessions((prev) => {
          // Merge: keep existing sessions, add new ones from discovery
          const existingIds = new Set(prev.map((s) => s.id));
          const newSessions = discovered.filter((s) => !existingIds.has(s.id));
          return [...prev, ...newSessions];
        });
        break;
      }

      case 'bullet_expand_response': {
        const { bulletId, fullContent } = message;
        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.bullets) return msg;
            const bulletIndex = msg.bullets.findIndex((b) => b.bulletId === bulletId);
            if (bulletIndex < 0) return msg;

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

      case 'transcript_load_complete': {
        // Mark session as done loading
        setSessions((prev) =>
          prev.map((s) =>
            s.id === message.sessionId ? { ...s, isLoadingTranscript: false } : s,
          ),
        );
        break;
      }

      case 'error':
        console.error('Daemon error:', message);
        break;
    }
  }, []);

  // Keep refs in sync
  useEffect(() => {
    handleMessageRef.current = handleMessage;
  }, [handleMessage]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const {
    status: connectionStatus,
    error: wsError,
    connect,
    sendInput,
    sendAnswer,
    requestBulletExpand,
    requestSessionList,
    requestTranscriptLoad,
    sessionId: wsSessionId,
  } = useWebSocket({ onMessage: handleMessage });

  const error = wsError?.message ?? null;

  // Close modal and store URL on successful connect
  useEffect(() => {
    if (connectionStatus === 'connected') {
      setShowConnectModal(false);
    }
  }, [connectionStatus]);

  // Request session list after connection
  useEffect(() => {
    if (connectionStatus === 'connected' && wsSessionId) {
      requestSessionList(true);
    }
  }, [connectionStatus, wsSessionId, requestSessionList]);

  // Auto-connect from localStorage on mount (run once)
  const connectRef = useRef(connect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    const storedUrl = localStorage.getItem(LOCALSTORAGE_URL_KEY);
    if (storedUrl) {
      connectRef.current(storedUrl);
    }
  }, []);

  // Get active session
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionMessages = messages.filter((m) => m.sessionId === activeSessionId);
  const sessionQuestion = question?.sessionId === activeSessionId ? question : null;

  // Handlers
  const handleSelectSession = useCallback((id: UUID) => {
    setActiveSessionId(id);

    // If this is an external transcript session we haven't loaded yet, request its history
    const session = sessions.find((s) => s.id === id);
    if (session?.source === 'transcript' && !loadedTranscriptsRef.current.has(id)) {
      loadedTranscriptsRef.current.add(id);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, isLoadingTranscript: true } : s)),
      );
      requestTranscriptLoad(id);
    }
  }, [sessions, requestTranscriptLoad]);

  const handleBack = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      if (!activeSessionId) return;

      // If there's an active question, send as answer
      if (sessionQuestion) {
        sendAnswer(sessionQuestion.id, content);
        setQuestion(null);
        // Add user message to UI
        const userMsg: UIMessage = {
          id: generateId(),
          sessionId: activeSessionId,
          sender: 'user',
          content,
          timestamp: new Date().toISOString(),
          state: 'sent',
          isEditing: false,
        };
        setMessages((prev) => [...prev, userMsg]);
        return;
      }

      // Regular user input
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

      const success = sendInput(activeSessionId, content);
      if (success) {
        setMessages((prev) =>
          prev.map((m) => (m.id === newMessage.id ? { ...m, state: 'sent' } : m)),
        );
      }
    },
    [activeSessionId, sendInput, sendAnswer, sessionQuestion],
  );

  const handleConnectDirect = useCallback(
    (url: string, directory?: string) => {
      localStorage.setItem(LOCALSTORAGE_URL_KEY, url);
      connect(url, directory);
    },
    [connect],
  );

  const handleConnectCode = useCallback((_code: string) => {
    void _code;
    console.warn('WebRTC connection not yet implemented');
  }, []);

  const handleBulletExpand = useCallback(
    (bulletId: number) => {
      if (!activeSessionId) return;

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
      <p>Select a session or connect to a daemon</p>
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
