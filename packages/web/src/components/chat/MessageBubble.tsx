/**
 * MessageBubble component.
 *
 * Displays a single message with WhatsApp-style delivery status.
 */

import type { UIBullet, UIMessage } from '@/types';
import type { ViewMode } from './ChatView';
import type { MessageState } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Loader2,
  Pencil,
  Terminal,
} from 'lucide-react';
import { ChatMessage } from './ChatMessage';

interface MessageBubbleProps {
  readonly message: UIMessage;
  readonly showTimestamp?: boolean;
  readonly onBulletExpand?: (bulletId: number) => void;
  readonly viewMode?: ViewMode;
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

/** Single bullet item with optional truncation indicator */
function BulletItem({
  bullet,
  onExpand,
}: {
  readonly bullet: UIBullet;
  readonly onExpand?: (bulletId: number) => void;
}) {
  const handleExpand = () => {
    if (bullet.isTruncated && !bullet.fullContent && onExpand) {
      onExpand(bullet.bulletId);
    }
  };

  // Use fullContent if available, otherwise use (possibly truncated) content
  const displayContent = bullet.fullContent || bullet.content;

  return (
    <div className="group relative">
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{displayContent}</div>

      {/* Truncation indicator */}
      {bullet.isTruncated && !bullet.fullContent && (
        <button
          onClick={handleExpand}
          disabled={bullet.isExpanding}
          className={clsx(
            'mt-1 flex items-center gap-1 text-xs',
            'text-[--color-primary] hover:text-[--color-primary-hover]',
            'transition-colors duration-150',
            bullet.isExpanding && 'opacity-50 cursor-wait',
          )}
        >
          {bullet.isExpanding ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span>Loading...</span>
            </>
          ) : (
            <>
              <ChevronDown className="size-3" />
              <span>Show more ({bullet.fullLength} chars)</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function MessageBubble({
  message,
  showTimestamp = true,
  onBulletExpand,
  viewMode = 'compact',
}: MessageBubbleProps) {
  const isUser = message.sender === 'user';
  const isSystem = message.sender === 'system';
  const enhanced = viewMode === 'chat';

  // Use bullets if available, otherwise fall back to raw content
  const hasBullets = message.bullets && message.bullets.length > 0;

  // In enhanced chat mode, tool messages render as collapsible cards (not bubbles)
  if (enhanced && message.tool && !isUser) {
    return (
      <div className="flex w-full animate-[slide-up] justify-start">
        <div className="w-full max-w-[95%]">
          <ChatMessage content={message.content} toolName={message.tool} />
          {/* Footer */}
          <div className="mt-0.5 flex items-center gap-1.5 px-1">
            {showTimestamp && (
              <span className="text-[10px] text-[--color-text-muted]">
                {formatTime(message.timestamp)}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Sender label for enhanced chat mode
  const senderLabel = enhanced && !isUser && !isSystem
    ? 'Claude'
    : enhanced && isUser
      ? 'You'
      : null;

  return (
    <div
      className={clsx('flex w-full animate-[slide-up]', isUser ? 'justify-end' : 'justify-start')}
    >
      <div
        className={clsx(
          'rounded-2xl px-4 py-2.5',
          'transition-all duration-200',
          'shadow-sm border',
          // Width: wider in enhanced mode for better code block display
          enhanced ? 'max-w-[95%]' : 'max-w-[85%]',
          // Bubble colors
          isUser && 'bg-[--color-bubble-user] text-white border-[--color-bubble-user]',
          !isUser && !isSystem && 'bg-[--color-bubble-assistant] border-[--color-border]',
          isSystem &&
            'bg-[--color-bubble-system] text-[--color-text-secondary] border-[--color-border]',
          // Bubble shape variations
          isUser && 'rounded-br-md',
          !isUser && 'rounded-bl-md',
          // Streaming indicator
          message.isStreaming && 'animate-pulse',
          // Editing indicator
          message.isEditing && 'border-[--color-primary] border-dashed',
        )}
      >
        {/* Sender label in enhanced mode */}
        {senderLabel && (
          <div className="mb-1 text-[11px] font-semibold text-[--color-text-muted]">
            {senderLabel}
          </div>
        )}

        {/* Tool indicator (compact mode only; enhanced mode uses ToolUseCard) */}
        {!enhanced && message.tool && (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[--color-text-secondary]">
            <Terminal className="size-3" />
            <span>{message.tool}</span>
          </div>
        )}

        {/* Message content */}
        <div className={clsx(isUser ? 'text-white' : 'text-[--color-text]')}>
          {message.isStreaming ? (
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {message.streamedContent}
              <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-current" />
            </div>
          ) : enhanced ? (
            /* Enhanced chat mode: parsed content with code blocks and markdown */
            hasBullets ? (
              <div className="space-y-2">
                {message.bullets!.map((bullet) => (
                  <BulletItem key={bullet.bulletId} bullet={bullet} onExpand={onBulletExpand} />
                ))}
              </div>
            ) : (
              <ChatMessage content={message.content} isUser={isUser} />
            )
          ) : hasBullets ? (
            <div className="space-y-2">
              {message.bullets!.map((bullet) => (
                <BulletItem key={bullet.bulletId} bullet={bullet} onExpand={onBulletExpand} />
              ))}
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {message.content}
            </div>
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
