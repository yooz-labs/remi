/**
 * ChatView component.
 *
 * Main chat interface combining header, messages, and input.
 * Supports two view modes: compact (plain text) and chat (parsed markdown/code).
 */

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
  className,
}: ChatViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const isAgentBusy = session.status === 'thinking' || session.status === 'executing';
  const isConnected = session.connectionStatus === 'connected';

  // In chat mode, show QuestionCard for active questions (not free_text with no options).
  // In compact mode, fall back to the InputArea's built-in quick responses.
  const showQuestionCard = viewMode === 'chat' && question && !question.answeredWith && isConnected;
  const showAnsweredCard = viewMode === 'chat' && question?.answeredWith != null;

  // Hide InputArea's quick responses when QuestionCard is handling the question
  const inputQuestion = viewMode === 'chat' ? null : question;

  return (
    <div className={clsx('flex h-full flex-col overflow-x-hidden bg-[var(--color-surface)]', className)}>
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
        placeholder={
          !isConnected
            ? 'Connecting...'
            : question && !question.answeredWith
              ? 'Type your response...'
              : 'Type a message...'
        }
      />
    </div>
  );
}
