/**
 * MessageList component.
 *
 * Displays a scrollable list of messages with auto-scroll.
 * In chat mode, tool messages are collapsed into inline summaries.
 * Shows a "jump to latest" button when scrolled up.
 */

import type { AgentStatus, UIMessage } from '@/types';
import { clsx } from 'clsx';
import { ArrowDown, MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewMode } from './ChatView';
import { ErrorBubble, MessageBubble, TypingIndicator } from './MessageBubble';

interface MessageListProps {
  readonly messages: readonly UIMessage[];
  readonly agentStatus: AgentStatus;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onBulletExpand?: (bulletId: number) => void;
  /** Long-press on a message bubble fires this with the message (#401). */
  readonly onReply?: (message: UIMessage) => void;
  /** Tap-to-retry a 'failed' message bubble (#663). */
  readonly onRetryMessage?: (message: UIMessage) => void;
  readonly viewMode?: ViewMode;
  readonly keyboardVisible?: boolean;
  readonly showTimestamps?: boolean;
  readonly className?: string;
}

/** Date separator between message groups */
function DateSeparator({ date }: { readonly date: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="h-px flex-1 bg-[var(--color-border)]" />
      <span className="text-xs text-[var(--color-text-muted)]">{date}</span>
      <div className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}

/** Collapsed inline summary for consecutive tool messages */
function ToolSummary({ tools }: { readonly tools: readonly UIMessage[] }) {
  const names = [...new Set(tools.map((t) => t.tool).filter(Boolean))];
  const label =
    names.length <= 3
      ? names.join(', ')
      : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;

  return (
    <div className="flex items-center gap-2 py-1 px-2">
      <div className="h-px flex-1 bg-[var(--color-border)]" />
      <span className="text-[10px] text-[var(--color-text-muted)] whitespace-nowrap">
        {tools.length} tool {tools.length === 1 ? 'call' : 'calls'}: {label}
      </span>
      <div className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}

/** Format date for separator */
function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

/** Check if two messages are on different days */
function isDifferentDay(msg1: UIMessage, msg2: UIMessage): boolean {
  const date1 = new Date(msg1.timestamp).toDateString();
  const date2 = new Date(msg2.timestamp).toDateString();
  return date1 !== date2;
}

/**
 * Group consecutive tool messages together for collapsed display.
 * When filterTools is true (chat view mode), consecutive tool messages are
 * batched into { type: 'tools' } groups. When false, all messages pass through.
 */
function groupMessages(
  messages: readonly UIMessage[],
  filterTools: boolean,
): Array<{ type: 'message'; message: UIMessage } | { type: 'tools'; messages: UIMessage[] }> {
  if (!filterTools) {
    return messages.map((m) => ({ type: 'message', message: m }));
  }

  const result: Array<
    { type: 'message'; message: UIMessage } | { type: 'tools'; messages: UIMessage[] }
  > = [];
  let toolBatch: UIMessage[] = [];

  for (const msg of messages) {
    const isTool = msg.tool && msg.sender !== 'user';
    if (isTool) {
      toolBatch.push(msg);
    } else {
      if (toolBatch.length > 0) {
        result.push({ type: 'tools', messages: toolBatch });
        toolBatch = [];
      }
      result.push({ type: 'message', message: msg });
    }
  }
  if (toolBatch.length > 0) {
    result.push({ type: 'tools', messages: toolBatch });
  }

  return result;
}

export function MessageList({
  messages,
  agentStatus,
  error,
  onRetry,
  onBulletExpand,
  onReply,
  onRetryMessage,
  viewMode = 'compact',
  keyboardVisible = false,
  showTimestamps = true,
  className,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  // Auto-scroll threshold (100px) is tighter than the jump-button threshold (300px)
  // to avoid flashing the button during small scrolls
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    shouldAutoScrollRef.current = isAtBottom;
    setShowJumpButton(!isAtBottom && scrollHeight - scrollTop - clientHeight > 300);
  }, []);

  // Scroll to bottom on mount (instant, no animation)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (shouldAutoScrollRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, agentStatus]);

  const jumpToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    shouldAutoScrollRef.current = true;
    setShowJumpButton(false);
  }, []);

  // Scroll to bottom when keyboard opens
  useEffect(() => {
    if (keyboardVisible) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [keyboardVisible]);

  // Show typing indicator when the agent is busy: thinking, executing, or
  // auto-approve evaluating a permission (#576). Kept in lockstep with
  // ChatView's isAgentBusy so the dots and the "Working" pill never disagree.
  const showTyping =
    agentStatus === 'thinking' || agentStatus === 'executing' || agentStatus === 'evaluating';

  // In chat mode, collapse tool messages into inline summaries
  const filterTools = viewMode === 'chat';
  const grouped = groupMessages(messages, filterTools);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={clsx('h-full overflow-y-auto px-4 py-2', 'scroll-smooth', className)}
      >
        {/* Empty state */}
        {messages.length === 0 && !error && (
          <div className="flex h-full flex-col items-center justify-center text-[var(--color-text-muted)]">
            <MessageSquare className="mb-3 size-10 opacity-40" />
            <p className="text-sm">Waiting for agent output</p>
          </div>
        )}

        {/* Messages */}
        <div className="space-y-2">
          {grouped.map((item, index) => {
            if (item.type === 'tools') {
              return <ToolSummary key={`tools-${index}`} tools={item.messages} />;
            }

            const { message } = item;
            // Walk backward past tool groups to find the previous real message for date separator
            let prevMessage: UIMessage | null = null;
            for (let i = index - 1; i >= 0; i--) {
              const prev = grouped[i];
              if (prev.type === 'message') {
                prevMessage = prev.message;
                break;
              }
            }
            const showDateSeparator =
              index === 0 || (prevMessage !== null && isDifferentDay(prevMessage, message));

            return (
              <div key={message.id}>
                {showDateSeparator && <DateSeparator date={formatDate(message.timestamp)} />}
                <MessageBubble
                  message={message}
                  onBulletExpand={onBulletExpand}
                  onReply={onReply}
                  onRetryMessage={onRetryMessage}
                  viewMode={viewMode}
                  showTimestamp={showTimestamps}
                />
              </div>
            );
          })}

          {/* Typing indicator */}
          {showTyping && <TypingIndicator />}

          {/* Error message */}
          {error && <ErrorBubble message={error} onRetry={onRetry} />}
        </div>

        {/* Scroll anchor */}
        <div ref={bottomRef} className="h-px" />
      </div>

      {/* Jump to latest button */}
      {showJumpButton && (
        <button
          onClick={jumpToLatest}
          className={clsx(
            'absolute bottom-4 left-1/2 -translate-x-1/2',
            'flex items-center gap-1.5 rounded-full px-4 py-2',
            'bg-[var(--color-surface-elevated)] border border-[var(--color-border)]',
            'text-xs font-medium text-[var(--color-text-secondary)]',
            'shadow-lg transition-all active:scale-95',
          )}
        >
          <ArrowDown className="size-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
