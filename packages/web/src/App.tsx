/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component wired to real daemon data.
 */

import { ChatView, SessionSwitcher } from '@/components/chat';
import { AppLayout } from '@/components/layout';
import { ConnectModal, SessionList } from '@/components/session';
import { SettingsPanel } from '@/components/settings';
import { useWebSocket } from '@/hooks';
import { hasIdentity, unlockStoredIdentity } from '@/lib/identity-client';
import { checkKnownHost, trustHost } from '@/lib/identity-client';
import { deduplicateMessage } from '@/lib/message-dedup';
import type {
  AppSettings,
  UIBullet,
  UIMessage,
  UIQuestion,
  UIQuestionOption,
  UISession,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import type { UnlockedIdentity } from '@remi/shared';
import { createAuthResponse, fromBase64, importPublicKey, sign, verify } from '@remi/shared';
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
  } catch (err) {
    console.warn('Failed to load settings, using defaults:', err);
  }
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

/** Convert shared Bullet[] to UIBullet[] */
function toBullets(bullets: readonly Bullet[]): UIBullet[] {
  return bullets.map((b) => ({
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
}

/** Map DiscoverableSession status to UISession agent status */
function mapSessionStatus(status: string): 'executing' | 'idle' {
  return status === 'active' ? 'executing' : 'idle';
}

/** Update a session's last-active time, clear questionPending, and bump unread if not active */
function updateSessionActivity(
  sessions: UISession[],
  sessionId: UUID,
  activeId: UUID | null,
  preview?: string,
): UISession[] {
  return sessions.map((s) =>
    s.id === sessionId
      ? {
          ...s,
          lastActiveAt: new Date().toISOString(),
          questionPending: false,
          unreadCount: s.id === activeId ? s.unreadCount : s.unreadCount + 1,
          preview: preview?.slice(0, 80) || s.preview,
        }
      : s,
  );
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
  const [showSessionSwitcher, setShowSessionSwitcher] = useState(false);

  // Refs for stable callbacks
  const handleMessageRef = useRef<((message: ProtocolMessage) => void) | undefined>(undefined);
  const activeSessionIdRef = useRef<UUID | null>(null);
  const loadedTranscriptsRef = useRef<Set<string>>(new Set());
  const unlockedIdentityRef = useRef<UnlockedIdentity | null>(null);

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
        // Daemon mode sends empty sessionId; skip session creation
        if (!message.sessionId) {
          setCreatingSession(false);
          break;
        }
        setSessions((prev) => {
          const exists = prev.some((s) => s.id === message.sessionId);
          if (exists) {
            return prev.map((s) =>
              s.id === message.sessionId ? { ...s, connectionStatus: 'connected' } : s,
            );
          }
          // Only create new entry for non-resume (resume expects session to exist)
          if (message.isResume) return prev;
          return [
            ...prev,
            {
              id: message.sessionId,
              name: 'Claude Code Session',
              createdAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              status: 'idle',
              connectionStatus: 'connected',
              unreadCount: 0,
              preview: 'Connected',
            } satisfies UISession,
          ];
        });
        setCreatingSession(false);
        setActiveSessionId(message.sessionId);
        localStorage.setItem(LOCALSTORAGE_SESSION_KEY, message.sessionId);
        break;
      }

      case 'transcript_content': {
        const { sessionId, entryUuid, role, content, isUpdate } = message;
        const structuredMsg = message.message;

        const uiBullets = toBullets(structuredMsg.bullets);

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

          const newSender = role === 'user' ? 'user' : 'agent';
          const resolvedContent = structuredMsg.content || content;

          // Cross-type dedup via extracted pure function
          const dedup = deduplicateMessage(prev, {
            sessionId,
            sender: newSender,
            content: resolvedContent,
            entryUuid,
            source: 'transcript',
          });

          if (dedup.action === 'skip') {
            return prev;
          }

          // Add new message
          const uiMessage: UIMessage = {
            id: structuredMsg.id,
            sessionId,
            sender: newSender,
            content: resolvedContent,
            timestamp: structuredMsg.createdAt || message.timestamp,
            state: 'delivered',
            isEditing: structuredMsg.isEditing,
            tool: structuredMsg.tool,
            entryUuid,
            source: 'transcript',
            bullets: uiBullets.length > 0 ? uiBullets : undefined,
            firstBulletId: structuredMsg.firstBulletId,
            lastBulletId: structuredMsg.lastBulletId,
          };

          if (dedup.action === 'replace') {
            // Replace the PTY-sourced duplicate with the transcript version
            return prev.map((m, i) => (i === dedup.replaceIndex ? uiMessage : m));
          }

          return [...prev, uiMessage];
        });

        setSessions((prev) =>
          updateSessionActivity(prev, sessionId, activeSessionIdRef.current, structuredMsg.content),
        );
        break;
      }

      case 'structured_agent_output': {
        // Handle structured message with bullets (from PTY stream)
        const structuredMsg = message.message;

        const uiBullets = toBullets(structuredMsg.bullets);

        setMessages((prev) => {
          // Same-type dedup by message ID (streaming updates)
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

          // Cross-type dedup via extracted pure function
          const dedup = deduplicateMessage(prev, {
            sessionId: structuredMsg.sessionId,
            sender: structuredMsg.sender,
            content: structuredMsg.content,
            source: 'pty',
          });
          if (dedup.action === 'skip') {
            return prev;
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
            source: 'pty',
            bullets: uiBullets,
            firstBulletId: structuredMsg.firstBulletId,
            lastBulletId: structuredMsg.lastBulletId,
          };
          return [...prev, uiMessage];
        });

        setSessions((prev) =>
          updateSessionActivity(
            prev,
            structuredMsg.sessionId,
            activeSessionIdRef.current,
            structuredMsg.content,
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
            // Check for multi-option (yes/no plus extra options like all/quit)
            const extraOptions = q.options.filter((o) => !o.isYes && !o.isNo);
            questionType = extraOptions.length > 0 ? 'multi_option' : 'yes_no';
          } else {
            questionType = 'numbered';
          }
        }

        // Build structured options with full metadata
        const structuredOptions: UIQuestionOption[] = q.options.map((o) => ({
          label: o.label,
          value: o.value,
          isYes: o.isYes || undefined,
          isNo: o.isNo || undefined,
          isRecommended: o.isRecommended || undefined,
        }));

        // Use sessionId from the message when available; fall back to active session
        const questionSessionId = message.sessionId ?? activeSessionIdRef.current ?? ('' as UUID);
        const uiQuestion: UIQuestion = {
          id: q.id,
          sessionId: questionSessionId,
          type: questionType,
          prompt: q.text,
          options: q.options.length > 0 ? q.options.map((o) => o.label) : undefined,
          structuredOptions: structuredOptions.length > 0 ? structuredOptions : undefined,
          timestamp: new Date().toISOString(),
        };
        setQuestion(uiQuestion);

        // Mark session as having a pending question
        setSessions((prev) =>
          prev.map((s) => (s.id === questionSessionId ? { ...s, questionPending: true } : s)),
        );
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
          name: ds.name || ds.projectPath.split('/').pop() || 'Session',
          createdAt: ds.lastActivity,
          lastActiveAt: ds.lastActivity,
          status: mapSessionStatus(ds.status),
          connectionStatus: ds.canAttach ? ('connected' as const) : ('disconnected' as const),
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
          prev.map((s) => (s.id === message.sessionId ? { ...s, isLoadingTranscript: false } : s)),
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

  useEffect(() => {
    unlockedIdentityRef.current = unlockedIdentity;
  }, [unlockedIdentity]);

  // Restore session ID from localStorage for reconnect after page reload (read once)
  const [storedSessionId] = useState<UUID | null>(
    () => localStorage.getItem(LOCALSTORAGE_SESSION_KEY) as UUID | null,
  );

  const signalingClientRef = useRef<import('@/lib/signaling-client').WebSignalingClient | null>(
    null,
  );
  const pendingRelayChallengeRef = useRef<{
    challenge: string;
    serverPublicKey: string;
    serverFingerprint: string;
  } | null>(null);
  const [connectionMode, setConnectionMode] = useState<'direct' | 'relay'>('direct');
  const [relayStatus, setRelayStatus] = useState<'disconnected' | 'connecting' | 'connected'>(
    'disconnected',
  );
  const [relayError, setRelayError] = useState<Error | null>(null);

  /** Set error (works for both direct and relay modes) */
  const setError = useCallback((err: Error) => {
    setRelayError(err);
  }, []);

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
    needsPassphrase,
    serverFingerprint,
    provideIdentity,
  } = useWebSocket({
    onMessage: handleMessage,
    initialResumeSessionId: storedSessionId ?? undefined,
    unlockedIdentity,
  });

  const error = (connectionMode === 'relay' ? relayError?.message : wsError?.message) ?? null;

  // Effective connection status: use relay status when in relay mode
  const effectiveStatus = connectionMode === 'relay' ? relayStatus : connectionStatus;

  // Relay-aware send: dispatches through signaling client when in relay mode
  const relaySend = useCallback(
    (message: ProtocolMessage): boolean => {
      if (connectionMode === 'relay') {
        if (signalingClientRef.current?.isConnected) {
          signalingClientRef.current.sendMessage(message);
          return true;
        }
        console.warn(`Relay send dropped (not connected): ${message.type}`);
        return false;
      }
      return false;
    },
    [connectionMode],
  );

  // Relay-aware wrappers for send functions
  const effectiveSendInput = useCallback(
    (sessionId: UUID, content: string): boolean => {
      if (connectionMode === 'relay') return relaySend(createUserInput(sessionId, content));
      return sendInput(sessionId, content);
    },
    [connectionMode, relaySend, sendInput],
  );

  const effectiveSendAnswer = useCallback(
    (questionId: UUID, answer: string): boolean => {
      if (connectionMode === 'relay') {
        return relaySend({
          type: 'answer',
          id: generateId(),
          timestamp: now(),
          questionId,
          answer,
        });
      }
      return sendAnswer(questionId, answer);
    },
    [connectionMode, relaySend, sendAnswer],
  );

  const effectiveRequestBulletExpand = useCallback(
    (sessionId: UUID, bulletId: number): boolean => {
      if (connectionMode === 'relay')
        return relaySend(createBulletExpandRequest(sessionId, bulletId));
      return requestBulletExpand(sessionId, bulletId);
    },
    [connectionMode, relaySend, requestBulletExpand],
  );

  const effectiveRequestSessionList = useCallback(
    (includeExternal?: boolean): boolean => {
      if (connectionMode === 'relay') return relaySend(createSessionListRequest(includeExternal));
      return requestSessionList(includeExternal);
    },
    [connectionMode, relaySend, requestSessionList],
  );

  const effectiveRequestTranscriptLoad = useCallback(
    (sessionId: string): boolean => {
      if (connectionMode === 'relay') return relaySend(createTranscriptLoadRequest(sessionId));
      return requestTranscriptLoad(sessionId);
    },
    [connectionMode, relaySend, requestTranscriptLoad],
  );

  const effectiveRequestNewSession = useCallback(
    (directory?: string): boolean => {
      if (connectionMode === 'relay') return relaySend(createCreateSessionRequest(directory));
      return requestNewSession(directory);
    },
    [connectionMode, relaySend, requestNewSession],
  );

  // Close modal and store URL on successful connect
  useEffect(() => {
    if (connectionStatus === 'connected') {
      setShowConnectModal(false);
    }
  }, [connectionStatus]);

  // Update session connectionStatus on disconnect/reconnecting
  // Clear stale question on disconnect
  useEffect(() => {
    if (effectiveStatus === 'disconnected' || effectiveStatus === 'reconnecting') {
      setSessions((prev) =>
        prev.map((s) =>
          s.connectionStatus === 'connected'
            ? { ...s, connectionStatus: 'disconnected' as const, questionPending: false }
            : s,
        ),
      );
      setQuestion(null);
    } else if (effectiveStatus === 'connected') {
      // Restore connected status for active session
      if (activeSessionId) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSessionId ? { ...s, connectionStatus: 'connected' as const } : s,
          ),
        );
      }
    }
  }, [effectiveStatus, activeSessionId]);

  // Request session list after direct connection
  useEffect(() => {
    if (connectionStatus === 'connected') {
      effectiveRequestSessionList(true);
    }
  }, [connectionStatus, effectiveRequestSessionList]);

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
  const handleSelectSession = useCallback(
    (id: UUID) => {
      setActiveSessionId(id);
      localStorage.setItem(LOCALSTORAGE_SESSION_KEY, id);

      // Reset unread count for the selected session
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unreadCount: 0 } : s)));

      // If this is an external transcript session we haven't loaded yet, request its history
      const session = sessions.find((s) => s.id === id);
      if (session?.source === 'transcript' && !loadedTranscriptsRef.current.has(id)) {
        loadedTranscriptsRef.current.add(id);
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, isLoadingTranscript: true } : s)),
        );
        effectiveRequestTranscriptLoad(id);
      }
    },
    [sessions, effectiveRequestTranscriptLoad],
  );

  const handleBack = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      if (!activeSessionId) return;

      // If there's an active question, send as answer
      if (sessionQuestion) {
        effectiveSendAnswer(sessionQuestion.id, content);
        // Mark question as answered (card shows collapsed state briefly)
        setQuestion({ ...sessionQuestion, answeredWith: content });
        setTimeout(() => setQuestion(null), 1500);
        // Clear question-pending on the session
        setSessions((prev) =>
          prev.map((s) => (s.id === activeSessionId ? { ...s, questionPending: false } : s)),
        );
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

  const handlePassphraseSubmit = useCallback(
    async (passphrase: string) => {
      try {
        const identity = await unlockStoredIdentity(passphrase);
        setUnlockedIdentity(identity);
        provideIdentity(identity);
      } catch (err) {
        console.error('Failed to unlock identity:', err);
        throw err;
      }
    },
    [provideIdentity],
  );

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
    import('@/lib/signaling-client')
      .then(({ WebSignalingClient }) => {
        // Close existing signaling connection if any
        if (signalingClientRef.current) {
          signalingClientRef.current.close();
        }

        setConnectionMode('relay');
        setRelayStatus('connecting');
        setRelayError(null);
        pendingRelayChallengeRef.current = null;

        const signalingUrl = 'wss://remi-signaling.dev-941.workers.dev/connect';
        const client = new WebSignalingClient({
          onStateChange: (state) => {
            if (state === 'connected') {
              setRelayStatus('connected');
              setShowConnectModal(false);
              // Send hello via relay with resumeSessionId if reconnecting
              // (harmless if auth is required; daemon drops it and sends
              // auth_challenge first, then hello_ack after auth completes)
              const resumeId = activeSessionIdRef.current ?? undefined;
              client.sendMessage(createHello(generateId(), '0.1.0', undefined, resumeId));
            } else if (state === 'connecting' || state === 'joined') {
              setRelayStatus('connecting');
            } else if (state === 'disconnected' || state === 'error') {
              setRelayStatus('disconnected');
            }
          },
          onMessage: (message) => {
            if (!message || typeof message !== 'object' || !('type' in message)) return;
            const msg = message as ProtocolMessage;

            // Handle auth_challenge: TOFU check, sign, and respond
            if (msg.type === 'auth_challenge') {
              const identity = unlockedIdentityRef.current;
              if (!identity) {
                setError(
                  new Error(
                    'This daemon requires authentication. Unlock your identity first (Settings > Identity).',
                  ),
                );
                setRelayStatus('disconnected');
                client.close();
                return;
              }

              // TOFU: check known hosts for relay server
              const relayUrl = `relay:${msg.serverFingerprint}`;
              const tofuResult = checkKnownHost(relayUrl, msg.serverFingerprint);
              if (tofuResult === 'mismatch') {
                setError(
                  new Error(
                    'Server fingerprint changed. This could indicate a MITM attack. Connection rejected.',
                  ),
                );
                setRelayStatus('disconnected');
                client.close();
                return;
              }

              // Store challenge data for mutual auth verification in auth_result
              pendingRelayChallengeRef.current = {
                challenge: msg.challenge,
                serverPublicKey: msg.serverPublicKey,
                serverFingerprint: msg.serverFingerprint,
              };

              (async () => {
                try {
                  const challengeData = fromBase64(msg.challenge);
                  const signature = await sign(identity.privateKey, challengeData);
                  client.sendMessage(
                    createAuthResponse(identity.publicKeyRaw, signature, identity.fingerprint),
                  );
                } catch (err) {
                  const detail = err instanceof Error ? err.message : String(err);
                  setError(new Error(`Relay authentication failed: ${detail}`));
                  setRelayStatus('disconnected');
                  client.close();
                }
              })();
              return;
            }

            // Handle auth_result: verify mutual auth, TOFU trust, then send hello
            if (msg.type === 'auth_result') {
              if (!msg.success) {
                setError(new Error(`Relay auth rejected: ${msg.error ?? 'unknown'}`));
                setRelayStatus('disconnected');
                client.close();
                return;
              }

              const pending = pendingRelayChallengeRef.current;
              if (!msg.serverSignature || !pending) {
                setError(new Error('Server did not provide mutual authentication signature'));
                setRelayStatus('disconnected');
                client.close();
                return;
              }

              // Verify server signature for mutual auth
              (async () => {
                try {
                  const serverPubKey = await importPublicKey(fromBase64(pending.serverPublicKey));
                  const challengeData = fromBase64(pending.challenge);
                  const valid = await verify(serverPubKey, challengeData, msg.serverSignature!);
                  if (!valid) {
                    setError(new Error('Server signature verification failed'));
                    setRelayStatus('disconnected');
                    client.close();
                    return;
                  }

                  // TOFU: trust server on first use
                  const relayUrl = `relay:${pending.serverFingerprint}`;
                  trustHost(relayUrl, pending.serverFingerprint, pending.serverPublicKey);
                  pendingRelayChallengeRef.current = null;

                  // Auth succeeded; now send hello so the daemon creates our session
                  const resumeId = activeSessionIdRef.current ?? undefined;
                  client.sendMessage(createHello(generateId(), '0.1.0', undefined, resumeId));
                } catch (err) {
                  const detail = err instanceof Error ? err.message : String(err);
                  setError(new Error(`Server verification failed: ${detail}`));
                  setRelayStatus('disconnected');
                  client.close();
                }
              })();
              return;
            }

            // Forward all other messages to the existing handler
            handleMessageRef.current?.(msg);
          },
          onError: (errCode, errMsg) => {
            console.error(`Signaling error [${errCode}]: ${errMsg}`);
            setError(new Error(`Connection failed: ${errMsg}`));
          },
        });

        signalingClientRef.current = client;
        client.connect(signalingUrl, code);
      })
      .catch((err) => {
        console.error('Failed to load signaling client:', err);
        setRelayStatus('disconnected');
        setConnectionMode('direct');
      });
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
    const text = sessionMessages.map((m) => `[${m.sender}] ${m.content}`).join('\n\n');
    navigator.clipboard.writeText(text).catch((err) => {
      console.warn('Failed to copy to clipboard:', err);
    });
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

  // Compute total unread across non-active sessions
  const totalUnread = sessions.reduce(
    (sum, s) => sum + (s.id === activeSessionId ? 0 : s.unreadCount),
    0,
  );

  const handleOpenSessions = useCallback(() => {
    setShowSessionSwitcher(true);
  }, []);

  const handleCloseSessionSwitcher = useCallback(() => {
    setShowSessionSwitcher(false);
  }, []);

  // Main content
  const main = activeSession ? (
    <ChatView
      session={activeSession}
      messages={sessionMessages}
      question={sessionQuestion}
      error={error}
      onSend={handleSend}
      onBack={handleBack}
      onOpenSessions={handleOpenSessions}
      sessionCount={sessions.length}
      totalUnread={totalUnread}
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

      <SessionSwitcher
        sessions={sessions}
        activeSessionId={activeSessionId}
        isOpen={showSessionSwitcher}
        onSelectSession={handleSelectSession}
        onClose={handleCloseSessionSwitcher}
      />

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
