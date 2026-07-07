/**
 * ChatView component.
 *
 * Main chat interface combining header, messages, and input. Always renders in
 * the rich chat mode (markdown, tool grouping, pinned question stack).
 */

import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';
import { useKeyboard } from '@/hooks/useKeyboard';
import { hapticImpact } from '@/lib/haptics';
import type { ReplyContext } from '@/lib/reply-format';
import type { UIMessage, UIQuestion, UISession } from '@/types';
import { clsx } from 'clsx';
import { Lock } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ChatHeader } from './ChatHeader';
import { InputArea } from './InputArea';
import { MessageList } from './MessageList';
import { type AuqSelection, QuestionCard } from './QuestionCard';

/** View mode for the chat interface */
export type ViewMode = 'compact' | 'chat';

interface ChatViewProps {
  readonly session: UISession;
  readonly messages: readonly UIMessage[];
  /** Pending prompts for this session, oldest first. Multiple can be in flight
   *  (main agent + a subagent, #419/#437); rendered as a stack of cards. */
  readonly questions?: readonly UIQuestion[];
  readonly error?: string | null;
  /** Send a regular user input message. Reply context (when set) is wrapped
   *  into a markdown blockquote inside this callback's caller (#401). */
  readonly onSend: (message: string) => void;
  /** Answer a specific pending question. Routes through sendAnswer keyed by the
   *  question itself; decoupled from onSend so the bottom InputArea no longer
   *  hijacks input when a question is pending (#401). Non-optional so the
   *  decoupling can't be accidentally dropped back onto onSend. */
  readonly onAnswer: (question: UIQuestion, answer: string) => void;
  /** #627: submit a structured AskUserQuestion answer (per-sub-question selections);
   *  the daemon drives the interactive TUI. */
  readonly onAuqAnswer?: (question: UIQuestion, selections: AuqSelection[]) => void;
  /** #627: cancel/escape a pending question (the daemon sends Esc). The never-stuck
   *  floor, surfaced on every card. */
  readonly onCancelQuestion?: (question: UIQuestion) => void;
  /** Long-press on a message bubble fires this with the message; consumer
   *  records it as the active reply context for the session (#401). */
  readonly onReply?: (message: UIMessage) => void;
  /** Tap-to-retry a 'failed' message bubble (#663). */
  readonly onRetryMessage?: (message: UIMessage) => void;
  /** Active reply context for this session, if any (#401). */
  readonly replyContext?: ReplyContext | null;
  /** Clear the active reply context (X button on the InputArea banner). */
  readonly onClearReply?: () => void;
  readonly onCancel?: () => void;
  readonly onRetry?: () => void;
  readonly onBack?: () => void;
  readonly onOpenSessions?: () => void;
  readonly sessionCount?: number;
  readonly totalUnread?: number;
  readonly onCopyConversation?: () => void;
  readonly onClearMessages?: () => void;
  readonly onExportText?: () => void;
  readonly onBulletExpand?: (bulletId: number) => void;
  readonly onDetach?: () => void;
  /** Stop (kill) the active session (#637). */
  readonly onEndSession?: () => void;
  readonly showTimestamps?: boolean;
  readonly className?: string;
}

export function ChatView({
  session,
  messages,
  questions,
  error,
  onSend,
  onAnswer,
  onAuqAnswer,
  onCancelQuestion,
  onReply,
  onRetryMessage,
  replyContext,
  onClearReply,
  onCancel,
  onRetry,
  onBack,
  onOpenSessions,
  sessionCount,
  totalUnread,
  onCopyConversation,
  onClearMessages,
  onExportText,
  onBulletExpand,
  onDetach,
  onEndSession,
  showTimestamps = true,
  className,
}: ChatViewProps) {
  // The redesigned chat always uses the rich "chat" rendering (markdown, tool
  // grouping, pinned question cards). The legacy compact toggle was removed.
  const [viewMode] = useState<ViewMode>('chat');
  const { isVisible: keyboardVisible, height: keyboardHeight } = useKeyboard();
  // 'evaluating' (auto-approve deciding a permission, #576) counts as busy so
  // the in-chat typing indicator stays consistent with the "Working" pill.
  const isAgentBusy =
    session.status === 'thinking' ||
    session.status === 'executing' ||
    session.status === 'evaluating';
  const isConnected = session.connectionStatus === 'connected';
  // Read-only: this session's connection is queued behind another client
  // holding the exclusive write lock (#662/#663). Rare -- the daemon
  // FIFO-promotes on disconnect and same-device reconnects self-heal via
  // reclaim -- but must be visible instead of silently dropping input.
  const isQueued = session.attachState === 'queued';

  // Render a stack of QuestionCards (main + any subagent prompts, #437) pinned
  // at the top of the chat. A pending card needs a live connection; an
  // already-answered card stays briefly regardless. primaryQuestion routes the
  // InputArea's answer callback (the bottom input itself never shows the
  // quick-response chips now -- the pinned card owns answering).
  const questionList = questions ?? [];
  const primaryQuestion = questionList[0] ?? null;
  // An answered or resolved-elsewhere card (#652) stays briefly regardless of
  // connection so the user sees confirmation; a still-pending card needs a live
  // connection to be actionable.
  const chatCards = questionList.filter(
    (q) => q.answeredWith != null || q.resolvedReason != null || isConnected,
  );

  // iOS edge-swipe back (#411): rightward swipe from the left edge pops
  // the chat back to the session list. Mirrors the native iOS gesture.
  // Only active when we have an onBack consumer and a non-finger pointer
  // is rare on the touch screens this targets.
  const handleEdgeSwipeBack = useCallback(() => {
    hapticImpact('light');
    onBack?.();
  }, [onBack]);
  const swipeBackHandlers = useEdgeSwipeBack(handleEdgeSwipeBack);

  return (
    <div
      {...(onBack ? swipeBackHandlers : {})}
      className={clsx(
        'flex h-full flex-col overflow-x-hidden bg-[var(--color-surface)]',
        className,
      )}
      style={{ paddingBottom: keyboardVisible ? `${keyboardHeight}px` : undefined }}
    >
      <ChatHeader
        session={session}
        onBack={onBack}
        onOpenSessions={onOpenSessions}
        sessionCount={sessionCount}
        totalUnread={totalUnread}
        onCopyConversation={onCopyConversation}
        onClearMessages={onClearMessages}
        onExportText={onExportText}
        onDetach={onDetach}
        onEndSession={onEndSession}
      />

      {/* Read-only banner (#662/#663): another client holds the write lock.
          Rendered above the question stack so it's the first thing noticed. */}
      {isQueued && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-warning)]/10 px-4 py-2 text-xs text-[var(--color-warning)]">
          <Lock className="size-3.5 shrink-0" />
          <span>Read-only: another device is attached to this session. Waiting for control.</span>
        </div>
      )}

      {/* Pinned question stack -- the headline interaction. One card per
          concurrent prompt (main + any subagent prompts, #437). Kept above
          the scroll so the answer is always reachable without scrolling. */}
      {chatCards.length > 0 && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] pb-1">
          {chatCards.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              onAnswer={(answer) => onAnswer(q, answer)}
              {...(onAuqAnswer ? { onAuqAnswer: (sel: AuqSelection[]) => onAuqAnswer(q, sel) } : {})}
              {...(onCancelQuestion ? { onCancel: () => onCancelQuestion(q) } : {})}
            />
          ))}
        </div>
      )}

      <MessageList
        messages={messages}
        agentStatus={session.status}
        error={error}
        onRetry={onRetry}
        onBulletExpand={onBulletExpand}
        onReply={onReply}
        onRetryMessage={onRetryMessage}
        viewMode={viewMode}
        keyboardVisible={keyboardVisible}
        showTimestamps={showTimestamps}
      />

      {/* Subagent views are read-only monitoring (their id is an agentId, not a
          real daemon session), so there is no input to route (#499 phase 3). */}
      {!session.isSubagent && (
        <InputArea
          onSend={onSend}
          onAnswer={(answer) => {
            if (primaryQuestion) onAnswer(primaryQuestion, answer);
          }}
          onCancel={onCancel}
          question={null}
          isAgentBusy={isAgentBusy}
          disabled={!isConnected || isQueued}
          replyContext={replyContext ?? null}
          onClearReply={onClearReply}
          // Session-scoped draft persistence so a half-typed message survives
          // app suspension on iOS (#226) and switching to a different session
          // doesn't leak the draft across.
          draftKey={`remi-draft-${session.id}`}
          placeholder={!isConnected ? 'Not connected' : isQueued ? 'Read-only' : 'Type a message...'}
        />
      )}
    </div>
  );
}
