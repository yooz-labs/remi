/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component wired to real daemon data.
 */

import { ChatView } from '@/components/chat';
import { AppLayout } from '@/components/layout';
import { ConnectModal, SessionList } from '@/components/session';
import { SettingsPanel } from '@/components/settings';
import { parseConnectionId, useConnectionManager } from '@/hooks';
import { hasIdentity, unlockStoredIdentity } from '@/lib/identity-client';
import { deduplicateMessage } from '@/lib/message-dedup';
import { cleanPreviewText, stripProtocolTags } from '@/lib/message-filter';
import { setSoundEnabled, setSuppressForegroundPush } from '@/lib/notifications';
import type {
  AppSettings,
  ConnectionId,
  UIBullet,
  UIMessage,
  UIQuestion,
  UIQuestionOption,
  UISession,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { UnlockedIdentity } from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import {
  createAnswer,
  createDetachSession,
  createRegisterDeviceToken,
  generateId,
} from '@remi/shared/protocol.ts';
import type { Bullet, DiscoverableSession, UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const LOCALSTORAGE_CONNECTIONS_KEY = 'remi-connections';
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

/** Update a session's last-active time and bump unread if not active.
 *  Does NOT clear questionPending - that's only cleared when the question is answered. */
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
          unreadCount: s.id === activeId ? s.unreadCount : s.unreadCount + 1,
          preview: preview?.slice(0, 80) || s.preview,
        }
      : s,
  );
}

/** Append " (2)", " (3)", etc. to sessions that share the same display name.
 *  The input array should already be sorted in priority order; the first session
 *  with a given name keeps the bare name, subsequent ones are numbered. */
function disambiguateSessions(sessions: UISession[]): UISession[] {
  const counts = new Map<string, number>();
  return sessions.map((s) => {
    const base = s.name;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return n === 1 ? s : { ...s, name: `${base} (${n})` };
  });
}

function App() {
  const [sessions, setSessions] = useState<UISession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<UUID | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [questions, setQuestions] = useState<Map<UUID, UIQuestion>>(new Map());
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [resumingSession, setResumingSession] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [unlockedIdentity, setUnlockedIdentity] = useState<UnlockedIdentity | null>(null);

  const activeSessionIdRef = useRef<UUID | null>(null);
  const resumingSessionRef = useRef<string | null>(null);
  const loadedTranscriptsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  const getSessionIdRef = useRef<((connId: ConnectionId) => string | null) | null>(null);
  const sessionsRef = useRef<UISession[]>([]);
  const lastQuestionIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef(false);
  const requestSessionListRef = useRef<typeof requestSessionList | null>(null);
  const connectionsRef = useRef<readonly { connectionId: ConnectionId; status: string }[]>([]);

  useEffect(() => {
    applyTheme(settings.theme);

    const fontSizeMap = { small: '14px', medium: '16px', large: '18px' } as const;
    document.documentElement.style.setProperty(
      '--font-size-base',
      fontSizeMap[settings.fontSize] ?? '16px',
    );

    setSoundEnabled(settings.sound);

    localStorage.setItem(LOCALSTORAGE_SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const handleSettingsChange = useCallback((newSettings: AppSettings) => {
    setSettings(newSettings);
  }, []);

  // Multi-daemon message handler. Empty deps intentional: state via functional updaters and refs.
  const handleMessage = useCallback((connectionId: ConnectionId, message: ProtocolMessage) => {
    switch (message.type) {
      case 'hello_ack': {
        // The attached session from this daemon. Additional sessions may arrive via session_list_response.
        if (!message.sessionId) {
          console.warn('[App] Received hello_ack without sessionId from connection:', connectionId);
          break;
        }
        setSessions((prev) => {
          // On reconnect, remove stale sessions from this connection that have a different
          // session ID (the daemon may have assigned a new session). Keep sessions from
          // other connections and sessions matching the new ID untouched.
          const cleaned = prev.filter(
            (s) => s.connectionId !== connectionId || s.id === message.sessionId,
          );

          const exists = cleaned.some((s) => s.id === message.sessionId);
          if (exists) {
            return cleaned.map((s) =>
              s.id === message.sessionId
                ? { ...s, connectionStatus: 'connected', connectionId }
                : s,
            );
          }
          if (message.isResume) return cleaned;
          return [
            ...cleaned,
            {
              id: message.sessionId,
              name: 'Claude Code Session',
              createdAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              status: 'idle',
              connectionStatus: 'connected',
              connectionId,
              unreadCount: 0,
              preview: 'Connected',
            } satisfies UISession,
          ];
        });
        localStorage.setItem(LOCALSTORAGE_SESSION_KEY, message.sessionId);
        break;
      }

      case 'transcript_content': {
        const { sessionId, entryUuid, role, content, isUpdate } = message;
        const structuredMsg = message.message;

        // Skip empty messages and strip protocol tags from user messages
        const rawContent = structuredMsg.content || content;
        if (!rawContent || !rawContent.trim()) break;
        if (!isUpdate && role === 'user') {
          const stripped = stripProtocolTags(rawContent);
          if (!stripped) break;
        }

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
                      content:
                        role === 'user'
                          ? stripProtocolTags(structuredMsg.content)
                          : structuredMsg.content,
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
          const rawContent = structuredMsg.content || content;
          // Strip protocol/XML tags from user messages (e.g. <local-command-stdout>)
          const resolvedContent = newSender === 'user' ? stripProtocolTags(rawContent) : rawContent;

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
            connectionId,
            sender: newSender,
            content: resolvedContent,
            timestamp: structuredMsg.createdAt || message.timestamp,
            state: newSender === 'user' ? 'read' : 'delivered',
            isEditing: structuredMsg.isEditing,
            tool: structuredMsg.tool,
            entryUuid,
            source: 'transcript',
            bullets: uiBullets.length > 0 ? uiBullets : undefined,
            firstBulletId: structuredMsg.firstBulletId,
            lastBulletId: structuredMsg.lastBulletId,
            contentBlocks: message.contentBlocks,
          };

          if (dedup.action === 'replace') {
            // Replace the optimistic/PTY duplicate with the transcript version,
            // preserving the original id as React key to prevent remount flicker
            const replaced = dedup.preserveId ? { ...uiMessage, id: dedup.preserveId } : uiMessage;
            return prev.map((m, i) => (i === dedup.replaceIndex ? replaced : m));
          }

          return [...prev, uiMessage];
        });

        setSessions((prev) =>
          updateSessionActivity(prev, sessionId, activeSessionIdRef.current, structuredMsg.content),
        );
        break;
      }

      case 'structured_agent_output': {
        // PTY stream: use ONLY for status updates, NOT for message content.
        // All chat messages come from transcript_content (clean JSONL data).
        const structuredMsg = message.message;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === structuredMsg.sessionId ? { ...s, lastActiveAt: new Date().toISOString() } : s,
          ),
        );
        break;
      }

      case 'session_update': {
        const sessionData = message.session;
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionData.id ? { ...s, status: sessionData.status } : s)),
        );
        // If status moved from 'waiting' to something else, the question was answered elsewhere
        if (sessionData.status !== 'waiting') {
          setQuestions((prev) => {
            if (!prev.has(sessionData.id)) return prev;
            const next = new Map(prev);
            next.delete(sessionData.id);
            return next;
          });
        }
        break;
      }

      case 'question': {
        const q = message.question;
        // Dedup: skip if we already have this question (can arrive from multiple connections or hook+PTY)
        if (q.id === lastQuestionIdRef.current) {
          break;
        }
        lastQuestionIdRef.current = q.id;
        // Map daemon Question to UIQuestion.
        // Use yes_no ONLY for exactly 2 options with clear yes+no.
        // Use multi_option for 3+ options (even if they include yes/no).
        // Use numbered for options without yes/no semantics.
        let questionType: UIQuestion['type'] = 'free_text';
        if (q.options.length > 0) {
          if (q.options.length === 2) {
            const hasYes = q.options.some((o) => o.isYes);
            const hasNo = q.options.some((o) => o.isNo);
            questionType = hasYes && hasNo ? 'yes_no' : 'multi_option';
          } else {
            // 3+ options: always show all of them
            const hasYesNo = q.options.some((o) => o.isYes || o.isNo);
            questionType = hasYesNo ? 'multi_option' : 'numbered';
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
        setQuestions((prev) => {
          const next = new Map(prev);
          next.set(questionSessionId, uiQuestion);
          return next;
        });

        // Mark session as having a pending question
        setSessions((prev) =>
          prev.map((s) => (s.id === questionSessionId ? { ...s, questionPending: true } : s)),
        );

        // Push (APNS) is the notification channel — no local notification from WebSocket
        break;
      }

      case 'replay_batch': {
        // Replay batches arrive on connect/reconnect. Suppress notifications during replay
        // to prevent spamming the user with old events.
        isReplayingRef.current = true;
        for (const replayMsg of message.messages) {
          handleMessage(connectionId, replayMsg);
        }
        isReplayingRef.current = false;
        break;
      }

      case 'session_list_response': {
        // Look up the hello_ack session ID directly from the mutable connection state
        const helloAckSessionId = getSessionIdRef.current?.(connectionId) ?? null;
        // Map, filter, and sort DiscoverableSession[] to UISession[]
        const discovered: UISession[] = message.sessions
          .filter((ds: DiscoverableSession) => {
            // Always keep daemon-sourced sessions (our connection's sessions)
            if (ds.source === 'daemon') return true;
            // Filter out empty transcript sessions with no content
            if (!ds.canAttach && (!ds.messageCount || ds.messageCount === 0) && !ds.lastMessage) {
              return false;
            }
            return true;
          })
          .map((ds: DiscoverableSession) => {
            // Clean preview text (strip XML/protocol tags)
            const rawPreview = ds.lastMessage || '';
            const cleanedPreview = cleanPreviewText(rawPreview);
            // Only show resume for dead sessions (completed/orphaned), never for idle/active
            const isDead = ds.status !== 'active' && ds.status !== 'idle';
            const showResume = isDead && !ds.canAttach && ds.canResume;
            // Sessions from the directly connected daemon (source 'daemon') are
            // interactable. mDNS-discovered sessions (source 'transcript') are
            // read-only until we separately connect to their daemon.
            const isActiveSession = ds.sessionId === activeSessionIdRef.current;
            const isAttachedViaHelloAck = ds.sessionId === helloAckSessionId;
            const isDaemonSession = ds.source === 'daemon';
            const isInteractable = isActiveSession || isAttachedViaHelloAck || isDaemonSession;
            return {
              id: ds.sessionId as UUID,
              name: ds.name || ds.projectPath.split('/').pop() || 'Session',
              connectionId,
              createdAt: ds.lastActivity,
              lastActiveAt: ds.lastActivity,
              status: mapSessionStatus(ds.status),
              connectionStatus: isInteractable ? ('connected' as const) : ('disconnected' as const),
              unreadCount: 0,
              cwd: ds.projectPath,
              preview: cleanedPreview.slice(0, 100),
              source: ds.source,
              canResume: showResume,
            };
          })
          // Dedup: same session ID from daemon + transcript → keep daemon version.
          // Different session IDs in the same cwd are kept (parallel/sequential sessions).
          .reduce<UISession[]>((acc, s) => {
            const existingIdx = acc.findIndex((other) => other.id === s.id);
            if (existingIdx === -1) {
              acc.push(s);
              return acc;
            }
            const existing = acc[existingIdx];
            if (s.source === 'daemon' && existing.source !== 'daemon') {
              acc[existingIdx] = s;
            }
            return acc;
          }, [])
          // Sort: connected first, then by last activity (most recent first)
          .sort((a, b) => {
            const aLive = a.connectionStatus === 'connected' ? 0 : 1;
            const bLive = b.connectionStatus === 'connected' ? 0 : 1;
            if (aLive !== bLive) return aLive - bLive;
            return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
          });

        // Multi-daemon merge: keep sessions from other connections, preserve attached session
        // for this connection if not in discovered list, add all newly discovered sessions,
        // sort live-first then by recency.
        setSessions((prev) => {
          const otherConnSessions = prev.filter((s) => s.connectionId !== connectionId);
          // Keep the attached session for this connection (from hello_ack)
          const attachedSession = prev.find(
            (s) => s.connectionId === connectionId && s.connectionStatus === 'connected',
          );
          const discoveredIds = new Set(discovered.map((s) => s.id));
          // Start with sessions from other connections
          const result = [...otherConnSessions];
          // Add attached session if not already in discovered list
          if (attachedSession && !discoveredIds.has(attachedSession.id)) {
            result.push(attachedSession);
          }
          result.push(...discovered);
          // Ensure the hello_ack session is always marked connected
          if (helloAckSessionId) {
            for (let i = 0; i < result.length; i++) {
              if (
                result[i].id === helloAckSessionId &&
                result[i].connectionStatus !== 'connected'
              ) {
                result[i] = { ...result[i], connectionStatus: 'connected', source: 'daemon' };
              }
            }
          }
          // Cross-connection dedup: same session ID from multiple connections →
          // keep daemon-sourced version. Different IDs in same cwd → keep both.
          const deduped = result.reduce<UISession[]>((acc, s) => {
            const dupIdx = acc.findIndex((other) => other.id === s.id);
            if (dupIdx === -1) {
              acc.push(s);
              return acc;
            }
            const existing = acc[dupIdx];
            if (s.source === 'daemon' && existing.source !== 'daemon') {
              acc[dupIdx] = s;
            }
            return acc;
          }, []);
          // Sort: live first, then by last activity
          const sorted = deduped.sort((a, b) => {
            const aLive = a.connectionStatus === 'connected' ? 0 : 1;
            const bLive = b.connectionStatus === 'connected' ? 0 : 1;
            if (aLive !== bLive) return aLive - bLive;
            return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
          });
          return disambiguateSessions(sorted);
        });

        // Auto-connect to other daemon ports on the same machine.
        // Use setTimeout to run after this handler completes (avoids stale refs).
        if (message.daemonPorts && message.daemonPorts.length > 0) {
          const ports = [...message.daemonPorts];
          const host = connectionId.replace(/:\d+$/, '');
          setTimeout(() => {
            for (const port of ports) {
              const url = `ws://${host}:${port}/ws`;
              connectDirectRef.current(url);
            }
          }, 100);
        }
        break;
      }

      case 'session_history_response': {
        // Session history response received; not yet integrated into the UI
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
        if (message.success && message.sessionId) {
          // New session created; it will appear via hello_ack. Refresh session list.
          const reqList = requestSessionListRef.current;
          if (reqList) {
            const conns = connectionsRef.current.filter((c) => c.status === 'connected');
            for (const conn of conns) {
              reqList(conn.connectionId, conns.length === 1);
            }
          }
        } else {
          console.error(`Session creation failed: ${message.error}`);
          const errorMsg: UIMessage = {
            id: generateId(),
            sessionId: activeSessionIdRef.current ?? ('' as UUID),
            connectionId: '' as ConnectionId,
            sender: 'system',
            content: `Failed to create session: ${message.error || 'unknown error'}`,
            timestamp: new Date().toISOString(),
            state: 'delivered',
            isEditing: false,
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
        break;
      }

      case 'resume_session_response': {
        const targetSessionId = resumingSessionRef.current;
        setResumingSession(null);
        if (message.success && message.sessionId) {
          setActiveSessionId(message.sessionId);
        } else {
          console.error(`Failed to resume session: ${message.error}`);
          // Use the target session ID so the error appears in the right session's chat
          const errorSessionId = (targetSessionId ?? activeSessionIdRef.current ?? '') as UUID;
          const errorMsg: UIMessage = {
            id: generateId(),
            sessionId: errorSessionId,
            sender: 'system',
            content: `Failed to resume session: ${message.error ?? 'Unknown error'}`,
            timestamp: new Date().toISOString(),
            state: 'delivered',
            isEditing: false,
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
        break;
      }

      case 'detach_session_ack': {
        const detachedMsg: UIMessage = {
          id: generateId(),
          sessionId: message.sessionId,
          sender: 'system',
          content: message.success
            ? 'Session detached. Use "remi attach" or reconnect to resume.'
            : `Failed to detach session: ${message.error ?? 'unknown error'}`,
          timestamp: new Date().toISOString(),
          state: 'delivered',
          isEditing: false,
        };
        setMessages((prev) => [...prev, detachedMsg]);
        // On successful detach, clear active session so the UI reflects
        // the disconnected state. The WebSocket close will handle cleanup.
        if (message.success) {
          setActiveSessionId(null);
        }
        break;
      }

      case 'error': {
        const errorText = message.message ?? 'unknown';
        // Suppress auth errors (handled by the connection manager)
        if (errorText.includes('Authentication required') || errorText.includes('AUTH_REQUIRED')) {
          console.debug('[App] Auth error suppressed:', errorText);
          break;
        }
        // Clear loading state for any session awaiting transcript load, and allow retry.
        // The daemon does not echo sessionId in error responses, so we clear all loading sessions.
        setSessions((prev) =>
          prev.map((s) => {
            if (s.isLoadingTranscript) {
              loadedTranscriptsRef.current.delete(s.id);
              return { ...s, isLoadingTranscript: false };
            }
            return s;
          }),
        );
        // Show non-auth errors to the user as system messages
        const targetSession = activeSessionIdRef.current;
        if (!targetSession) {
          console.error('[App] Daemon error with no active session:', errorText);
          break;
        }
        const errorMsg: UIMessage = {
          id: message.id ?? generateId(),
          sessionId: targetSession,
          connectionId: connectionId,
          sender: 'system',
          content: errorText,
          timestamp: message.timestamp ?? new Date().toISOString(),
          state: 'delivered',
          isEditing: false,
        };
        setMessages((prev) => [...prev, errorMsg]);
        break;
      }

      default:
        console.debug(`[App] Unhandled message type: ${(message as { type: string }).type}`);
        break;
    }
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    resumingSessionRef.current = resumingSession;
  }, [resumingSession]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Connection manager: manages N simultaneous WebSocket connections
  const {
    connections,
    connectDirect,
    disconnect: disconnectConnection,
    disconnectAll,
    sendInput,
    sendAnswer,
    sendMessage: cmSendMessage,
    requestBulletExpand,
    requestSessionList,
    requestTranscriptLoad,
    requestResumeSession,
    requestNewSession,
    needsPassphrase,
    passphraseConnectionId,
    passphraseServerFingerprint,
    provideIdentity,
    getSessionId,
  } = useConnectionManager({
    onMessage: handleMessage,
    unlockedIdentity,
    clientId: 'remi-web',
    clientVersion: '0.0.1',
    autoReconnect: settings.autoReconnect,
  });

  // Keep refs in sync for use in handleMessage callbacks
  getSessionIdRef.current = getSessionId;
  sessionsRef.current = sessions;
  requestSessionListRef.current = requestSessionList;
  connectionsRef.current = connections;

  // Derived connection status
  const hasAnyConnected = connections.some((c) => c.status === 'connected');
  const isAnyConnecting = connections.some(
    (c) => c.status === 'connecting' || c.status === 'authenticating',
  );

  // Resolve connectionId for the active session
  const getActiveConnectionId = useCallback((): ConnectionId | undefined => {
    const session = sessions.find((s) => s.id === activeSessionId);
    return session?.connectionId;
  }, [sessions, activeSessionId]);

  // Close modal on successful connect
  useEffect(() => {
    if (hasAnyConnected) {
      setShowConnectModal(false);
    }
  }, [hasAnyConnected]);

  // Update session connectionStatus when connections change
  useEffect(() => {
    const connMap = new Map(connections.map((c) => [c.connectionId, c.status]));
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        const connStatus = connMap.get(s.connectionId);
        if (
          (connStatus === 'disconnected' || connStatus === 'error') &&
          s.connectionStatus !== 'disconnected'
        ) {
          changed = true;
          return { ...s, connectionStatus: 'disconnected' as const, questionPending: false };
        }
        if (connStatus === 'connected' && s.connectionStatus === 'disconnected') {
          changed = true;
          return { ...s, connectionStatus: 'connected' as const };
        }
        return s;
      });
      return changed ? next : prev;
    });
    // Clear stale questions if all connections are down
    if (!hasAnyConnected && !isAnyConnecting) {
      setQuestions(new Map());
      setResumingSession(null);
    }
  }, [connections, hasAnyConnected, isAnyConnecting]);

  // Request session list when a connection transitions to 'connected'
  const prevConnectedIdsRef = useRef<Set<ConnectionId>>(new Set());
  const connectedIds = useMemo(
    () => new Set(connections.filter((c) => c.status === 'connected').map((c) => c.connectionId)),
    [connections],
  );
  useEffect(() => {
    for (const id of connectedIds) {
      if (!prevConnectedIdsRef.current.has(id)) {
        // Always include external (transcript-discovered) sessions.
        // Cross-daemon duplicates are handled by the dedup logic in
        // the session_list_response handler.
        requestSessionList(id, true);
      }
    }
    prevConnectedIdsRef.current = connectedIds;
  }, [connectedIds, requestSessionList]);

  // Suppress foreground push-to-local notification banners when at least one
  // WebSocket connection is live (the question already shows in the chat UI).
  useEffect(() => {
    setSuppressForegroundPush(connectedIds.size > 0);
  }, [connectedIds]);

  // Auto-connect from localStorage on mount (run once)
  const connectDirectRef = useRef(connectDirect);
  useEffect(() => {
    connectDirectRef.current = connectDirect;
  }, [connectDirect]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCALSTORAGE_CONNECTIONS_KEY);
      if (stored) {
        const urls: string[] = JSON.parse(stored);
        for (const url of urls) {
          connectDirectRef.current(url);
        }
      }
    } catch (err) {
      console.warn('[App] Failed to restore connections from localStorage:', err);
    }
  }, []);

  // Refresh session lists when app resumes from background
  useEffect(() => {
    const handleResume = () => {
      for (const id of connectedIds) {
        requestSessionList(id, true);
      }
    };
    document.addEventListener('app-resume', handleResume);
    return () => document.removeEventListener('app-resume', handleResume);
  }, [connectedIds, requestSessionList]);

  // Navigate to session when user taps a push notification
  useEffect(() => {
    const handleNotificationTap = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (data?.sessionId) {
        setActiveSessionId(data.sessionId);
      }
    };
    document.addEventListener('push-notification-tap', handleNotificationTap);
    return () => document.removeEventListener('push-notification-tap', handleNotificationTap);
  }, []);

  // Stable refs for push-answer handler (avoids stale closures; connectDirectRef already declared above)
  const pushAnswerSendRef = useRef(cmSendMessage);
  useEffect(() => {
    pushAnswerSendRef.current = cmSendMessage;
  }, [cmSendMessage]);

  // Handle push notification action button taps (lock screen / Apple Watch)
  useEffect(() => {
    const handlePushAnswer = async (e: Event) => {
      const { sessionId, questionId, answer } = (
        e as CustomEvent<{ sessionId: string; questionId: string; answer: string }>
      ).detail;
      if (!sessionId || !questionId || !answer) return;

      // Find the session in our session list to get its connectionId
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const connectionId = session?.connectionId;

      // Check if the connection is already live
      const conn = connectionId
        ? connectionsRef.current.find((c) => c.connectionId === connectionId)
        : undefined;
      const isConnected = conn?.status === 'connected';

      if (isConnected && connectionId) {
        // Already connected — send immediately
        pushAnswerSendRef.current(
          connectionId,
          createAnswer(sessionId as UUID, questionId as UUID, answer),
        );
        return;
      }

      // Not connected; try to reconnect using the stored URL
      const connUrl = (conn as { url?: string } | undefined)?.url;
      if (!connUrl) {
        // No URL available — notify user that answer could not be delivered
        LocalNotifications.schedule({
          notifications: [
            {
              title: 'Answer not delivered',
              body: 'Open Remi to respond to the question.',
              id: (Date.now() % 2_000_000_000) + Math.floor(Math.random() * 1000),
              schedule: { at: new Date() },
            },
          ],
        }).catch(() => undefined);
        return;
      }

      // Attempt reconnect with 10s timeout
      const targetConnId = connectDirectRef.current(connUrl);
      const ANSWER_TIMEOUT_MS = 10_000;
      const deadline = Date.now() + ANSWER_TIMEOUT_MS;
      const delivered = await new Promise<boolean>((resolve) => {
        const check = setInterval(() => {
          const live = connectionsRef.current.find((c) => c.connectionId === targetConnId);
          if (live?.status === 'connected') {
            clearInterval(check);
            const sent = pushAnswerSendRef.current(
              targetConnId,
              createAnswer(sessionId as UUID, questionId as UUID, answer),
            );
            resolve(sent);
          } else if (Date.now() >= deadline) {
            clearInterval(check);
            resolve(false);
          }
        }, 250);
      });

      if (!delivered) {
        LocalNotifications.schedule({
          notifications: [
            {
              title: 'Answer not delivered',
              body: 'Open Remi to respond to the question.',
              id: (Date.now() % 2_000_000_000) + Math.floor(Math.random() * 1000),
              schedule: { at: new Date() },
            },
          ],
        }).catch(() => undefined);
      }
    };

    const listener = (e: Event) => {
      handlePushAnswer(e).catch((err) =>
        console.error('[App] push-notification-answer handler error:', err),
      );
    };
    document.addEventListener('push-notification-answer', listener);
    return () => document.removeEventListener('push-notification-answer', listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send device token to daemons: on new token or new connection
  const deviceTokenRef = useRef<string | null>(null);
  const tokenSentToRef = useRef<Set<ConnectionId>>(new Set());
  useEffect(() => {
    const handleToken = (e: Event) => {
      const token = (e as CustomEvent<string>).detail;
      if (!token) return;
      deviceTokenRef.current = token;
      for (const id of connectedIds) {
        cmSendMessage(id, createRegisterDeviceToken(token, 'ios'));
        tokenSentToRef.current.add(id);
      }
    };
    document.addEventListener('device-token', handleToken);
    return () => document.removeEventListener('device-token', handleToken);
  }, [connectedIds, cmSendMessage]);

  // Send cached device token to newly connected daemons
  useEffect(() => {
    if (!deviceTokenRef.current) return;
    for (const id of connectedIds) {
      if (!tokenSentToRef.current.has(id)) {
        cmSendMessage(id, createRegisterDeviceToken(deviceTokenRef.current, 'ios'));
        tokenSentToRef.current.add(id);
      }
    }
    // Clean up disconnected entries
    for (const id of tokenSentToRef.current) {
      if (!connectedIds.has(id)) {
        tokenSentToRef.current.delete(id);
      }
    }
  }, [connectedIds, cmSendMessage]);

  // Get active session. Derive connectionStatus from live connection state
  // at render time to avoid stale status from session_list_response merge timing.
  const rawActiveSession = sessions.find((s) => s.id === activeSessionId);
  const activeSession = rawActiveSession
    ? (() => {
        const conn = connections.find((c) => c.connectionId === rawActiveSession.connectionId);
        const connIsLive = conn?.status === 'connected';
        if (connIsLive && rawActiveSession.connectionStatus !== 'connected') {
          return { ...rawActiveSession, connectionStatus: 'connected' as const };
        }
        return rawActiveSession;
      })()
    : undefined;
  const sessionMessages = messages.filter((m) => m.sessionId === activeSessionId);
  const sessionQuestion = activeSessionId ? (questions.get(activeSessionId) ?? null) : null;

  const handleSelectSession = useCallback(
    (id: UUID) => {
      setActiveSessionId(id);
      localStorage.setItem(LOCALSTORAGE_SESSION_KEY, id);

      // Reset unread count for the selected session
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unreadCount: 0 } : s)));

      // Request transcript history if we haven't already and there are no messages yet.
      // This covers both external transcript sessions and daemon sessions (which use a
      // Remi UUID as their ID — the daemon resolves it via its active watcher).
      const session = sessions.find((s) => s.id === id);
      const hasMessages = messagesRef.current.some((m) => m.sessionId === id);
      if (session && !hasMessages && !loadedTranscriptsRef.current.has(id)) {
        loadedTranscriptsRef.current.add(id);
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, isLoadingTranscript: true } : s)),
        );
        requestTranscriptLoad(session.connectionId, id);
      }
    },
    [sessions, requestTranscriptLoad],
  );

  const handleBack = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      if (!activeSessionId) return;
      const connId = getActiveConnectionId();
      if (!connId) {
        const systemMsg: UIMessage = {
          id: generateId(),
          sessionId: activeSessionId,
          sender: 'system',
          content: 'Cannot send: not connected to daemon',
          timestamp: new Date().toISOString(),
          state: 'delivered',
          isEditing: false,
        };
        setMessages((prev) => [...prev, systemMsg]);
        return;
      }

      // If there's an active question, send as answer
      if (sessionQuestion) {
        const sent = sendAnswer(connId, activeSessionId, sessionQuestion.id, content);
        if (!sent) {
          const failMsg: UIMessage = {
            id: generateId(),
            sessionId: activeSessionId,
            connectionId: connId,
            sender: 'system',
            content: 'Failed to send answer: connection unavailable. Try again.',
            timestamp: new Date().toISOString(),
            state: 'delivered',
            isEditing: false,
          };
          setMessages((prev) => [...prev, failMsg]);
          return;
        }
        // Mark question as answered (card shows collapsed state briefly)
        setQuestions((prev) => {
          const next = new Map(prev);
          next.set(activeSessionId, { ...sessionQuestion, answeredWith: content });
          return next;
        });
        setTimeout(() => {
          setQuestions((prev) => {
            if (!prev.has(activeSessionId)) return prev;
            const next = new Map(prev);
            next.delete(activeSessionId);
            return next;
          });
        }, 1500);
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
          source: 'optimistic',
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
        source: 'optimistic',
      };

      setMessages((prev) => [...prev, newMessage]);

      const success = sendInput(connId, activeSessionId, content);
      if (success) {
        setMessages((prev) =>
          prev.map((m) => (m.id === newMessage.id ? { ...m, state: 'sent' } : m)),
        );
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === newMessage.id ? { ...m, state: 'delivered' as const } : m)),
        );
        const errorMsg: UIMessage = {
          id: generateId(),
          sessionId: activeSessionId,
          sender: 'system',
          content: 'Failed to send message: connection unavailable',
          timestamp: new Date().toISOString(),
          state: 'delivered',
          isEditing: false,
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    },
    [activeSessionId, getActiveConnectionId, sendInput, sendAnswer, sessionQuestion],
  );

  const handlePassphraseSubmit = useCallback(
    async (passphrase: string) => {
      try {
        const identity = await unlockStoredIdentity(passphrase);
        setUnlockedIdentity(identity);
        if (passphraseConnectionId) {
          provideIdentity(passphraseConnectionId, identity);
        }
      } catch (err) {
        console.error('Failed to unlock identity:', err);
        throw err;
      }
    },
    [provideIdentity, passphraseConnectionId],
  );

  const handleConnectDirect = useCallback(
    (url: string, directory?: string) => {
      connectDirect(url, directory);
      // Persist connected URLs
      try {
        const stored = localStorage.getItem(LOCALSTORAGE_CONNECTIONS_KEY);
        const urls: string[] = stored ? JSON.parse(stored) : [];
        if (!urls.includes(url)) {
          urls.push(url);
        }
        localStorage.setItem(LOCALSTORAGE_CONNECTIONS_KEY, JSON.stringify(urls));
      } catch (err) {
        console.warn('[App] Failed to persist connection URL:', err);
      }
    },
    [connectDirect],
  );

  // Disconnect a connection and remove from persisted localStorage
  const handleDisconnect = useCallback(
    (connectionId: ConnectionId) => {
      disconnectConnection(connectionId);
      try {
        const stored = localStorage.getItem(LOCALSTORAGE_CONNECTIONS_KEY);
        const urls: string[] = stored ? JSON.parse(stored) : [];
        const filtered = urls.filter((u) => parseConnectionId(u) !== connectionId);
        localStorage.setItem(LOCALSTORAGE_CONNECTIONS_KEY, JSON.stringify(filtered));
      } catch (err) {
        console.warn('[App] Failed to update persisted connections:', err);
      }
    },
    [disconnectConnection],
  );

  // Disconnect ALL connections and clear everything (back to connect screen)
  const handleDisconnectAll = useCallback(() => {
    disconnectAll();
    setSessions([]);
    setMessages([]);
    setActiveSessionId(null);
    setQuestions(new Map());
    try {
      localStorage.removeItem(LOCALSTORAGE_CONNECTIONS_KEY);
    } catch (err) {
      console.warn('[App] Failed to clear persisted connections:', err);
    }
  }, [disconnectAll]);

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

      const connId = getActiveConnectionId();
      if (connId) {
        requestBulletExpand(connId, activeSessionId, bulletId);
      } else {
        // Revert expanding state since we can't reach the daemon
        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.bullets) return msg;
            const updatedBullets = msg.bullets.map((b) =>
              b.bulletId === bulletId ? { ...b, isExpanding: false } : b,
            );
            return { ...msg, bullets: updatedBullets };
          }),
        );
      }
    },
    [activeSessionId, getActiveConnectionId, requestBulletExpand],
  );

  const handleResumeSession = useCallback(
    (sessionId: string) => {
      if (resumingSession) return;
      // Find the connection that owns this session
      const session = sessions.find((s) => s.id === sessionId);
      const connId = session?.connectionId;
      if (!connId) {
        console.warn('[App] Cannot resume session: no connection for session', sessionId);
        return;
      }
      setResumingSession(sessionId);
      const sent = requestResumeSession(connId, sessionId);
      if (!sent) {
        setResumingSession(null);
      }
    },
    [sessions, requestResumeSession, resumingSession],
  );

  // Create new session on the first connected daemon
  const handleNewSession = useCallback(
    (directory?: string) => {
      const conn = connections.find((c) => c.status === 'connected');
      if (!conn) return;
      requestNewSession(conn.connectionId, directory);
    },
    [connections, requestNewSession],
  );

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

  const handleDetach = useCallback(() => {
    if (!activeSessionId) return;
    const connId = getActiveConnectionId();
    const sent = connId ? cmSendMessage(connId, createDetachSession(activeSessionId)) : false;
    if (!sent) {
      const errorMsg: UIMessage = {
        id: generateId(),
        sessionId: activeSessionId,
        sender: 'system',
        content: 'Cannot detach: not connected to daemon.',
        timestamp: new Date().toISOString(),
        state: 'delivered',
        isEditing: false,
      };
      setMessages((prev) => [...prev, errorMsg]);
    }
  }, [activeSessionId, getActiveConnectionId, cmSendMessage]);

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

  // Derive error from the most recently errored connection (if any)
  const errorConnection = connections.find((c) => c.status === 'error');
  const error: string | null = errorConnection
    ? (errorConnection.error ?? `Connection error: ${errorConnection.connectionId}`)
    : null;

  // Compute effective status for ConnectModal: show the latest connection's status
  const effectiveStatus = (() => {
    if (hasAnyConnected) return 'connected' as const;
    if (isAnyConnecting) return 'connecting' as const;
    if (connections.some((c) => c.status === 'reconnecting')) return 'reconnecting' as const;
    if (connections.some((c) => c.status === 'error')) return 'error' as const;
    return 'disconnected' as const;
  })();

  // Sidebar content
  const sidebar = (
    <SessionList
      sessions={sessions}
      activeSessionId={activeSessionId}
      connections={connections}
      onSelectSession={handleSelectSession}
      onResumeSession={hasAnyConnected ? handleResumeSession : undefined}
      resumingSessionId={resumingSession}
      onConnect={() => setShowConnectModal(true)}
      onAddConnection={() => setShowConnectModal(true)}
      onDisconnect={handleDisconnect}
      onDisconnectAll={handleDisconnectAll}
      onNewSession={handleNewSession}
      onSettings={() => setShowSettings(true)}
    />
  );

  // Compute total unread across non-active sessions
  const totalUnread = sessions.reduce(
    (sum, s) => sum + (s.id === activeSessionId ? 0 : s.unreadCount),
    0,
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
      totalUnread={totalUnread}
      onCopyConversation={handleCopyConversation}
      onClearMessages={handleClearMessages}
      onExportText={handleExportText}
      onBulletExpand={handleBulletExpand}
      onDetach={handleDetach}
      showTimestamps={settings.showTimestamps}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-[var(--color-text-muted)]">
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
        connectionStatus={effectiveStatus}
        error={error}
        needsPassphrase={needsPassphrase}
        hasIdentity={hasIdentity()}
        serverFingerprint={passphraseServerFingerprint}
        onPassphraseSubmit={handlePassphraseSubmit}
      />
    </>
  );
}

export default App;
