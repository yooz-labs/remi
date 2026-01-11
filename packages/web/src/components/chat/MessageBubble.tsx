/**
 * MessageBubble component.
 *
 * Displays a single message with WhatsApp-style delivery status.
 */

import { clsx } from 'clsx';
import {
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Pencil,
  Terminal,
} from 'lucide-react';
import type { UIMessage } from '@/types';
import type { MessageState } from '@remi/shared/types.ts';

interface MessageBubbleProps {
  readonly message: UIMessage;
  readonly showTimestamp?: boolean;
}

/** Status icon based on message delivery state */
function StatusIcon({ state }: { readonly state: MessageState }) {
  switch (state) {
    case 'sending':
      return <Clock className="size-3.5 text-[--color-status-sending]" />;
    case 'sent':
      return <Check className="size-3.5 text-[--color-status-sent]" />;
    case 'delivered':
      return <CheckCheck className="size-3.5 text-[--color-status-delivered]" />;
    case 'read':
      return <CheckCheck className="size-3.5 text-[--color-status-read]" />;
    default:
      return null;
  }
}

/** Format timestamp for display */
function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MessageBubble({
  message,
  showTimestamp = true,
}: MessageBubbleProps) {
  const isUser = message.sender === 'user';
  const isSystem = message.sender === 'system';

  return (
    <div
      className={clsx(
        'flex w-full animate-[slide-up]',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={clsx(
          'max-w-[85%] rounded-2xl px-4 py-2.5',
          'transition-all duration-200',
          'shadow-sm border',
          // Bubble colors
          isUser && 'bg-[--color-bubble-user] text-white border-[--color-bubble-user]',
          !isUser && !isSystem && 'bg-[--color-bubble-assistant] border-[--color-border]',
          isSystem && 'bg-[--color-bubble-system] text-[--color-text-secondary] border-[--color-border]',
          // Bubble shape variations
          isUser && 'rounded-br-md',
          !isUser && 'rounded-bl-md',
          // Streaming indicator
          message.isStreaming && 'animate-pulse',
          // Editing indicator
          message.isEditing && 'border-[--color-primary] border-dashed',
        )}
      >
        {/* Tool indicator */}
        {message.tool && (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[--color-text-secondary]">
            <Terminal className="size-3" />
            <span>{message.tool}</span>
          </div>
        )}

        {/* Message content */}
        <div
          className={clsx(
            'whitespace-pre-wrap break-words text-sm leading-relaxed',
            isUser ? 'text-white' : 'text-[--color-text]',
          )}
        >
          {message.isStreaming ? message.streamedContent : message.content}
          {message.isStreaming && (
            <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-current" />
          )}
        </div>

        {/* Footer: timestamp and status */}
        <div
          className={clsx(
            'mt-1 flex items-center gap-1.5',
            isUser ? 'justify-end' : 'justify-start',
          )}
        >
          {/* Edited indicator */}
          {message.editedAt && (
            <span className="flex items-center gap-0.5 text-[10px] text-[--color-text-muted]">
              <Pencil className="size-2.5" />
              edited
            </span>
          )}

          {/* Timestamp */}
          {showTimestamp && (
            <span
              className={clsx(
                'text-[10px]',
                isUser ? 'text-white/70' : 'text-[--color-text-muted]',
              )}
            >
              {formatTime(message.timestamp)}
            </span>
          )}

          {/* Delivery status (only for user messages) */}
          {isUser && <StatusIcon state={message.state} />}
        </div>
      </div>
    </div>
  );
}

/** Error message variant */
export function ErrorBubble({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="flex w-full justify-center">
      <div className="flex items-center gap-2 rounded-full bg-[--color-error]/10 px-4 py-2 text-sm text-[--color-error]">
        <AlertCircle className="size-4" />
        <span>{message}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="ml-2 underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** Typing indicator */
export function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex gap-1 rounded-2xl rounded-bl-md bg-[--color-bubble-assistant] px-4 py-3">
        <span className="size-2 animate-bounce rounded-full bg-[--color-text-muted] [animation-delay:0ms]" />
        <span className="size-2 animate-bounce rounded-full bg-[--color-text-muted] [animation-delay:150ms]" />
        <span className="size-2 animate-bounce rounded-full bg-[--color-text-muted] [animation-delay:300ms]" />
      </div>
    </div>
  );
}
