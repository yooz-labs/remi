/**
 * ChatView component.
 *
 * Main chat interface combining header, messages, and input.
 * Supports two view modes: compact (plain text) and chat (parsed markdown/code).
 */

import { useKeyboard } from '@/hooks/useKeyboard';
import type { UIMessage, UIQuestion, UISession } from '@/types';
import { clsx } from 'clsx';
import { useState } from 'react';
import { ChatHeader } from './ChatHeader';
import { InputArea } from './InputArea';
import { MessageList } from './MessageList';
import { QuestionCard } from './QuestionCard';

/** View mode for the chat interface */
export type ViewMode = 'compact' | 'chat';

interface ChatViewProps {
  readonly session: UISession;
  readonly messages: readonly UIMessage[];
  readonly question?: UIQuestion | null;
  readonly error?: string | null;
  readonly onSend: (message: string) => void;
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
  question,
  error,
  onSend,
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
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const { isVisible: keyboardVisible, height: keyboardHeight } = useKeyboard();
  const isAgentBusy = session.status === 'thinking' || session.status === 'executing';
  const isConnected = session.connectionStatus === 'connected';

  // In chat mode, show QuestionCard for active questions (not free_text with no options).
  // In compact mode, fall back to the InputArea's built-in quick responses.
  const showQuestionCard = viewMode === 'chat' && question && !question.answeredWith && isConnected;
  const showAnsweredCard = viewMode === 'chat' && question?.answeredWith != null;

  // Hide InputArea's quick responses when QuestionCard is handling the question
  const inputQuestion = viewMode === 'chat' ? null : question;

  return (
    <div
      className={clsx(
        'flex h-full flex-col overflow-x-hidden bg-[var(--color-surface)]',
        className,
      )}
      style={{ paddingBottom: keyboardVisible ? `${keyboardHeight}px` : undefined }}
    >
      <ChatHeader
        session={session}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onBack={onBack}
        onOpenSessions={onOpenSessions}
        sessionCount={sessionCount}
        totalUnread={totalUnread}
        onCopyConversation={onCopyConversation}
        onClearMessages={onClearMessages}
        onExportText={onExportText}
        onDetach={onDetach}
      />

      <MessageList
        messages={messages}
        agentStatus={session.status}
        error={error}
        onRetry={onRetry}
        onBulletExpand={onBulletExpand}
        viewMode={viewMode}
        keyboardVisible={keyboardVisible}
        showTimestamps={showTimestamps}
      />

      {/* Question card in chat mode */}
      {(showQuestionCard || showAnsweredCard) && question && (
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          <QuestionCard question={question} onAnswer={onSend} />
        </div>
      )}

      <InputArea
        onSend={onSend}
        onCancel={onCancel}
        question={inputQuestion}
        isAgentBusy={isAgentBusy}
        disabled={!isConnected}
        // Session-scoped draft persistence so a half-typed message survives
        // app suspension on iOS (#226) and switching to a different session
        // doesn't leak the draft across.
        draftKey={`remi-draft-${session.id}`}
        placeholder={
          !isConnected
            ? 'Not connected'
            : question && !question.answeredWith
              ? 'Type your response...'
              : 'Type a message...'
        }
      />
    </div>
  );
}
