/**
 * MessageBubble component.
 *
 * Displays a single message with WhatsApp-style delivery status.
 */

import { useLongPress } from '@/hooks/useLongPress';
import { hapticImpact } from '@/lib/haptics';
import type { UIBullet, UIMessage } from '@/types';
import type { TranscriptContentBlock } from '@remi/shared/protocol.ts';
import type { MessageState } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  FileText,
  Loader2,
  Pencil,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { ChatMessage, InlineMarkdown } from './ChatMessage';
import type { ViewMode } from './ChatView';

interface MessageBubbleProps {
  readonly message: UIMessage;
  readonly showTimestamp?: boolean;
  readonly onBulletExpand?: (bulletId: number) => void;
  /** Long-press the bubble to set this message as the reply context (#401). */
  readonly onReply?: (message: UIMessage) => void;
  readonly viewMode?: ViewMode;
}

/** Status icon based on message delivery state */
function StatusIcon({ state }: { readonly state: MessageState }) {
  switch (state) {
    case 'sending':
      return <Clock className="size-3.5 text-[var(--color-status-sending)]" />;
    case 'sent':
      return <Check className="size-3.5 text-[var(--color-status-sent)]" />;
    case 'delivered':
      return <CheckCheck className="size-3.5 text-[var(--color-status-delivered)]" />;
    case 'read':
      return <CheckCheck className="size-3.5 text-[var(--color-status-read)]" />;
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
  isUser = false,
  onExpand,
}: {
  readonly bullet: UIBullet;
  readonly isUser?: boolean;
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
      <InlineMarkdown content={displayContent} isUser={isUser} />

      {/* Truncation indicator */}
      {bullet.isTruncated && !bullet.fullContent && (
        <button
          onClick={handleExpand}
          disabled={bullet.isExpanding}
          className={clsx(
            'mt-1 flex items-center gap-1 text-xs',
            'text-[var(--color-primary)] hover:text-[var(--color-primary-hover)]',
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

/** Tool use/result chip displayed inline in messages */
function ToolChip({ block }: { readonly block: TranscriptContentBlock }) {
  const [expanded, setExpanded] = useState(false);

  if (block.type === 'tool_use') {
    const name = block.toolName || 'Tool';
    let summary = name;
    if (block.toolInput) {
      try {
        const input = JSON.parse(block.toolInput);
        if (name === 'Bash' || name === 'bash') {
          summary = `$ ${input.command?.slice(0, 60) || '...'}`;
        } else if (name === 'Read' || name === 'read_file') {
          summary = `Read ${input.file_path?.split('/').pop() || '...'}`;
        } else if (name === 'Write' || name === 'write_file') {
          summary = `Write ${input.file_path?.split('/').pop() || '...'}`;
        } else if (name === 'Edit' || name === 'edit_file') {
          summary = `Edit ${input.file_path?.split('/').pop() || '...'}`;
        } else if (name === 'Glob' || name === 'glob_search') {
          summary = `Search ${input.pattern || '...'}`;
        } else if (name === 'Grep' || name === 'grep_search') {
          summary = `Grep ${input.pattern || '...'}`;
        }
      } catch {
        /* use plain name */
      }
    }
    return (
      <div className="my-1 flex items-center gap-1.5 rounded-md bg-[var(--color-surface-light)] px-2 py-1 text-xs text-[var(--color-text-muted)]">
        <Wrench className="size-3 shrink-0" />
        <span className="truncate">{summary}</span>
      </div>
    );
  }

  if (block.type === 'tool_result') {
    if (!block.toolOutput && !block.isError) return null;
    return (
      <div className="my-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className={clsx(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
            block.isError
              ? 'bg-[var(--color-error)]/10 text-[var(--color-error)]'
              : 'bg-[var(--color-surface-light)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-elevated)]',
          )}
        >
          {block.isError ? <AlertCircle className="size-3" /> : <FileText className="size-3" />}
          <span>
            {block.isError ? 'Error' : 'Output'}
            {block.toolName ? `: ${block.toolName}` : ''}
          </span>
          <ChevronDown className={clsx('size-3 transition-transform', expanded && 'rotate-180')} />
        </button>
        {expanded && block.toolOutput && (
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text-secondary)]">
            {block.toolOutput}
          </pre>
        )}
      </div>
    );
  }

  return null;
}

/** Renders the inner content of a message bubble based on mode and content type */
function MessageContent({
  message,
  enhanced,
  hasBullets,
  isUser,
  onBulletExpand,
}: {
  readonly message: UIMessage;
  readonly enhanced: boolean;
  readonly hasBullets: boolean;
  readonly isUser: boolean;
  readonly onBulletExpand?: (bulletId: number) => void;
}) {
  if (message.isStreaming) {
    // Use raw text during streaming to avoid re-parsing markdown on every chunk
    return (
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
        {message.streamedContent}
        <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-current" />
      </div>
    );
  }

  if (hasBullets) {
    return (
      <div className="space-y-2">
        {message.bullets!.map((bullet) => (
          <BulletItem
            key={bullet.bulletId}
            bullet={bullet}
            isUser={isUser}
            onExpand={onBulletExpand}
          />
        ))}
      </div>
    );
  }

  // Content blocks: render text + tool chips
  const hasContentBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const toolBlocks = hasContentBlocks
    ? message.contentBlocks!.filter((b) => b.type === 'tool_use' || b.type === 'tool_result')
    : [];

  if (enhanced) {
    return (
      <>
        {message.content && <ChatMessage content={message.content} isUser={isUser} />}
        {toolBlocks.length > 0 && (
          <div className="mt-1">
            {toolBlocks.map((block, i) => (
              <ToolChip key={`${block.type}-${block.toolUseId || i}`} block={block} />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {message.content && <InlineMarkdown content={message.content} isUser={isUser} />}
      {toolBlocks.length > 0 && (
        <div className="mt-1">
          {toolBlocks.map((block, i) => (
            <ToolChip key={`${block.type}-${block.toolUseId || i}`} block={block} />
          ))}
        </div>
      )}
    </>
  );
}

export function MessageBubble({
  message,
  showTimestamp = true,
  onBulletExpand,
  onReply,
  viewMode = 'compact',
}: MessageBubbleProps) {
  const isUser = message.sender === 'user';
  const isSystem = message.sender === 'system';
  const enhanced = viewMode === 'chat';

  // Use bullets if available, otherwise fall back to raw content
  const hasBullets = message.bullets && message.bullets.length > 0;

  // Long-press to enter "reply to this message" mode (#401). System
  // messages and tool/streaming bubbles are not reply-able since there
  // is no useful quoted context for the agent.
  const isReplyable = !!onReply && !isSystem && !message.isStreaming && !message.tool;
  const longPressHandlers = useLongPress(
    () => {
      if (onReply) onReply(message);
    },
    {
      delayMs: 500,
      onTrigger: () => {
        hapticImpact('medium');
      },
    },
  );

  // In enhanced chat mode, tool messages render as collapsible cards (not bubbles)
  if (enhanced && message.tool && !isUser) {
    return (
      <div className="flex w-full animate-[slide-up] justify-start">
        <div className="w-full max-w-[95%] overflow-hidden">
          <ChatMessage content={message.content} toolName={message.tool} />
          {/* Footer */}
          <div className="mt-0.5 flex items-center gap-1.5 px-1">
            {showTimestamp && (
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {formatTime(message.timestamp)}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Sender label for enhanced chat mode
  let senderLabel: string | null = null;
  if (enhanced) {
    if (isUser) senderLabel = 'You';
    else if (!isSystem) senderLabel = 'Claude';
  }

  return (
    <div
      className={clsx('flex w-full animate-[slide-up]', isUser ? 'justify-end' : 'justify-start')}
    >
      <div
        {...(isReplyable ? longPressHandlers : {})}
        className={clsx(
          'rounded-2xl px-4 py-2.5 overflow-hidden',
          'transition-all duration-200',
          'shadow-sm border',
          // Width: wider in enhanced mode for better code block display
          enhanced ? 'max-w-[95%]' : 'max-w-[85%]',
          // Bubble colors
          isUser && 'bg-[var(--color-bubble-user)] text-white border-[var(--color-bubble-user)]',
          !isUser && !isSystem && 'bg-[var(--color-bubble-assistant)] border-[var(--color-border)]',
          isSystem &&
            'bg-[var(--color-bubble-system)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
          // Bubble shape variations
          isUser && 'rounded-br-md',
          !isUser && 'rounded-bl-md',
          // Streaming indicator
          message.isStreaming && 'animate-pulse',
          // Editing indicator
          message.isEditing && 'border-[var(--color-primary)] border-dashed',
          // Long-press affordance hint on touch devices only.
          // `select-none` would break copy-paste on desktop; the
          // `pointer-coarse:` variant scopes the rule to touch input
          // (Tailwind's `coarse` media query). `touch-manipulation`
          // suppresses iOS's tap-delay regardless of pointer type.
          isReplyable && 'pointer-coarse:select-none touch-manipulation',
        )}
      >
        {/* Sender label in enhanced mode */}
        {senderLabel && (
          <div className="mb-1 text-[11px] font-semibold text-[var(--color-text-muted)]">
            {senderLabel}
          </div>
        )}

        {/* Tool indicator (compact mode only; enhanced mode uses ToolUseCard) */}
        {!enhanced && message.tool && (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
            <Terminal className="size-3" />
            <span>{message.tool}</span>
          </div>
        )}

        {/* Message content */}
        <div className={clsx(isUser ? 'text-white' : 'text-[var(--color-text)]')}>
          <MessageContent
            message={message}
            enhanced={enhanced}
            hasBullets={!!hasBullets}
            isUser={isUser}
            onBulletExpand={onBulletExpand}
          />
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
            <span className="flex items-center gap-0.5 text-[10px] text-[var(--color-text-muted)]">
              <Pencil className="size-2.5" />
              edited
            </span>
          )}

          {/* Timestamp */}
          {showTimestamp && (
            <span
              className={clsx(
                'text-[10px]',
                isUser ? 'text-white/70' : 'text-[var(--color-text-muted)]',
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
      <div className="flex items-center gap-2 rounded-full bg-[var(--color-error)]/10 px-4 py-2 text-sm text-[var(--color-error)]">
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
      <div className="flex gap-1 rounded-2xl rounded-bl-md bg-[var(--color-bubble-assistant)] px-4 py-3">
        <span className="size-2 animate-bounce rounded-full bg-[var(--color-text-muted)] [animation-delay:0ms]" />
        <span className="size-2 animate-bounce rounded-full bg-[var(--color-text-muted)] [animation-delay:150ms]" />
        <span className="size-2 animate-bounce rounded-full bg-[var(--color-text-muted)] [animation-delay:300ms]" />
      </div>
    </div>
  );
}
