/**
 * ChatView component.
 *
 * Main chat interface combining header, messages, and input.
 */

import type { UIMessage, UIQuestion, UISession } from '@/types';
import { clsx } from 'clsx';
import { ChatHeader } from './ChatHeader';
import { InputArea } from './InputArea';
import { MessageList } from './MessageList';

interface ChatViewProps {
  readonly session: UISession;
  readonly messages: readonly UIMessage[];
  readonly question?: UIQuestion | null;
  readonly error?: string | null;
  readonly onSend: (message: string) => void;
  readonly onCancel?: () => void;
  readonly onRetry?: () => void;
  readonly onBack?: () => void;
  readonly onCopyConversation?: () => void;
  readonly onClearMessages?: () => void;
  readonly onExportText?: () => void;
  readonly onBulletExpand?: (bulletId: number) => void;
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
  onCopyConversation,
  onClearMessages,
  onExportText,
  onBulletExpand,
  className,
}: ChatViewProps) {
  const isAgentBusy = session.status === 'thinking' || session.status === 'executing';

  return (
    <div className={clsx('flex h-full flex-col bg-[--color-surface]', className)}>
      <ChatHeader
        session={session}
        onBack={onBack}
        onCopyConversation={onCopyConversation}
        onClearMessages={onClearMessages}
        onExportText={onExportText}
      />

      <MessageList
        messages={messages}
        agentStatus={session.status}
        error={error}
        onRetry={onRetry}
        onBulletExpand={onBulletExpand}
      />

      <InputArea
        onSend={onSend}
        onCancel={onCancel}
        question={question}
        isAgentBusy={isAgentBusy}
        disabled={session.connectionStatus !== 'connected'}
        placeholder={
          session.connectionStatus !== 'connected'
            ? 'Connecting...'
            : question
              ? 'Type your response...'
              : 'Type a message...'
        }
      />
    </div>
  );
}
