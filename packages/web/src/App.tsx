/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component wired to real daemon data.
 */

import { ChatView } from '@/components/chat';
import { AppLayout } from '@/components/layout';
import { ConnectModal, SessionList } from '@/components/session';
import { SettingsPanel } from '@/components/settings';
import { useWebSocket } from '@/hooks';
import type { AppSettings, UIBullet, UIMessage, UIQuestion, UISession } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { hasIdentity, unlockStoredIdentity } from '@/lib/identity-client';
import type { UnlockedIdentity } from '@remi/shared';
import {
  createAuthResponse,
  fromBase64,
  sign,
} from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import {
  createBulletExpandRequest,
  createCreateSessionRequest,
  createHello,
  createSessionListRequest,
  createTranscriptLoadRequest,
  createUserInput,
  generateId,
  now,
} from '@remi/shared/protocol.ts';
import type { Bullet, DiscoverableSession, UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

const LOCALSTORAGE_URL_KEY = 'remi-last-url';
const LOCALSTORAGE_SESSION_KEY = 'remi-last-session';
const LOCALSTORAGE_SETTINGS_KEY = 'remi-settings';

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(LOCALSTORAGE_SETTINGS_KEY);
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch { /* use defaults */ }
  return DEFAULT_SETTINGS;
}

function applyTheme(theme: AppSettings['theme']) {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

function App() {
  // State
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<UUID | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [question, setQuestion] = useState<UIQuestion | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [unlockedIdentity, setUnlockedIdentity] = useState<UnlockedIdentity | null>(null);

  // Refs for stable callbacks
  const handleMessageRef = useRef<((message: ProtocolMessage) => void) | undefined>(undefined);
  const activeSessionIdRef = useRef<UUID | null>(null);
  const loadedTranscriptsRef = useRef<Set<string>>(new Set());

  // Apply theme and font size on settings change
  useEffect(() => {
    applyTheme(settings.theme);

    const fontSizeMap = { small: '14px', medium: '16px', large: '18px' } as const;
    document.documentElement.style.setProperty(
      '--font-size-base',
      fontSizeMap[settings.fontSize] ?? '16px',
    );

    localStorage.setItem(LOCALSTORAGE_SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const handleSettingsChange = useCallback((newSettings: AppSettings) => {
    setSettings(newSettings);
  }, []);

  // WebSocket connection
  const handleMessage = useCallback((message: ProtocolMessage) => {
    switch (message.type) {
      case 'hello_ack': {
        setSessions((prev) => {
          const exists = prev.some((s) => s.id === message.sessionId);
          if (exists) {
            return prev.map((s) =>
              s.id === message.sessionId ? { ...s, connectionStatus: 'connected' } : s,
            );
          }
          // Only create new entry for non-resume (resume expects session to exist)
          if (message.isResume) return prev;
          return [...prev, {
            id: message.sessionId,
            name: 'Claude Code Session',
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            status: 'idle',
            connectionStatus: 'connected',
            unreadCount: 0,
            preview: 'Connected',
          } satisfies UISession];
        });
        setCreatingSession(false);
        setActiveSessionId(message.sessionId);
        localStorage.setItem(LOCALSTORAGE_SESSION_KEY, message.sessionId);
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

      case 'create_session_response': {
        setCreatingSession(false);
        if (!message.success) {
          console.error(`Failed to create session: ${message.error}`);
          // Add error message to the current session's chat so the user sees it
          const errorMsg: UIMessage = {
            id: generateId(),
            sessionId: activeSessionIdRef.current ?? ('' as UUID),
            sender: 'system',
            content: `Failed to create session: ${message.error ?? 'Unknown error'}`,
            timestamp: new Date().toISOString(),
            state: 'delivered',
            isEditing: false,
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
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

  // Restore session ID from localStorage for reconnect after page reload (read once)
  const [storedSessionId] = useState<UUID | null>(
    () => localStorage.getItem(LOCALSTORAGE_SESSION_KEY) as UUID | null,
  );

  const signalingClientRef = useRef<import('@/lib/signaling-client').WebSignalingClient | null>(null);
  const [connectionMode, setConnectionMode] = useState<'direct' | 'relay'>('direct');
  const [relayStatus, setRelayStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');

  const {
    status: connectionStatus,
    error: wsError,
    connect,
    sendInput,
    sendAnswer,
    requestBulletExpand,
    requestSessionList,
    requestTranscriptLoad,
    requestNewSession,
    sessionId: wsSessionId,
    needsPassphrase,
    serverFingerprint,
    provideIdentity,
  } = useWebSocket({
    onMessage: handleMessage,
    initialResumeSessionId: storedSessionId ?? undefined,
    unlockedIdentity,
  });

  const error = wsError?.message ?? null;

  // Effective connection status: use relay status when in relay mode
  const effectiveStatus = connectionMode === 'relay' ? relayStatus : connectionStatus;

  // Relay-aware send: dispatches through signaling client when in relay mode
  const relaySend = useCallback((message: ProtocolMessage): boolean => {
    if (connectionMode === 'relay') {
      if (signalingClientRef.current?.isConnected) {
        signalingClientRef.current.sendMessage(message);
        return true;
      }
      console.warn(`Relay send dropped (not connected): ${message.type}`);
      return false;
    }
    return false;
  }, [connectionMode]);

  // Relay-aware wrappers for send functions
  const effectiveSendInput = useCallback((sessionId: UUID, content: string): boolean => {
    if (connectionMode === 'relay') return relaySend(createUserInput(sessionId, content));
    return sendInput(sessionId, content);
  }, [connectionMode, relaySend, sendInput]);

  const effectiveSendAnswer = useCallback((questionId: UUID, answer: string): boolean => {
    if (connectionMode === 'relay') {
      return relaySend({ type: 'answer', id: generateId(), timestamp: now(), questionId, answer });
    }
    return sendAnswer(questionId, answer);
  }, [connectionMode, relaySend, sendAnswer]);

  const effectiveRequestBulletExpand = useCallback((sessionId: UUID, bulletId: number): boolean => {
    if (connectionMode === 'relay') return relaySend(createBulletExpandRequest(sessionId, bulletId));
    return requestBulletExpand(sessionId, bulletId);
  }, [connectionMode, relaySend, requestBulletExpand]);

  const effectiveRequestSessionList = useCallback((includeExternal?: boolean): boolean => {
    if (connectionMode === 'relay') return relaySend(createSessionListRequest(includeExternal));
    return requestSessionList(includeExternal);
  }, [connectionMode, relaySend, requestSessionList]);

  const effectiveRequestTranscriptLoad = useCallback((sessionId: string): boolean => {
    if (connectionMode === 'relay') return relaySend(createTranscriptLoadRequest(sessionId));
    return requestTranscriptLoad(sessionId);
  }, [connectionMode, relaySend, requestTranscriptLoad]);

  const effectiveRequestNewSession = useCallback((directory?: string): boolean => {
    if (connectionMode === 'relay') return relaySend(createCreateSessionRequest(directory));
    return requestNewSession(directory);
  }, [connectionMode, relaySend, requestNewSession]);

  // Close modal and store URL on successful connect
  useEffect(() => {
    if (connectionStatus === 'connected') {
      setShowConnectModal(false);
    }
  }, [connectionStatus]);

  // Request session list after direct connection
  useEffect(() => {
    if (connectionStatus === 'connected' && wsSessionId) {
      effectiveRequestSessionList(true);
    }
  }, [connectionStatus, wsSessionId, effectiveRequestSessionList]);

  // Request session list after relay connection (hello_ack received)
  useEffect(() => {
    if (connectionMode === 'relay' && relayStatus === 'connected' && activeSessionId) {
      effectiveRequestSessionList(true);
    }
  }, [connectionMode, relayStatus, activeSessionId, effectiveRequestSessionList]);

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
    localStorage.setItem(LOCALSTORAGE_SESSION_KEY, id);

    // If this is an external transcript session we haven't loaded yet, request its history
    const session = sessions.find((s) => s.id === id);
    if (session?.source === 'transcript' && !loadedTranscriptsRef.current.has(id)) {
      loadedTranscriptsRef.current.add(id);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, isLoadingTranscript: true } : s)),
      );
      effectiveRequestTranscriptLoad(id);
    }
  }, [sessions, effectiveRequestTranscriptLoad]);

  const handleBack = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      if (!activeSessionId) return;

      // If there's an active question, send as answer
      if (sessionQuestion) {
        effectiveSendAnswer(sessionQuestion.id, content);
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

      const success = effectiveSendInput(activeSessionId, content);
      if (success) {
        setMessages((prev) =>
          prev.map((m) => (m.id === newMessage.id ? { ...m, state: 'sent' } : m)),
        );
      }
    },
    [activeSessionId, effectiveSendInput, effectiveSendAnswer, sessionQuestion],
  );

  const handlePassphraseSubmit = useCallback(async (passphrase: string) => {
    try {
      const identity = await unlockStoredIdentity(passphrase);
      setUnlockedIdentity(identity);
      provideIdentity(identity);
    } catch (err) {
      console.error('Failed to unlock identity:', err);
      throw err;
    }
  }, [provideIdentity]);

  const handleConnectDirect = useCallback(
    (url: string, directory?: string) => {
      setConnectionMode('direct');
      // Close any existing relay connection
      if (signalingClientRef.current) {
        signalingClientRef.current.close();
        signalingClientRef.current = null;
        setRelayStatus('disconnected');
      }
      localStorage.setItem(LOCALSTORAGE_URL_KEY, url);
      connect(url, directory);
    },
    [connect],
  );

  // Clean up signaling client on unmount
  useEffect(() => {
    return () => {
      signalingClientRef.current?.close();
    };
  }, []);

  const handleConnectCode = useCallback((code: string) => {
    // Dynamic import to avoid bundling when not used
    import('@/lib/signaling-client').then(({ WebSignalingClient }) => {
      // Close existing signaling connection if any
      if (signalingClientRef.current) {
        signalingClientRef.current.close();
      }

      setConnectionMode('relay');
      setRelayStatus('connecting');

      const signalingUrl = 'wss://remi-signaling.dev-941.workers.dev/connect';
      const client = new WebSignalingClient({
        onStateChange: (state) => {
          if (state === 'connected') {
            setRelayStatus('connected');
            setShowConnectModal(false);
            // Send hello via relay (harmless if auth is required; daemon drops it
            // and sends auth_challenge first, then hello_ack after auth completes)
            client.sendMessage(createHello('remi-web', '0.1.0'));
          } else if (state === 'connecting' || state === 'joined') {
            setRelayStatus('connecting');
          } else if (state === 'disconnected' || state === 'error') {
            setRelayStatus('disconnected');
          }
        },
        onMessage: (message) => {
          if (!message || typeof message !== 'object' || !('type' in message)) return;
          const msg = message as ProtocolMessage;

          // Handle auth_challenge: sign with identity and respond
          if (msg.type === 'auth_challenge') {
            const identity = unlockedIdentity;
            if (!identity) {
              console.error('Relay auth_challenge received but no unlocked identity');
              setRelayStatus('disconnected');
              client.close();
              return;
            }
            (async () => {
              try {
                const challengeData = fromBase64(msg.challenge);
                const signature = await sign(identity.privateKey, challengeData);
                client.sendMessage(createAuthResponse(
                  identity.publicKeyRaw,
                  signature,
                  identity.fingerprint,
                ));
              } catch (err) {
                console.error('Relay auth failed:', err instanceof Error ? err.message : err);
                setRelayStatus('disconnected');
              }
            })();
            return;
          }

          // Handle auth_result: on success re-send hello, on failure disconnect
          if (msg.type === 'auth_result') {
            if (!msg.success) {
              console.error(`Relay auth rejected: ${msg.error ?? 'unknown'}`);
              setRelayStatus('disconnected');
            } else {
              // Auth succeeded; now send hello so the daemon creates our session
              client.sendMessage(createHello('remi-web', '0.1.0'));
            }
            return;
          }

          // Forward all other messages to the existing handler
          handleMessageRef.current?.(msg);
        },
        onError: (errCode, errMsg) => {
          console.error(`Signaling error [${errCode}]: ${errMsg}`);
        },
      });

      signalingClientRef.current = client;
      client.connect(signalingUrl, code);
    }).catch((err) => {
      console.error('Failed to load signaling client:', err);
      setRelayStatus('disconnected');
      setConnectionMode('direct');
    });
  }, [unlockedIdentity]);

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

      effectiveRequestBulletExpand(activeSessionId, bulletId);
    },
    [activeSessionId, effectiveRequestBulletExpand],
  );

  const handleNewSession = useCallback(() => {
    if (creatingSession) return;
    setCreatingSession(true);
    effectiveRequestNewSession();
  }, [effectiveRequestNewSession, creatingSession]);

  // Menu actions
  const handleCopyConversation = useCallback(() => {
    const text = sessionMessages
      .map((m) => `[${m.sender}] ${m.content}`)
      .join('\n\n');
    navigator.clipboard.writeText(text);
  }, [sessionMessages]);

  const handleClearMessages = useCallback(() => {
    if (activeSessionId) {
      setMessages((prev) => prev.filter((m) => m.sessionId !== activeSessionId));
    }
  }, [activeSessionId]);

  const handleExportText = useCallback(() => {
    const text = sessionMessages
      .map((m) => `[${new Date(m.timestamp).toLocaleString()}] [${m.sender}] ${m.content}`)
      .join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `remi-session-${activeSessionId?.slice(0, 8) ?? 'unknown'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [sessionMessages, activeSessionId]);

  // Sidebar content
  const canCreateSession = effectiveStatus === 'connected' && !creatingSession;
  const sidebar = (
    <SessionList
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={handleSelectSession}
      onNewSession={canCreateSession ? handleNewSession : undefined}
      onConnect={() => setShowConnectModal(true)}
      onSettings={() => setShowSettings(true)}
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
      onCopyConversation={handleCopyConversation}
      onClearMessages={handleClearMessages}
      onExportText={handleExportText}
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

      <SettingsPanel
        open={showSettings}
        settings={settings}
        onClose={() => setShowSettings(false)}
        onChange={handleSettingsChange}
      />

      <ConnectModal
        isOpen={showConnectModal || needsPassphrase}
        onClose={() => setShowConnectModal(false)}
        onConnectDirect={handleConnectDirect}
        onConnectCode={handleConnectCode}
        connectionStatus={effectiveStatus}
        error={error}
        needsPassphrase={needsPassphrase}
        hasIdentity={hasIdentity()}
        serverFingerprint={serverFingerprint}
        onPassphraseSubmit={handlePassphraseSubmit}
      />
    </>
  );
}

export default App;
