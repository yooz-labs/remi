/**
 * ChatView component.
 *
 * Main chat interface combining header, messages, and input.
 * Supports two view modes: compact (plain text) and chat (parsed markdown/code).
 */

import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';
import { useKeyboard } from '@/hooks/useKeyboard';
import { hapticImpact } from '@/lib/haptics';
import type { ReplyContext } from '@/lib/reply-format';
import type { UIMessage, UIQuestion, UISession } from '@/types';
import { clsx } from 'clsx';
import { useCallback, useState } from 'react';
import { ChatHeader } from './ChatHeader';
import { InputArea } from './InputArea';
import { MessageList } from './MessageList';
import { QuestionCard } from './QuestionCard';

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
  /** Long-press on a message bubble fires this with the message; consumer
   *  records it as the active reply context for the session (#401). */
  readonly onReply?: (message: UIMessage) => void;
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
  onReply,
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
  showTimestamps = true,
  className,
}: ChatViewProps) {
  // The redesigned chat always uses the rich "chat" rendering (markdown, tool
  // grouping, pinned question cards). The legacy compact toggle was removed.
  const [viewMode] = useState<ViewMode>('chat');
  const { isVisible: keyboardVisible, height: keyboardHeight } = useKeyboard();
  const isAgentBusy = session.status === 'thinking' || session.status === 'executing';
  const isConnected = session.connectionStatus === 'connected';

  // In chat mode, render a stack of QuestionCards (main + any subagent prompts,
  // #437). In compact mode, fall back to the InputArea's quick responses for
  // the primary (first) prompt. A pending card needs a live connection; an
  // already-answered card stays briefly regardless.
  const questionList = questions ?? [];
  const primaryQuestion = questionList[0] ?? null;
  const chatCards =
    viewMode === 'chat'
      ? questionList.filter((q) => q.answeredWith != null || isConnected)
      : [];
  const inputQuestion = viewMode === 'chat' ? null : primaryQuestion;

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
      />

      {/* Pinned question stack -- the headline interaction. One card per
          concurrent prompt (main + any subagent prompts, #437). Kept above
          the scroll so the answer is always reachable without scrolling. */}
      {chatCards.length > 0 && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] pb-1">
          {chatCards.map((q) => (
            <QuestionCard key={q.id} question={q} onAnswer={(answer) => onAnswer(q, answer)} />
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
        viewMode={viewMode}
        keyboardVisible={keyboardVisible}
        showTimestamps={showTimestamps}
      />

      <InputArea
        onSend={onSend}
        onAnswer={(answer) => {
          if (primaryQuestion) onAnswer(primaryQuestion, answer);
        }}
        onCancel={onCancel}
        question={inputQuestion}
        isAgentBusy={isAgentBusy}
        disabled={!isConnected}
        replyContext={replyContext ?? null}
        onClearReply={onClearReply}
        // Session-scoped draft persistence so a half-typed message survives
        // app suspension on iOS (#226) and switching to a different session
        // doesn't leak the draft across.
        draftKey={`remi-draft-${session.id}`}
        placeholder={!isConnected ? 'Not connected' : 'Type a message...'}
      />
    </div>
  );
}
