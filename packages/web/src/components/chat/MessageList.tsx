/**
 * MessageList component.
 *
 * Displays a scrollable list of messages with auto-scroll.
 */

import type { AgentStatus, UIMessage } from '@/types';
import type { ViewMode } from './ChatView';
import { clsx } from 'clsx';
import { MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { ErrorBubble, MessageBubble, TypingIndicator } from './MessageBubble';

interface MessageListProps {
  readonly messages: readonly UIMessage[];
  readonly agentStatus: AgentStatus;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onBulletExpand?: (bulletId: number) => void;
  readonly viewMode?: ViewMode;
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

export function MessageList({
  messages,
  agentStatus,
  error,
  onRetry,
  onBulletExpand,
  viewMode = 'compact',
  className,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  // Handle scroll to detect if user has scrolled up
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    shouldAutoScrollRef.current = isAtBottom;
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (shouldAutoScrollRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, agentStatus]);

  // Show typing indicator when agent is thinking/executing
  const showTyping = agentStatus === 'thinking' || agentStatus === 'executing';

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={clsx('flex-1 overflow-y-auto px-4 py-2', 'scroll-smooth', className)}
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
        {messages.map((message, index) => {
          const prevMessage = messages[index - 1];
          const showDateSeparator =
            index === 0 || (prevMessage !== undefined && isDifferentDay(prevMessage, message));

          return (
            <div key={message.id}>
              {showDateSeparator && <DateSeparator date={formatDate(message.timestamp)} />}
              <MessageBubble message={message} onBulletExpand={onBulletExpand} viewMode={viewMode} />
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
  );
}
