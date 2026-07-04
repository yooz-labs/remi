/**
 * Remi App - Claude Code Session Monitor
 *
 * Main application component wired to real daemon data.
 */

import { ChatView } from '@/components/chat';
import { AppLayout } from '@/components/layout';
import { ConnectModal, NewSessionModal, SessionList } from '@/components/session';
import { SettingsPanel } from '@/components/settings';
import { parseConnectionId, useConnectionManager } from '@/hooks';
import { probeAuthInfo } from '@/lib/auth-probe';
import { deriveConnectionBannerError } from '@/lib/connection-banner';
import { dedupeConnectionUrls } from '@/lib/connection-id';
import { hasIdentity, isIdentityEncrypted, unlockStoredIdentity } from '@/lib/identity-client';
import {
  acknowledgeSend,
  EMPTY_PENDING_SENDS,
  type PendingSendMap,
  sweepTimeouts,
  trackSend,
} from '@/lib/message-ack-tracker';
import { deduplicateMessage } from '@/lib/message-dedup';
import { cleanPreviewText, stripProtocolTags } from '@/lib/message-filter';
import { clearNativeRoute, setNativeRoute, syncNativeIdentity } from '@/lib/native-bridge';
import { setSoundEnabled } from '@/lib/notifications';
import { relayAnswerDirect } from '@/lib/push-answer-relay';
import { resolvePushAnswerTarget } from '@/lib/push-answer-resolver';
import {
  RESOLVED_TRACE_LINGER_MS,
  clearMainQuestionOnStatus,
  clearSessionQuestions,
  getSessionQuestions,
  isQuestionPending,
  questionKey,
  removeQuestionById,
  removeQuestionByKeyIfId,
  resolveQuestionCard,
} from '@/lib/question-collection';
import { dismissDeliveredNotification } from '@/lib/notifications';
import { shouldKeepExisting } from '@/lib/question-merge';
import { bindingRotated } from '@/lib/session-binding';
import { shouldEvictCachedSession } from '@/lib/session-eviction';
import { autoSelectIfNone, evictIfActive, evictManyIfActive } from '@/lib/session-selection';
import { dedupSessions } from '@/lib/session-dedup';
import { type ReplyContext, formatReplyMessage } from '@/lib/reply-format';
import type {
  AppSettings,
  ConnectionId,
  ConnectionState,
  UIBullet,
  UIMessage,
  UIQuestion,
  UIQuestionOption,
  UISession,
} from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { UnlockedIdentity } from '@remi/shared';
import type { ProtocolMessage, RecentDirectory } from '@remi/shared/protocol.ts';
import {
  createAnswer,
  createDetachSession,
  createKillSessionRequest,
  createRegisterDeviceToken,
  generateId,
} from '@remi/shared/protocol.ts';
import type { Bullet, DiscoverableSession, UUID } from '@remi/shared/types.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const LOCALSTORAGE_CONNECTIONS_KEY = 'remi-connections';
const LOCALSTORAGE_SESSION_KEY = 'remi-last-session';
const LOCALSTORAGE_SETTINGS_KEY = 'remi-settings';
// Maps sessionId -> daemon URL last seen serving that session. Read on
// cold-start push answers so multi-daemon users do not silently answer the
// wrong daemon. Issue #389 review.
const LOCALSTORAGE_SESSION_DAEMONS_KEY = 'remi-session-daemons';

/**
 * Narrow an unknown JSON value to a non-empty string. Used at the
 * boundary between wire data (Record<string, unknown>) and typed UI
 * state so a daemon that ever sends a malformed STALE_BINDING payload
 * cannot corrupt the cached binding.
 */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function rememberSessionDaemon(sessionId: string, url: string): void {
  try {
    const stored = localStorage.getItem(LOCALSTORAGE_SESSION_DAEMONS_KEY);
    const map = stored ? (JSON.parse(stored) as Record<string, string>) : {};
    if (map[sessionId] === url) return;
    map[sessionId] = url;
    localStorage.setItem(LOCALSTORAGE_SESSION_DAEMONS_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn('[App] Failed to persist session-daemon map:', err);
  }
}

/**
 * Forget evicted phantom sessions in localStorage so they don't resurface on a
 * cold start (#577). Drops them from the session->daemon map and clears
 * remi-last-session if it points at one. Best-effort; storage errors are logged,
 * never thrown, so a quota/parse hiccup can't break the message handler.
 */
function forgetEvictedSessions(evictedIds: readonly string[]): void {
  if (evictedIds.length === 0) return;
  // Mirror eviction into native storage (#591 P2) so a stale daemon URL can't
  // misdirect a lock-screen answer for a session that no longer exists.
  // Fire-and-forget; no-op off-native, never throws.
  for (const id of evictedIds) void clearNativeRoute(id);
  const evicted = new Set(evictedIds);
  try {
    const stored = localStorage.getItem(LOCALSTORAGE_SESSION_DAEMONS_KEY);
    if (stored) {
      const map = JSON.parse(stored) as Record<string, string>;
      let changed = false;
      for (const id of evictedIds) {
        if (id in map) {
          delete map[id];
          changed = true;
        }
      }
      if (changed) localStorage.setItem(LOCALSTORAGE_SESSION_DAEMONS_KEY, JSON.stringify(map));
    }
    const last = localStorage.getItem(LOCALSTORAGE_SESSION_KEY);
    if (last && evicted.has(last)) localStorage.removeItem(LOCALSTORAGE_SESSION_KEY);
  } catch (err) {
    console.warn('[App] Failed to forget evicted sessions:', err);
  }
}

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
  // Keyed by `${sessionId}#${agentId}` so concurrent main + subagent prompts
  // coexist; see lib/question-collection (#437).
  const [questions, setQuestions] = useState<Map<string, UIQuestion>>(new Map());
  // Reply context per session: when set, the InputArea shows a quoted-message
  // banner and outgoing user input is wrapped in a markdown blockquote so
  // Claude Code receives the quoted context (#401).
  const [replyContexts, setReplyContexts] = useState<Map<UUID, ReplyContext>>(new Map());
  const [showConnectModal, setShowConnectModal] = useState(false);
  // New-session sheet (#638): recent project directories from the daemon.
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [recentDirectories, setRecentDirectories] = useState<readonly RecentDirectory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resumingSession, setResumingSession] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [unlockedIdentity, setUnlockedIdentity] = useState<UnlockedIdentity | null>(null);

  const activeSessionIdRef = useRef<UUID | null>(null);
  const resumingSessionRef = useRef<string | null>(null);
  const loadedTranscriptsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  const questionsRef = useRef(questions);
  const getSessionIdRef = useRef<((connId: ConnectionId) => string | null) | null>(null);
  // Stable handle so handleMessage (empty deps) can re-fetch a transcript when
  // it follows the daemon to its current session (reconnect adopt + stale
  // redirect), without depending on requestTranscriptLoad's identity (#499).
  const requestTranscriptLoadRef = useRef<
    ((connId: ConnectionId, sessionId: string) => void) | null
  >(null);
  const sessionsRef = useRef<UISession[]>([]);
  const lastQuestionIdRef = useRef<string | null>(null);
  // Mirror replyContexts in a ref so handleSend can read the active
  // session's reply context without taking a dep on the whole Map (#402
  // review). Without this, every reply set/clear in any session would
  // re-create handleSend and bust InputArea memoization.
  const replyContextsRef = useRef<Map<UUID, ReplyContext>>(replyContexts);
  const isReplayingRef = useRef(false);
  const requestSessionListRef = useRef<typeof requestSessionList | null>(null);
  const connectionsRef = useRef<readonly ConnectionState[]>([]);
  // Outstanding user_input sends awaiting their `ack`, keyed by message id
  // (#663). Mutated by handleSend (track), the 'ack' case (acknowledge), and
  // the sweep effect below (retry/fail on timeout). A ref, not state --
  // updated every send/ack/tick and read by an interval, none of which
  // should trigger a re-render on their own.
  const pendingSendsRef = useRef<PendingSendMap>(EMPTY_PENDING_SENDS);
  // Fallback timer so the new-session sheet leaves its loading state even if the
  // daemon never answers session_history_request (#638 review).
  const historyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // In-flight kill_session_request, keyed by requestId, so kill_session_response
  // (and a no-reply timeout) resolve against the session that was actually
  // stopped — not whatever session happens to be open in the chat (#637 review).
  const pendingKillsRef = useRef<
    Map<UUID, { sessionId: UUID; timeoutId: ReturnType<typeof setTimeout> }>
  >(new Map());

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
    // Drop a session's now-orphaned chat so its (new) transcript re-fetches.
    // Shared by session_rotated (live rotation) and hello_ack
    // (reconnect-mid-rotation, #439): both clear stale messages + questions and
    // forget the loaded-transcript marker so the load gate re-pulls history.
    const clearSessionForRebind = (sid: string) => {
      setMessages((prev) => prev.filter((m) => m.sessionId !== sid));
      setQuestions((prev) => clearSessionQuestions(prev, sid));
      loadedTranscriptsRef.current.delete(sid);
    };

    // Fetch a session's transcript if we haven't already, so that FOLLOWING the
    // daemon to its current session (reconnect adopt, stale redirect) loads the
    // chat automatically instead of waiting for a user tap (#499).
    const ensureTranscriptLoaded = (connId: ConnectionId, sid: string) => {
      if (loadedTranscriptsRef.current.has(sid)) {
        // Already loaded -> intentionally not re-fetched (the content is the
        // current session's). Logged so the skip is diagnosable (#499 review).
        console.debug('[App] ensureTranscriptLoaded: already loaded, skipping', sid);
        return;
      }
      loadedTranscriptsRef.current.add(sid);
      requestTranscriptLoadRef.current?.(connId, sid);
    };

    switch (message.type) {
      case 'hello_ack': {
        // The attached session from this daemon. Additional sessions may arrive via session_list_response.
        if (!message.sessionId) {
          console.warn('[App] Received hello_ack without sessionId from connection:', connectionId);
          break;
        }
        // Phase 2 daemons attach the binding here so the client knows
        // which transcript it's talking to before the first session_list
        // round-trip (#430). Older daemons omit; the field stays undefined.
        const ackClaudeSessionId =
          message.claudeSessionId === undefined || message.claudeSessionId === null
            ? undefined
            : (message.claudeSessionId as string);
        const ackTranscriptPath =
          message.transcriptPath === undefined || message.transcriptPath === null
            ? undefined
            : (message.transcriptPath as string);
        // Capture the binding we held BEFORE this ack so we can detect a
        // rotation that happened while we were disconnected (#439). If Claude
        // rotated (/clear, /resume) while away, the remi session id is
        // unchanged but its claudeSessionId differs from the one we last saw.
        // This read must precede the setSessions enqueue below, which is what
        // overwrites the binding.
        const prevClaudeSessionId = sessionsRef.current.find(
          (s) => s.id === message.sessionId && s.connectionId === connectionId,
        )?.claudeSessionId;
        // Reconnect-mid-rotation: the binding changed while we were away, so the
        // chat on screen belongs to the OLD Claude session. Clear it first, then
        // let the setSessions below swap the binding. Same effect as a live
        // session_rotated, which also clears before swapping (#439).
        if (bindingRotated(prevClaudeSessionId, ackClaudeSessionId)) {
          clearSessionForRebind(message.sessionId);
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
                ? {
                    ...s,
                    connectionStatus: 'connected',
                    connectionId,
                    ...(ackClaudeSessionId !== undefined && { claudeSessionId: ackClaudeSessionId }),
                    ...(ackTranscriptPath !== undefined && { transcriptPath: ackTranscriptPath }),
                    // #662/#663: refresh on EVERY hello_ack, not just the
                    // first -- this also fires when a queued connection is
                    // promoted (fresh hello_ack with attachState: 'attached'),
                    // which is how the read-only banner clears.
                    ...(message.attachState !== undefined && { attachState: message.attachState }),
                  }
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
              ...(ackClaudeSessionId !== undefined && { claudeSessionId: ackClaudeSessionId }),
              ...(ackTranscriptPath !== undefined && { transcriptPath: ackTranscriptPath }),
              ...(message.attachState !== undefined && { attachState: message.attachState }),
            } satisfies UISession,
          ];
        });
        localStorage.setItem(LOCALSTORAGE_SESSION_KEY, message.sessionId);

        // Pin sessionId -> daemon URL so cold-start push answers route to the
        // right daemon when multiple are paired. Look up the connection's URL
        // synchronously from the latest snapshot.
        const conn = connectionsRef.current.find((c) => c.connectionId === connectionId);
        if (conn?.url) {
          rememberSessionDaemon(message.sessionId, conn.url);
          // Mirror the daemon URL + signer to native storage (#591 P2) so a
          // lock-screen answer can sign + POST to the daemon's /answer endpoint
          // without opening the app. No-ops off-native; never throws.
          void setNativeRoute(message.sessionId, {
            wsUrl: conn.url,
            ...(ackClaudeSessionId !== undefined && { claudeSessionId: ackClaudeSessionId }),
          });
          void syncNativeIdentity();
        }

        // If the chat the user is CURRENTLY viewing belongs to this
        // connection and the daemon came back with a different session id,
        // the `cleaned` filter above already dropped that old session from
        // `sessions` for this connection -- it no longer resolves to
        // anything. Fall back to the session list rather than silently
        // follow into a session the user never picked (#688): a stray
        // reconnect must never swap the user into a different live
        // session's input box. `evictIfActive` is a no-op if the user has
        // since navigated away from `oldActive` on their own. A fresh
        // connect (no chat open) stays on the list either way. Notification
        // deep-links navigate via their own `push-notification-tap` handler,
        // not here.
        const oldActive = activeSessionIdRef.current;
        if (oldActive && oldActive !== message.sessionId) {
          const oldSession = sessionsRef.current.find((s) => s.id === oldActive);
          if (oldSession?.connectionId === connectionId) {
            setActiveSessionId(evictIfActive(activeSessionIdRef.current, oldActive));
            setMessages((prev) => prev.filter((m) => m.sessionId !== oldActive));
            setQuestions((prev) => clearSessionQuestions(prev, oldActive));
          }
        }
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
        // If status moved to a non-waiting, non-transient state, the MAIN
        // agent's prompt resolved (auto-approved, answered in terminal, etc.).
        // Session status tracks the main agent only (subagent events don't
        // change it), so clear just the main-agent slot; a concurrent subagent
        // prompt must survive. The transient auto-approve broadcasts
        // ('evaluating'/'approved', #576) must NOT clear a pending card; see
        // statusClearsMainQuestion for the rationale. A freshness gate (#652)
        // additionally protects a just-arrived card from a status update racing
        // it in the same burst (the cause of the "flash and vanish" flicker).
        setQuestions((prev) => clearMainQuestionOnStatus(prev, sessionData.id, sessionData.status));
        break;
      }

      case 'session_views': {
        // The parent session's subagent chats (#499 phase 3). Surface each as a
        // navigable entry whose id IS the agentId; opening it loads
        // agent-<id>.jsonl through the normal transcript flow. Replace this
        // parent's whole subagent set each push (active first, finished kept).
        const parentId = message.sessionId;
        const subs = message.subagents;
        setSessions((prev) => {
          const parent = prev.find((s) => s.id === parentId);
          const withoutOldSubs = prev.filter(
            (s) =>
              !(s.isSubagent && s.parentSessionId === parentId && s.connectionId === connectionId),
          );
          const subRows: UISession[] = subs.map((v) => {
            const existing = prev.find((s) => s.id === (v.agentId as UUID));
            return {
              id: v.agentId as UUID,
              name: v.agentType,
              connectionId,
              createdAt: existing?.createdAt ?? new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              status: 'idle',
              connectionStatus: parent?.connectionStatus ?? 'connected',
              unreadCount: 0,
              isSubagent: true,
              parentSessionId: parentId,
              agentType: v.agentType,
              subagentActive: v.active,
            } satisfies UISession;
          });
          return [...withoutOldSubs, ...subRows];
        });
        break;
      }

      case 'session_rotated': {
        // Atomic rotation (#438): /clear or /resume started a NEW transcript
        // under a new Claude session id (NOT /compact, which keeps the same
        // id). Only applies to a session THIS connection owns. Clear the stale
        // messages + questions, swap the binding, and clear loadedTranscriptsRef
        // so the new transcript re-fetches — otherwise the old chat lingers and
        // the next answer is refused as STALE_BINDING ("not from this session").
        const rotatedId = message.sessionId;
        const owns = sessionsRef.current.some(
          (s) => s.id === rotatedId && s.connectionId === connectionId,
        );
        if (!owns) {
          // Usually a sibling connection's session (not ours) — expected and
          // benign. The rare exception is a rotation arriving in the same tick
          // as the session's hello_ack, before sessionsRef commits; log so that
          // case is diagnosable rather than a silent dropped rotation.
          console.warn(
            `[App] session_rotated for ${rotatedId.slice(0, 8)} not owned by ${connectionId} (sibling, or hello_ack not yet committed)`,
          );
          break;
        }
        clearSessionForRebind(rotatedId);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === rotatedId && s.connectionId === connectionId
              ? {
                  ...s,
                  claudeSessionId: message.newClaudeSessionId as string,
                  transcriptPath: message.newTranscriptPath,
                }
              : s,
          ),
        );
        console.info(
          `[App] session_rotated ${rotatedId.slice(0, 8)} on ${connectionId}: claude=${message.newClaudeSessionId.slice(0, 8)} reason=${message.reason}`,
        );
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
          description: o.description || undefined,
        }));

        // #626: carry the full AskUserQuestion structure (headers, per-option
        // descriptions, multiSelect) so the card can render it properly.
        const uiQuestions: UIQuestion['questions'] = q.questions?.map((step) => ({
          ...(step.header ? { header: step.header } : {}),
          text: step.text,
          multiSelect: step.multiSelect,
          options: step.options.map((o) => ({
            label: o.label,
            value: o.value,
            isYes: o.isYes || undefined,
            isNo: o.isNo || undefined,
            isRecommended: o.isRecommended || undefined,
            description: o.description || undefined,
          })),
        }));

        // sessionId is mandatory on the wire now (#437); never fall back to
        // the active session (that cross-contaminated when another session or
        // agent had a prompt). Drop a malformed message rather than misroute.
        const questionSessionId = message.sessionId;
        if (!questionSessionId) {
          console.warn('[App] Dropping question with no sessionId');
          break;
        }
        const questionAgentId = q.agentId;
        const uiQuestion: UIQuestion = {
          id: q.id,
          sessionId: questionSessionId,
          type: questionType,
          prompt: q.text,
          options: q.options.length > 0 ? q.options.map((o) => o.label) : undefined,
          structuredOptions: structuredOptions.length > 0 ? structuredOptions : undefined,
          timestamp: new Date().toISOString(),
          agentId: questionAgentId,
          ...(q.kind ? { kind: q.kind } : {}),
          ...(uiQuestions && uiQuestions.length > 0 ? { questions: uiQuestions } : {}),
          ...(q.submitLabel ? { submitLabel: q.submitLabel } : {}),
        };
        const key = questionKey(questionSessionId, questionAgentId);
        setQuestions((prev) => {
          // Richer-wins guard (#396), scoped to this agent's slot. The daemon
          // emits two questions for one prompt cycle (HookEventBridge default
          // 3-set + PTY-parsed multi-choice with full sentences); their ids
          // differ so a same-key second arrival would otherwise overwrite the
          // first regardless of richness. A DIFFERENT agent's prompt has a
          // different key and so coexists rather than clobbering (#419/#425).
          const existing = prev.get(key);
          if (existing && shouldKeepExisting(existing, uiQuestion)) {
            return prev;
          }
          const next = new Map(prev);
          next.set(key, uiQuestion);
          return next;
        });

        // Mark session as having a pending question
        setSessions((prev) =>
          prev.map((s) => (s.id === questionSessionId ? { ...s, questionPending: true } : s)),
        );

        // Push (APNS) is the notification channel — no local notification from WebSocket
        break;
      }

      case 'question_resolved': {
        // Cross-client dismissal (#585, P7): the question resolved on some
        // channel (answered elsewhere, auto-approved/denied, or cancelled). The
        // message carries no agentId, so locate the card by question id within
        // the session. Rather than vanish instantly (#652 — left a lock-screen
        // answer with no in-app confirmation), flip a still-pending card to a
        // brief "resolved elsewhere" trace, then fade it after the linger window.
        // resolveQuestionCard decides per card: pending => trace+fade, submitting
        // (#627) => removed here, answered-locally => left to its own timer.
        const resolvedSessionId = message.sessionId;
        const resolvedQuestionId = message.questionId;
        // Compute the next map from the CURRENT committed ref, then drive both
        // setters from that one value (#585, P7 FIX 3): reading the updated map
        // (not the pre-mutation ref) keeps two concurrent resolutions from
        // leaving the badge stuck `questionPending: true`. The ref is the latest
        // committed map (kept in sync by the effect below).
        const { questions: nextQuestions, fade } = resolveQuestionCard(
          questionsRef.current,
          resolvedSessionId,
          resolvedQuestionId,
          message.reason,
        );
        const stillPending = getSessionQuestions(nextQuestions, resolvedSessionId).some(
          isQuestionPending,
        );
        questionsRef.current = nextQuestions;
        setQuestions(nextQuestions);
        setSessions((prev) =>
          prev.map((s) => (s.id === resolvedSessionId ? { ...s, questionPending: stillPending } : s)),
        );
        // Clear the matching delivered lock-screen / in-app notification (native).
        dismissDeliveredNotification(resolvedQuestionId);
        // Fade the trace card we just flipped; remove by id so a newer prompt
        // that took the same slot meanwhile is never wiped. A submitting card was
        // already removed above, and an answered/absent card owns its own removal.
        if (fade) {
          setTimeout(() => {
            setQuestions((prev) =>
              removeQuestionById(prev, resolvedSessionId, resolvedQuestionId),
            );
          }, RESOLVED_TRACE_LINGER_MS);
        }
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
              ...(ds.claudeSessionId !== undefined && { claudeSessionId: ds.claudeSessionId }),
              ...(ds.transcriptPath !== undefined && { transcriptPath: ds.transcriptPath }),
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

        // Phantom eviction (#577 Fix A): drop long-dead sessions this daemon no
        // longer knows, which is what stops the recurring NOT_FOUND retry loop
        // for a session purged from sessions.json. Computed from the synchronous
        // sessionsRef snapshot (not inside setSessions) so it stays pure +
        // StrictMode-safe and we can do the localStorage/ref cleanup after.
        //
        // Authoritative known set for THIS connection: the daemon's own
        // daemon-sourced sessions + the attached hello_ack session. mDNS
        // 'transcript' discoveries are excluded — they don't prove this daemon
        // still manages the session, so they must not keep a phantom alive.
        const knownIds = new Set<string>(
          message.sessions
            .filter((ds: DiscoverableSession) => ds.source === 'daemon')
            .map((ds: DiscoverableSession) => ds.sessionId),
        );
        if (helloAckSessionId) knownIds.add(helloAckSessionId);
        const evictionCtx = { knownIds, connectionAuthoritative: connectionId };
        const evictionNow = Date.now();
        // Compute the evicted set ONCE from the synchronous snapshot, then reuse
        // the SAME set for the state filter, the loadedTranscriptsRef cleanup,
        // and the active-session reset so there is no two-snapshot drift (every
        // side effect acts on exactly what the list filter removes).
        const evictedSet = new Set(
          sessionsRef.current
            .filter((s) =>
              shouldEvictCachedSession(
                { id: s.id, lastActiveAt: s.lastActiveAt, connectionId: s.connectionId },
                evictionCtx,
                evictionNow,
              ),
            )
            .map((s) => s.id),
        );
        if (evictedSet.size > 0) {
          const evictedIds = [...evictedSet];
          forgetEvictedSessions(evictedIds);
          for (const id of evictedIds) loadedTranscriptsRef.current.delete(id);
          // If the active session was evicted, clear it so the UI doesn't sit
          // on a dead session and re-request its (gone) transcript. Routed
          // through the same #688 rule as every other selection-changing
          // path: a phantom sweep can only clear the active session, never
          // swap it for a different live one.
          setActiveSessionId(evictManyIfActive(activeSessionIdRef.current, evictedSet));
          console.warn('[App] Evicted stale phantom sessions (#577):', evictedIds);
        }

        // Multi-daemon merge: keep sessions from other connections, preserve attached session
        // for this connection if not in discovered list, add all newly discovered sessions,
        // sort live-first then by recency.
        setSessions((prev) => {
          const live = prev.filter((s) => !evictedSet.has(s.id));
          const otherConnSessions = live.filter((s) => s.connectionId !== connectionId);
          // Keep the attached session for this connection (from hello_ack)
          const attachedSession = live.find(
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
          const deduped = dedupSessions(result);
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
        // Recent project directories for the new-session sheet (#638).
        if (historyTimeoutRef.current) {
          clearTimeout(historyTimeoutRef.current);
          historyTimeoutRef.current = null;
        }
        setHistoryLoading(false);
        setRecentDirectories(message.directories);
        break;
      }

      case 'kill_session_response': {
        // Resolve against the session we actually asked to stop (not the open
        // chat) and cancel its no-reply timeout.
        const pending = pendingKillsRef.current.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingKillsRef.current.delete(message.requestId);
        }
        const killedSessionId = pending?.sessionId ?? activeSessionIdRef.current ?? ('' as UUID);
        if (message.success) {
          // Session torn down; refresh the list so the dead session drops off.
          const reqList = requestSessionListRef.current;
          if (reqList) {
            const conns = connectionsRef.current.filter((c) => c.status === 'connected');
            for (const conn of conns) {
              reqList(conn.connectionId, conns.length === 1);
            }
          }
        } else {
          console.error(`Session kill failed: ${message.error}`);
          const errorMsg: UIMessage = {
            id: generateId(),
            sessionId: killedSessionId,
            connectionId: '' as ConnectionId,
            sender: 'system',
            content: `Failed to exit session: ${message.error || 'unknown error'}`,
            timestamp: new Date().toISOString(),
            state: 'delivered',
            isEditing: false,
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
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

      case 'daemon_update_available': {
        // Daemon binary updated on disk but the running wrapper still hosts
        // the user's PTY. Surface a system message in every active session so
        // they can restart at a safe checkpoint. Issue #287.
        // Read sessions from the ref (kept in sync below) instead of inside a
        // setState updater — StrictMode runs updaters twice in dev, so nesting
        // setMessages inside setSessions would queue duplicate banners.
        const currentSessions = sessionsRef.current;
        if (currentSessions.length === 0) break;
        const banner =
          `Daemon binary updated on disk (running ${message.currentVersion}). ` +
          `Detach and restart the session to pick up the new version.`;
        const banners = currentSessions.map((s) => ({
          id: generateId(),
          sessionId: s.id,
          connectionId,
          sender: 'system' as const,
          content: banner,
          timestamp: message.timestamp,
          state: 'delivered' as const,
          isEditing: false,
        }));
        setMessages((m) => [...m, ...banners]);
        break;
      }

      case 'error': {
        const errorText = message.message ?? 'unknown';
        // Suppress auth errors (handled by the connection manager)
        if (errorText.includes('Authentication required') || errorText.includes('AUTH_REQUIRED')) {
          console.debug('[App] Auth error suppressed:', errorText);
          break;
        }
        // STALE_BINDING (#430): the user typed against an old Claude
        // session and the daemon refused. Update our cached binding
        // from the error's details so the next answer routes correctly.
        // The shape mirrors the daemon-side createError call in
        // packages/daemon/src/cli/handlers/input-events.ts:guardBinding;
        // update both ends together if the field names change.
        const errorCode = (message as { code?: string }).code;
        // #627: the daemon could not auto-answer a structured AskUserQuestion
        // (review mismatch / timeout / unexpected variant). Flip the card to the
        // "needs you" state so the user can Cancel or answer in the terminal —
        // the prompt is intentionally left up (never a wrong auto-submit).
        if (errorCode === 'AUQ_AUTOANSWER_FAILED') {
          const details = (message as { details?: Record<string, unknown> }).details;
          const failedQid = asNonEmptyString(details?.['questionId']);
          if (failedQid) {
            setQuestions((prev) => {
              let changed = false;
              const next = new Map(prev);
              for (const [k, q] of prev) {
                if (q.id === failedQid) {
                  next.set(k, { ...q, submitting: false, autoAnswerFailed: true });
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
          }
          break;
        }
        // NOT_FOUND with a current-session redirect (#499): the requested
        // session is stale (the daemon restarted or rotated past it). The
        // daemon's error carries no id for which request this was, so it
        // cannot be correlated to a specific in-flight load (#688) -- only
        // auto-follow when nothing is currently selected (matches the
        // fresh-connect gate above); otherwise this would risk silently
        // swapping whatever live session the user is looking at for the
        // daemon's current one. The upsert below still makes the daemon's
        // current session visible/tappable in the list either way.
        if (errorCode === 'NOT_FOUND') {
          const details = (message as { details?: Record<string, unknown> }).details;
          const currentSessionId = asNonEmptyString(details?.['currentSessionId']) as
            | UUID
            | undefined;
          if (currentSessionId) {
            const currentClaudeSessionId = asNonEmptyString(details?.['currentClaudeSessionId']);
            const currentTranscriptPath = asNonEmptyString(details?.['currentTranscriptPath']);
            const claudePatch = currentClaudeSessionId
              ? { claudeSessionId: currentClaudeSessionId as UUID }
              : {};
            const transcriptPatch = currentTranscriptPath
              ? { transcriptPath: currentTranscriptPath }
              : {};
            // Upsert: patch the binding if the session is already listed, else
            // add a placeholder row (the NOT_FOUND can race ahead of the
            // hello_ack that adds it) so setActiveSessionId has something to
            // render instead of a blank screen (#499 review).
            setSessions((prev) => {
              if (prev.some((s) => s.id === currentSessionId && s.connectionId === connectionId)) {
                return prev.map((s) =>
                  s.id === currentSessionId && s.connectionId === connectionId
                    ? { ...s, ...claudePatch, ...transcriptPatch }
                    : s,
                );
              }
              return [
                ...prev,
                {
                  id: currentSessionId,
                  name: 'Claude Code Session',
                  createdAt: new Date().toISOString(),
                  lastActiveAt: new Date().toISOString(),
                  status: 'idle',
                  connectionStatus: 'connected',
                  connectionId,
                  unreadCount: 0,
                  preview: 'Connected',
                  ...claudePatch,
                  ...transcriptPatch,
                } satisfies UISession,
              ];
            });
            // Do NOT clearSessionForRebind here -- that would wipe the current
            // session's already-rendered messages. ensureTranscriptLoaded gates
            // on the loaded marker, so it fetches only if not already loaded
            // (no wipe, no duplicate append) (#499 review).
            //
            // Refresh and navigate are separate concerns (#688 review): the
            // refresh must happen whenever currentSessionId is present --
            // including when it's already the active session (e.g. a
            // bindingRotated hello_ack cleared its loaded marker without a
            // re-fetch) -- while navigation is gated on autoSelectIfNone so a
            // stale/racy redirect never steals focus from a different
            // explicit selection.
            ensureTranscriptLoaded(connectionId, currentSessionId);
            const nextActive = autoSelectIfNone(activeSessionIdRef.current, currentSessionId);
            if (nextActive !== activeSessionIdRef.current) {
              setActiveSessionId(nextActive);
              console.warn(
                '[App] Stale transcript request; following daemon to current session',
                currentSessionId,
              );
            } else {
              console.warn(
                '[App] Stale transcript request; daemon current session available but not followed (active selection present)',
                currentSessionId,
              );
            }
            break;
          }
        }
        // NOT_ACTIVE_CONNECTION (#662/#663): this connection is read-only --
        // another client holds the session's exclusive write lock -- and the
        // input that triggered this error was never delivered to the PTY
        // (the daemon still sent an `ack` for it separately; `ack` only means
        // "the daemon received the frame", not "Claude saw it"). The error
        // carries no messageId to flip a specific bubble to failed, so the
        // fix is to refresh the persistent read-only banner (ChatView) rather
        // than only a one-off chat bubble the user can miss or that scrolls
        // away.
        if (errorCode === 'NOT_ACTIVE_CONNECTION') {
          const details = (message as { details?: Record<string, unknown> }).details;
          const queuedSessionId = asNonEmptyString(details?.['sessionId']);
          if (queuedSessionId) {
            setSessions((prev) =>
              prev.map((s) =>
                s.id === queuedSessionId && s.connectionId === connectionId
                  ? { ...s, attachState: 'queued' }
                  : s,
              ),
            );
          }
          console.warn(
            '[App] NOT_ACTIVE_CONNECTION: input not delivered, session is read-only',
            queuedSessionId,
          );
          break;
        }
        if (errorCode === 'STALE_BINDING') {
          const details = (message as { details?: Record<string, unknown> }).details;
          const refusedSessionId = asNonEmptyString(details?.['sessionId']) as UUID | undefined;
          const newBound = asNonEmptyString(details?.['boundClaudeSessionId']);
          if (refusedSessionId && newBound) {
            setSessions((prev) =>
              prev.map((s) =>
                s.id === refusedSessionId && s.connectionId === connectionId
                  ? { ...s, claudeSessionId: newBound as UUID }
                  : s,
              ),
            );
            // Un-answer the optimistically-collapsed question so the
            // user can retry against the new binding (#434 review).
            // Without this the QuestionCard stays collapsed showing
            // the rejected answer and the user has no retry path.
            setQuestions((prev) => {
              // Un-answer any optimistically-collapsed question for the refused
              // session (across agents) so the user can retry (#434 review).
              let changed = false;
              const next = new Map(prev);
              for (const [key, q] of prev) {
                if (q.sessionId === refusedSessionId && q.answeredWith !== undefined) {
                  const restored = { ...q };
                  delete (restored as { answeredWith?: string }).answeredWith;
                  next.set(key, restored);
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
          }
          console.warn(
            '[App] STALE_BINDING: server-side binding rotated; re-keying. Detail:',
            details,
          );
          // Fall through so the user sees the error in chat.
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

      // #663: only `user_input` sends are tracked in pendingSendsRef (see
      // handleSend), so an ack for anything else (hello, answer, ...) simply
      // finds no match and no-ops here -- expected, not an error.
      case 'ack': {
        const { pending, matched } = acknowledgeSend(pendingSendsRef.current, message.ack.messageId);
        pendingSendsRef.current = pending;
        if (matched) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === message.ack.messageId && m.sender === 'user'
                ? { ...m, state: 'delivered' as const }
                : m,
            ),
          );
        }
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

  // Bridge the current signer to native storage once on launch (#591 P2) so the
  // lock-screen answer handler can sign even before a fresh connection — covers
  // a cold start from a push and identity changes made in Settings. No-op
  // off-native; re-pinned per-connection at hello_ack.
  useEffect(() => {
    void syncNativeIdentity();
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);

  useEffect(() => {
    replyContextsRef.current = replyContexts;
  }, [replyContexts]);

  // Connection manager: manages N simultaneous WebSocket connections
  const {
    connections,
    connectDirect,
    disconnect: disconnectConnection,
    reconnect: reconnectConnection,
    disconnectAll,
    sendInput,
    sendEscape,
    sendAnswer,
    sendAuqAnswer,
    sendCancelQuestion,
    sendMessage: cmSendMessage,
    requestBulletExpand,
    requestSessionList,
    requestTranscriptLoad,
    requestResumeSession,
    requestNewSession,
    requestSessionHistory,
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
  requestTranscriptLoadRef.current = requestTranscriptLoad;
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
        // Reconcile aliases persisted under different host spellings (e.g. a
        // 'localhost' URL saved before a later 'ws://127.0.0.1:.../ws'
        // connect) to one entry per daemon (#682): connecting to both would
        // leave a stale duplicate manager entry that can drive a stale error
        // banner even while the deduped survivor is healthy and attached.
        const deduped = dedupeConnectionUrls(urls, parseConnectionId);
        if (deduped.length !== urls.length) {
          localStorage.setItem(LOCALSTORAGE_CONNECTIONS_KEY, JSON.stringify(deduped));
        }
        for (const url of deduped) {
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
    /** Notify user that the push answer could not be delivered */
    const notifyFailure = () => {
      LocalNotifications.schedule({
        notifications: [
          {
            title: 'Answer not delivered',
            body: 'Open Remi to respond to the question.',
            id: (Date.now() % 2_000_000_000) + Math.floor(Math.random() * 1000),
            schedule: { at: new Date() },
          },
        ],
      }).catch((err) => {
        // Last-line fallback in the suspended-app path; if scheduling
        // itself fails (permissions revoked, plugin unavailable) the user
        // would otherwise see no signal that the push answer was lost.
        console.error('[App] LocalNotifications.schedule failed:', err);
      });
    };

    const handlePushAnswer = async (e: Event) => {
      const { sessionId, questionId, answer } = (
        e as CustomEvent<{ sessionId: string; questionId: string; answer: string }>
      ).detail;
      if (!sessionId || !questionId || !answer) return;

      console.debug('[App] handlePushAnswer:', { sessionId, questionId, answer });

      // Thread claudeSessionId so the daemon can refuse if its binding
      // has rotated since the lock-screen notification fired (#430 review
      // #433). Without this the cold-start push-answer path silently
      // bypassed the stale-binding guard. Read from sessionsRef so we
      // see the latest snapshot even when this handler captured an old
      // closure of `sessions`.
      const boundId = sessionsRef.current.find((s) => s.id === sessionId)?.claudeSessionId;
      const answerMsg = createAnswer(
        sessionId as UUID,
        questionId as UUID,
        answer,
        boundId as UUID | undefined,
      );

      // Read the persisted URL list and per-session daemon map once; pass
      // into the pure resolver.
      let storedUrls: string[] = [];
      let sessionUrlMap: Record<string, string> = {};
      try {
        const stored = localStorage.getItem(LOCALSTORAGE_CONNECTIONS_KEY);
        if (stored) storedUrls = JSON.parse(stored) as string[];
        const mapStored = localStorage.getItem(LOCALSTORAGE_SESSION_DAEMONS_KEY);
        if (mapStored) sessionUrlMap = JSON.parse(mapStored) as Record<string, string>;
      } catch {
        // localStorage unavailable or corrupted; resolver treats empty as cold-start.
      }

      const target = resolvePushAnswerTarget({
        sessionId,
        sessions: sessionsRef.current,
        connections: connectionsRef.current,
        storedUrls,
        sessionUrlMap,
      });

      if (target.kind === 'live' && target.connectionId) {
        const sent = pushAnswerSendRef.current(target.connectionId as ConnectionId, answerMsg);
        if (sent) return;
        // Send returned false (dead socket the heartbeat hasn't noticed yet).
        // Tear down the stale connection before reconnecting; otherwise the
        // FIFO exclusive-lock queue holds the duplicate forever.
        console.warn('[App] live send returned false; tearing down dead socket');
        try {
          disconnectConnection(target.connectionId as ConnectionId);
        } catch (err) {
          console.warn('[App] disconnect-before-reconnect failed:', err);
        }
      }

      if (target.kind === 'unreachable' || !target.url) {
        notifyFailure();
        return;
      }

      // Fast path (#575, P4a): deliver the answer over a plain HTTPS POST to the
      // daemon's /answer endpoint, bypassing the WebSocket and its handshake.
      // This is the only reliable path on a cold-start wake where the WS is not
      // warm. Probe whether the daemon requires auth so we can sign when needed
      // (loopback daemons skip the probe-derived signature; the daemon exempts
      // them anyway). probeAuthInfo never throws — it returns null on any
      // failure — so a null probe means "assume no auth" and let the daemon
      // reject if it disagrees (a 401 then falls back to WS).
      const targetUrl = target.url;
      const authInfo = await probeAuthInfo(targetUrl);
      const authRequired = authInfo?.authRequired ?? false;

      const relay = await relayAnswerDirect({
        wsUrl: targetUrl,
        sessionId,
        questionId,
        answer,
        claudeSessionId: boundId,
        authRequired,
      });

      if (relay.kind === 'delivered') return;
      if (relay.kind === 'rejected') {
        // The daemon refused as stale (409) or unknown (404). The WebSocket
        // would refuse identically; tell the user instead of retrying.
        console.warn('[App] direct relay rejected:', relay.result);
        notifyFailure();
        return;
      }
      if (relay.kind === 'needs-passphrase') {
        // No unlocked identity, so neither the relay nor the WebSocket can
        // authenticate without a prompt. Fail fast rather than waiting out the
        // (now longer) deadline on a connection that will never complete.
        console.warn('[App] direct relay blocked: identity needs passphrase');
        notifyFailure();
        return;
      }
      // relay.kind === 'unreachable' (network / WebRTC-relay-only daemon) or
      // 'auth-failed' (HTTP 401 — no/invalid detached signature, but the WS
      // challenge-response may still succeed). Both fall back to the WebSocket
      // reconnect path.
      console.debug(
        `[App] direct relay ${relay.kind}, falling back to WS:`,
        relay.kind === 'unreachable' ? relay.reason : relay.result,
      );

      // If auth is required but there is no usable (unlocked) identity, the
      // WebSocket would stall at auth_challenge forever — fail fast rather than
      // waiting out the 25s deadline. Covers both "no identity" and "encrypted
      // identity" (isIdentityEncrypted() is false when none is stored, so both
      // are checked).
      if (authRequired && (!hasIdentity() || isIdentityEncrypted())) {
        console.warn('[App] WS fallback blocked: identity missing or needs passphrase');
        notifyFailure();
        return;
      }

      const targetConnId: ConnectionId =
        target.kind === 'pending' && target.connectionId
          ? (target.connectionId as ConnectionId)
          : connectDirectRef.current(targetUrl);

      // Wait for the connection, then send. Raised from 10s to 25s (#575, P4a):
      // a cold-start wake includes process resume + TCP/TLS + the Ed25519
      // handshake, which routinely exceeds 10s; 25s stays within the iOS
      // background-task window. The loop sends the instant status hits
      // 'connected', so a fast connect is not penalized by the larger deadline.
      const ANSWER_TIMEOUT_MS = 25_000;
      const deadline = Date.now() + ANSWER_TIMEOUT_MS;
      const delivered = await new Promise<boolean>((resolve) => {
        const check = setInterval(() => {
          const live = connectionsRef.current.find((c) => c.connectionId === targetConnId);
          if (live?.status === 'connected') {
            clearInterval(check);
            const sent = pushAnswerSendRef.current(targetConnId, answerMsg);
            resolve(sent);
          } else if (Date.now() >= deadline) {
            clearInterval(check);
            resolve(false);
          }
        }, 250);
      });

      if (!delivered) {
        notifyFailure();
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
  // All pending prompts for the active session (main + any subagents), oldest
  // first; rendered as a stack of cards (#437).
  const sessionQuestions = activeSessionId ? getSessionQuestions(questions, activeSessionId) : [];

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

  // Answer the active question for the current session. Used by
  // QuestionCard's onAnswer callback. Decoupled from handleSend so the
  // bottom InputArea is no longer hijacked when a question is pending
  // (#401): the user can ask the agent a fresh question without it
  // being treated as an answer to a stale prompt.
  const handleAnswer = useCallback(
    (question: UIQuestion, content: string) => {
      const sid = question.sessionId;
      // Route by the question's OWN session connection (in a multi-daemon
      // stack it may differ from the active session), not "whatever is active".
      const connId = sessionsRef.current.find((s) => s.id === sid)?.connectionId ?? getActiveConnectionId();
      if (!connId) {
        const systemMsg: UIMessage = {
          id: generateId(),
          sessionId: sid,
          sender: 'system',
          content: 'Cannot send: not connected to daemon',
          timestamp: new Date().toISOString(),
          state: 'delivered',
          isEditing: false,
        };
        setMessages((prev) => [...prev, systemMsg]);
        return;
      }

      // Carry claudeSessionId so the daemon can refuse if its binding
      // has rotated since the question fired (#430). Route by the question's
      // OWN session/id so answering one of several stacked prompts is precise.
      const binding = sessionsRef.current.find((s) => s.id === sid)?.claudeSessionId;
      const sent = sendAnswer(connId, sid, question.id, content, binding as UUID | undefined);
      if (!sent) {
        const failMsg: UIMessage = {
          id: generateId(),
          sessionId: sid,
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
      const key = questionKey(sid, question.agentId);
      const answeredId = question.id;
      // Mark this question answered (card shows collapsed state briefly), then
      // remove it; sibling prompts for the session stay in the stack.
      setQuestions((prev) => {
        const existing = prev.get(key);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(key, { ...existing, answeredWith: content });
        return next;
      });
      // Remove by (key, id), not key alone: a newer prompt may have taken this
      // session/agent slot before the timer fires (back-to-back escalations);
      // deleting it would make the new card "flash and vanish" (#652).
      setTimeout(() => {
        setQuestions((prev) => removeQuestionByKeyIfId(prev, key, answeredId));
      }, RESOLVED_TRACE_LINGER_MS);
      // Keep the session flagged while OTHER prompts remain unanswered. Read
      // the ref (latest committed map) rather than the closure so the badge
      // can't get stuck after the dep snapshot goes stale. The ref still holds
      // the pre-answer card for this id, so exclude it explicitly.
      const stillPending = getSessionQuestions(questionsRef.current, sid).some(
        (q) => q.id !== question.id && isQuestionPending(q),
      );
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, questionPending: stillPending } : s)),
      );
      const userMsg: UIMessage = {
        id: generateId(),
        sessionId: sid,
        sender: 'user',
        content,
        timestamp: new Date().toISOString(),
        state: 'sent',
        isEditing: false,
        source: 'optimistic',
      };
      setMessages((prev) => [...prev, userMsg]);
    },
    [getActiveConnectionId, sendAnswer],
  );

  // #627: submit a structured AskUserQuestion answer. The daemon drives the TUI
  // and verifies before submitting, so the card flips to "Answering…" and clears
  // on question_resolved (or flips to failed on AUQ_AUTOANSWER_FAILED) — it is NOT
  // removed optimistically here.
  const handleAuqAnswer = useCallback(
    (question: UIQuestion, selections: { questionIndex: number; optionIndices: number[] }[]) => {
      const sid = question.sessionId;
      const connId =
        sessionsRef.current.find((s) => s.id === sid)?.connectionId ?? getActiveConnectionId();
      if (!connId) return;
      const binding = sessionsRef.current.find((s) => s.id === sid)?.claudeSessionId;
      const sent = sendAuqAnswer(connId, sid, question.id, selections, binding as UUID | undefined);
      if (!sent) return;
      const key = questionKey(sid, question.agentId);
      setQuestions((prev) => {
        const existing = prev.get(key);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(key, { ...existing, submitting: true, autoAnswerFailed: false });
        return next;
      });
    },
    [getActiveConnectionId, sendAuqAnswer],
  );

  // #627: cancel/escape a pending question — the universal unstick. The daemon
  // sends Esc to the prompt; the card clears on the resulting question_resolved.
  const handleCancelQuestion = useCallback(
    (question: UIQuestion) => {
      const sid = question.sessionId;
      const connId =
        sessionsRef.current.find((s) => s.id === sid)?.connectionId ?? getActiveConnectionId();
      if (!connId) return;
      const binding = sessionsRef.current.find((s) => s.id === sid)?.claudeSessionId;
      sendCancelQuestion(connId, sid, question.id, binding as UUID | undefined);
      const key = questionKey(sid, question.agentId);
      setQuestions((prev) => {
        const existing = prev.get(key);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(key, { ...existing, submitting: true });
        return next;
      });
    },
    [getActiveConnectionId, sendCancelQuestion],
  );

  // Persistent escape: send a bare Esc to the ACTIVE session at any time — it
  // interrupts Claude's running work and escapes/cancels an on-screen prompt,
  // even before a question card exists. Surfaced as a button in the input row and
  // a long-press on the send button.
  const handleEscape = useCallback(() => {
    if (!activeSessionId) return;
    const connId =
      sessions.find((s) => s.id === activeSessionId)?.connectionId ?? getActiveConnectionId();
    if (!connId) return;
    const binding = sessions.find((s) => s.id === activeSessionId)?.claudeSessionId;
    sendEscape(connId, activeSessionId, binding as UUID | undefined);
  }, [activeSessionId, getActiveConnectionId, sendEscape, sessions]);

  // Send a regular user input message, optionally with a reply context.
  // Always routes through sendInput regardless of pending question state
  // (#401 bug fix). The QuestionCard owns the answer flow via handleAnswer.
  const handleSend = useCallback(
    (content: string) => {
      if (!activeSessionId) return;
      // Subagent views are read-only monitoring: their id is an agentId, not a
      // real daemon session, so input would route nowhere. Block the send
      // (the input is also hidden in ChatView) (#499 phase 3).
      if (sessionsRef.current.find((s) => s.id === activeSessionId)?.isSubagent) return;
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

      const reply = replyContextsRef.current.get(activeSessionId);
      const wireContent = reply ? formatReplyMessage(reply, content) : content;
      // Same id for the UI bubble AND the wire message (#663): the daemon's
      // `ack.messageId` echoes back whatever id we send, so this is what
      // lets an inbound ack find its bubble. Also what a retry reuses so
      // the daemon's MessageIdTracker dedups it.
      const messageId = generateId();

      const newMessage: UIMessage = {
        id: messageId,
        sessionId: activeSessionId,
        sender: 'user',
        content: wireContent,
        timestamp: new Date().toISOString(),
        state: 'sending',
        isEditing: false,
        source: 'optimistic',
      };

      setMessages((prev) => [...prev, newMessage]);

      const activeBinding = sessions.find((s) => s.id === activeSessionId)?.claudeSessionId;
      const success = sendInput(
        connId,
        activeSessionId,
        wireContent,
        activeBinding as UUID | undefined,
        messageId,
      );
      if (success) {
        setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, state: 'sent' } : m)));
        pendingSendsRef.current = trackSend(pendingSendsRef.current, {
          messageId,
          connectionId: connId,
          sessionId: activeSessionId,
          content: wireContent,
          claudeSessionId: activeBinding,
          sentAt: Date.now(),
        });
        // Reply context is consumed on send; the next message starts clean
        // unless the user explicitly long-presses another message.
        if (reply) {
          setReplyContexts((prev) => {
            if (!prev.has(activeSessionId)) return prev;
            const next = new Map(prev);
            next.delete(activeSessionId);
            return next;
          });
        }
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, state: 'failed' as const } : m)),
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
    [activeSessionId, getActiveConnectionId, sendInput, sessions],
  );

  // Tap-to-retry a 'failed' bubble (#663). Reuses the SAME message id so the
  // daemon's MessageIdTracker dedups it if the original somehow did land.
  // Re-enters the pending-sends tracker so the automatic retry/timeout sweep
  // resumes watching it.
  const handleRetryMessage = useCallback(
    (message: UIMessage) => {
      const sid = message.sessionId;
      const connId =
        sessionsRef.current.find((s) => s.id === sid)?.connectionId ?? getActiveConnectionId();
      if (!connId) return;
      const binding = sessionsRef.current.find((s) => s.id === sid)?.claudeSessionId;

      setMessages((prev) =>
        prev.map((m) => (m.id === message.id ? { ...m, state: 'sending' as const } : m)),
      );

      const success = sendInput(
        connId,
        sid,
        message.content,
        binding as UUID | undefined,
        message.id,
      );
      if (success) {
        setMessages((prev) =>
          prev.map((m) => (m.id === message.id ? { ...m, state: 'sent' as const } : m)),
        );
        pendingSendsRef.current = trackSend(pendingSendsRef.current, {
          messageId: message.id,
          connectionId: connId,
          sessionId: sid,
          content: message.content,
          claudeSessionId: binding,
          sentAt: Date.now(),
        });
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === message.id ? { ...m, state: 'failed' as const } : m)),
        );
      }
    },
    [getActiveConnectionId, sendInput],
  );

  // Ack-timeout sweep (#663): messages sent via handleSend/handleRetryMessage
  // that don't get an `ack` within ACK_TIMEOUT_MS get one automatic retry
  // (same message id), then flip to 'failed' if that also times out. Runs
  // more frequently than the timeout itself so the UI transition lands
  // close to the deadline rather than up to a full tick late.
  useEffect(() => {
    const ACK_SWEEP_INTERVAL_MS = 1000;
    const interval = setInterval(() => {
      const { pending, outcomes } = sweepTimeouts(pendingSendsRef.current, Date.now());
      if (outcomes.length === 0) return;
      pendingSendsRef.current = pending;

      for (const outcome of outcomes) {
        if (outcome.kind === 'failed') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === outcome.entry.messageId ? { ...m, state: 'failed' as const } : m,
            ),
          );
          continue;
        }

        // 'retry': resend with the SAME id. If the transport itself refuses
        // (e.g. disconnected by now), don't wait for a second timeout to
        // say so -- fail immediately, the outcome is already known.
        const { entry } = outcome;
        const resent = sendInput(
          entry.connectionId as ConnectionId,
          entry.sessionId as UUID,
          entry.content,
          entry.claudeSessionId as UUID | undefined,
          entry.messageId as UUID,
        );
        if (!resent) {
          pendingSendsRef.current = acknowledgeSend(
            pendingSendsRef.current,
            entry.messageId,
          ).pending;
          setMessages((prev) =>
            prev.map((m) => (m.id === entry.messageId ? { ...m, state: 'failed' as const } : m)),
          );
        }
      }
    }, ACK_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sendInput]);

  // Set the reply context for the current session: long-press on a
  // MessageBubble routes here. The InputArea shows a banner + clear
  // affordance derived from this state.
  const handleReply = useCallback(
    (message: UIMessage) => {
      if (!activeSessionId) return;
      setReplyContexts((prev) => {
        const next = new Map(prev);
        next.set(activeSessionId, { messageId: message.id, content: message.content });
        return next;
      });
    },
    [activeSessionId],
  );

  const handleClearReply = useCallback(() => {
    if (!activeSessionId) return;
    setReplyContexts((prev) => {
      if (!prev.has(activeSessionId)) return prev;
      const next = new Map(prev);
      next.delete(activeSessionId);
      return next;
    });
  }, [activeSessionId]);

  const handlePassphraseSubmit = useCallback(
    async (passphrase: string) => {
      try {
        const identity = await unlockStoredIdentity(passphrase);
        setUnlockedIdentity(identity);
        // Seed the connection manager's identity ref synchronously, even if
        // there is no pending connection yet (preflight path, #257). This
        // avoids a race where the just-unlocked identity hasn't been pushed
        // through useEffect by the time the WebSocket opens and gets
        // challenged.
        provideIdentity(passphraseConnectionId ?? ('' as ConnectionId), identity);
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
      // Persist connected URLs. Dedupe by normalized connectionId (#682) so
      // reconnecting to the same daemon through a different host alias
      // (e.g. '127.0.0.1' after a previously-stored 'localhost' URL) replaces
      // the old entry instead of accumulating a second string that resolves
      // to the same daemon.
      try {
        const stored = localStorage.getItem(LOCALSTORAGE_CONNECTIONS_KEY);
        const urls: string[] = stored ? JSON.parse(stored) : [];
        const deduped = dedupeConnectionUrls([...urls, url], parseConnectionId);
        localStorage.setItem(LOCALSTORAGE_CONNECTIONS_KEY, JSON.stringify(deduped));
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
    setReplyContexts(new Map());
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

  // Open the new-session sheet and (re)load recent directories (#638). The "+"
  // button routes here instead of a raw path prompt. Clears stale directories
  // and shows a loading state so an empty list isn't confused with "still
  // loading"; a fallback timer ends the loading state if no response arrives.
  const handleOpenNewSession = useCallback(() => {
    const conn = connections.find((c) => c.status === 'connected');
    if (!conn) return;
    setRecentDirectories([]);
    if (historyTimeoutRef.current) clearTimeout(historyTimeoutRef.current);
    const sent = requestSessionHistory(conn.connectionId);
    if (sent) {
      setHistoryLoading(true);
      historyTimeoutRef.current = setTimeout(() => {
        historyTimeoutRef.current = null;
        setHistoryLoading(false);
      }, 5000);
    } else {
      setHistoryLoading(false);
    }
    setShowNewSessionModal(true);
  }, [connections, requestSessionHistory]);

  // Start a session in the chosen directory. RecentProjects passes '' for the
  // home/cwd default; map that to undefined so the daemon uses its own default.
  // Close the sheet only when the request was actually sent.
  const handleStartSessionInDir = useCallback(
    (directory: string) => {
      const conn = connections.find((c) => c.status === 'connected');
      if (!conn) return;
      const sent = requestNewSession(conn.connectionId, directory.trim() || undefined);
      if (sent) setShowNewSessionModal(false);
    },
    [connections, requestNewSession],
  );

  // Surface a system message in a specific session's thread.
  const pushSessionSystemMessage = useCallback((sessionId: UUID, content: string) => {
    const msg: UIMessage = {
      id: generateId(),
      sessionId,
      connectionId: '' as ConnectionId,
      sender: 'system',
      content,
      timestamp: new Date().toISOString(),
      state: 'delivered',
      isEditing: false,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Stop (kill) a session: tears down the Claude process + its daemon (#637).
  // Persistent sessions never time out, so this is the explicit way to end one.
  const handleKillSession = useCallback(
    (sessionId: UUID, connectionId: ConnectionId, label?: string) => {
      const ok = window.confirm(
        `Exit ${label ? `"${label}"` : 'this session'}? Claude runs /exit and the session closes. You can resume it later from Recent.`,
      );
      if (!ok) return;
      const req = createKillSessionRequest(sessionId);
      const sent = cmSendMessage(connectionId, req);
      if (!sent) {
        pushSessionSystemMessage(sessionId, 'Cannot exit session: not connected to daemon.');
        return;
      }
      // Guard against a daemon that never replies (crash / WS drop): surface a
      // timeout scoped to this session if no kill_session_response lands.
      const timeoutId = setTimeout(() => {
        pendingKillsRef.current.delete(req.id);
        pushSessionSystemMessage(
          sessionId,
          'Exit session timed out; the daemon may be unreachable.',
        );
      }, 12_000);
      pendingKillsRef.current.set(req.id, { sessionId, timeoutId });
    },
    [cmSendMessage, pushSessionSystemMessage],
  );

  const handleEndSession = useCallback(() => {
    if (!activeSessionId) return;
    const connId = getActiveConnectionId();
    if (!connId) {
      pushSessionSystemMessage(
        activeSessionId,
        'Cannot exit session: session is no longer available.',
      );
      return;
    }
    handleKillSession(activeSessionId, connId);
  }, [activeSessionId, getActiveConnectionId, handleKillSession, pushSessionSystemMessage]);

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

  // Derive error from the most recently errored connection (if any). Used
  // for the ConnectModal's own connect-attempt feedback, which is
  // deliberately global -- it's about the connection the user just tried,
  // not about any particular chat session.
  const errorConnection = connections.find((c) => c.status === 'error');
  const error: string | null = errorConnection
    ? (errorConnection.error ?? `Connection error: ${errorConnection.connectionId}`)
    : null;

  // Chat-view banner (#682): scoped to the connection serving the ACTIVE
  // session, so an unrelated errored/duplicate connection can't pin a
  // "Connection error" banner (and, via the same session.connectionStatus
  // path the InputArea reads, disable the chat input) while the session on
  // screen is healthy and attached.
  const chatError = deriveConnectionBannerError(connections, activeSession?.connectionId ?? null);

  // Compute effective status for ConnectModal: show the latest connection's status
  const effectiveStatus = (() => {
    if (hasAnyConnected) return 'connected' as const;
    if (isAnyConnecting) return 'connecting' as const;
    if (connections.some((c) => c.status === 'reconnecting')) return 'reconnecting' as const;
    if (connections.some((c) => c.status === 'unreachable')) return 'unreachable' as const;
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
      onReconnect={reconnectConnection}
      onDisconnectAll={handleDisconnectAll}
      onOpenNewSession={handleOpenNewSession}
      onKillSession={handleKillSession}
      onSettings={() => setShowSettings(true)}
    />
  );

  // Compute total unread across non-active sessions
  const totalUnread = sessions.reduce(
    (sum, s) => sum + (s.id === activeSessionId ? 0 : s.unreadCount),
    0,
  );

  const sessionReplyContext = activeSessionId ? (replyContexts.get(activeSessionId) ?? null) : null;

  // Main content
  const main = activeSession ? (
    <ChatView
      session={activeSession}
      messages={sessionMessages}
      questions={sessionQuestions}
      error={chatError}
      onSend={handleSend}
      onAnswer={handleAnswer}
      onAuqAnswer={handleAuqAnswer}
      onCancelQuestion={handleCancelQuestion}
      onCancel={handleEscape}
      onReply={handleReply}
      onRetryMessage={handleRetryMessage}
      replyContext={sessionReplyContext}
      onClearReply={handleClearReply}
      onBack={handleBack}
      totalUnread={totalUnread}
      onCopyConversation={handleCopyConversation}
      onClearMessages={handleClearMessages}
      onExportText={handleExportText}
      onBulletExpand={handleBulletExpand}
      onDetach={handleDetach}
      onEndSession={activeSession?.source === 'daemon' ? handleEndSession : undefined}
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
        hasUnlockedIdentity={unlockedIdentity != null}
        serverFingerprint={passphraseServerFingerprint}
        onPassphraseSubmit={handlePassphraseSubmit}
      />

      <NewSessionModal
        open={showNewSessionModal}
        loading={historyLoading}
        onClose={() => setShowNewSessionModal(false)}
        directories={recentDirectories}
        onStartSession={handleStartSessionInDir}
      />
    </>
  );
}

export default App;
