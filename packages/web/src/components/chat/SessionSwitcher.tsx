/**
 * SessionSwitcher component.
 *
 * Slide-out drawer listing all connected sessions with status indicators,
 * unread badges, and question-pending markers. Tap a session to switch to it.
 */

import { formatRelativeTime } from '@/lib/format-time';
import type { UISession } from '@/types';
import type { UUID } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import { MessageCircleQuestion, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

interface SessionSwitcherProps {
  readonly sessions: readonly UISession[];
  readonly activeSessionId: UUID | null;
  readonly isOpen: boolean;
  readonly onSelectSession: (id: UUID) => void;
  readonly onClose: () => void;
}

/** Status dot color based on connection and agent status */
function StatusDot({
  session,
}: {
  readonly session: UISession;
}) {
  const { connectionStatus, status: agentStatus } = session;

  if (connectionStatus === 'error') {
    return <span className="inline-block size-2 shrink-0 rounded-full bg-[--color-error]" />;
  }
  if (connectionStatus === 'disconnected') {
    return <span className="inline-block size-2 shrink-0 rounded-full bg-[--color-text-muted]" />;
  }
  if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
    return (
      <span className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-[--color-warning]" />
    );
  }

  // Connected: show agent status
  switch (agentStatus) {
    case 'thinking':
    case 'executing':
      return (
        <span className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-[--color-success]" />
      );
    case 'waiting':
      return <span className="inline-block size-2 shrink-0 rounded-full bg-[--color-warning]" />;
    default:
      return <span className="inline-block size-2 shrink-0 rounded-full bg-[--color-success]" />;
  }
}

export function SessionSwitcher({
  sessions,
  activeSessionId,
  isOpen,
  onSelectSession,
  onClose,
}: SessionSwitcherProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  const handleSelect = useCallback(
    (id: UUID) => {
      onSelectSession(id);
      onClose();
    },
    [onSelectSession, onClose],
  );

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  // Count totals for header
  const totalUnread = sessions.reduce((sum, s) => sum + s.unreadCount, 0);
  const totalQuestions = sessions.filter((s) => s.questionPending).length;

  return (
    <>
      {/* Backdrop */}
      <div
        className={clsx(
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-200',
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={handleBackdropClick}
        onKeyDown={undefined}
        role="presentation"
      >
        {/* Drawer */}
        <div
          ref={drawerRef}
          className={clsx(
            'absolute inset-y-0 left-0 z-50 flex w-72 flex-col',
            'bg-[--color-surface] shadow-2xl',
            'transform transition-transform duration-250 ease-out',
            isOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {/* Drawer header */}
          <div className="flex items-center justify-between border-b border-[--color-border] px-4 py-3 safe-area-top">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-[--color-text]">Sessions</h2>
              {sessions.length > 0 && (
                <span className="rounded-full bg-[--color-surface-light] px-2 py-0.5 text-xs text-[--color-text-muted]">
                  {sessions.length}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1.5 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light]"
              aria-label="Close sessions drawer"
            >
              <X className="size-5" />
            </button>
          </div>

          {/* Summary bar */}
          {(totalUnread > 0 || totalQuestions > 0) && (
            <div className="flex items-center gap-3 border-b border-[--color-border] px-4 py-2 text-xs text-[--color-text-secondary]">
              {totalUnread > 0 && <span>{totalUnread} unread</span>}
              {totalQuestions > 0 && (
                <span className="flex items-center gap-1 text-[--color-warning]">
                  <MessageCircleQuestion className="size-3" />
                  {totalQuestions} pending
                </span>
              )}
            </div>
          )}

          {/* Session list */}
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-[--color-text-muted]">
                No sessions connected
              </div>
            ) : (
              <div className="py-1">
                {sessions.map((session) => (
                  <button
                    type="button"
                    key={session.id}
                    onClick={() => handleSelect(session.id)}
                    className={clsx(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                      'hover:bg-[--color-surface-light]',
                      session.id === activeSessionId &&
                        'bg-[--color-primary]/10 border-l-2 border-l-[--color-primary]',
                      session.id !== activeSessionId && 'border-l-2 border-l-transparent',
                    )}
                  >
                    {/* Status dot */}
                    <div className="mt-1.5">
                      <StatusDot session={session} />
                    </div>

                    {/* Session info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={clsx(
                            'truncate text-sm',
                            session.id === activeSessionId
                              ? 'font-semibold text-[--color-text]'
                              : 'font-medium text-[--color-text]',
                          )}
                        >
                          {session.name || 'Claude Session'}
                        </span>
                        <span className="shrink-0 text-xs text-[--color-text-muted]">
                          {formatRelativeTime(session.lastActiveAt)}
                        </span>
                      </div>

                      {/* Preview text */}
                      {session.preview && (
                        <p className="mt-0.5 truncate text-xs text-[--color-text-secondary]">
                          {session.preview}
                        </p>
                      )}
                    </div>

                    {/* Badges column */}
                    <div className="flex flex-col items-end gap-1">
                      {/* Question pending indicator */}
                      {session.questionPending && (
                        <span className="flex items-center justify-center rounded-full bg-[--color-warning] px-1.5 py-0.5">
                          <MessageCircleQuestion className="size-3 text-white" />
                        </span>
                      )}

                      {/* Unread count badge */}
                      {session.unreadCount > 0 && !session.questionPending && (
                        <span className="flex min-w-[1.25rem] items-center justify-center rounded-full bg-[--color-primary] px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {session.unreadCount > 99 ? '99+' : session.unreadCount}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
