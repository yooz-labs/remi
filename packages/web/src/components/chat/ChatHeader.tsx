/**
 * ChatHeader component.
 *
 * Displays session info, status, and actions.
 */

import type { AgentStatus, ConnectionStatus, UISession } from '@/types';

/** Strip hostname prefix from session name for display */
function formatSessionName(name: string): string {
  let display = name.replace(/^[^:]+:/, '');
  const slashIdx = display.indexOf('/');
  if (slashIdx >= 0 && display.length > slashIdx + 16) {
    display = `${display.slice(0, slashIdx + 16)}...`;
  }
  return display || name;
}
import { clsx } from 'clsx';
import {
  AlertCircle,
  ArrowLeft,
  Brain,
  Clock,
  Copy,
  FileText,
  Layers,
  Loader2,
  LogOut,
  MoreVertical,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewMode } from './ChatView';

interface ChatHeaderProps {
  readonly session: UISession;
  readonly viewMode?: ViewMode;
  readonly onViewModeChange?: (mode: ViewMode) => void;
  readonly onBack?: () => void;
  readonly onOpenSessions?: () => void;
  readonly sessionCount?: number;
  readonly totalUnread?: number;
  readonly onCopyConversation?: () => void;
  readonly onClearMessages?: () => void;
  readonly onExportText?: () => void;
  readonly onDetach?: () => void;
  readonly className?: string;
}

/** Connection status indicator */
function ConnectionIndicator({
  status,
}: {
  readonly status: ConnectionStatus;
}) {
  switch (status) {
    case 'connected':
      return <Wifi className="size-4 text-[var(--color-success)]" />;
    case 'connecting':
    case 'reconnecting':
      return <Loader2 className="size-4 animate-spin text-[var(--color-warning)]" />;
    case 'error':
      return <AlertCircle className="size-4 text-[var(--color-error)]" />;
    case 'disconnected':
    default:
      return <WifiOff className="size-4 text-[var(--color-text-muted)]" />;
  }
}

/** Agent status indicator */
function AgentStatusIndicator({ status }: { readonly status: AgentStatus }) {
  const statusConfig = {
    idle: {
      icon: Clock,
      label: 'Idle',
      color: 'text-[var(--color-text-muted)]',
    },
    thinking: {
      icon: Brain,
      label: 'Thinking...',
      color: 'text-[var(--color-warning)]',
    },
    executing: {
      icon: Terminal,
      label: 'Executing...',
      color: 'text-[var(--color-primary)]',
    },
    waiting: {
      icon: Clock,
      label: 'Waiting for input',
      color: 'text-[var(--color-success)]',
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={clsx('flex items-center gap-1 text-xs', config.color)}>
      <Icon
        className={clsx(
          'size-3',
          (status === 'thinking' || status === 'executing') && 'animate-pulse',
        )}
      />
      <span>{config.label}</span>
    </div>
  );
}

export function ChatHeader({
  session,
  onBack,
  onOpenSessions,
  sessionCount = 0,
  totalUnread = 0,
  onCopyConversation,
  onClearMessages,
  onExportText,
  onDetach,
  className,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const hasMenuActions = onCopyConversation || onClearMessages || onExportText || onDetach;

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen, closeMenu]);

  // Close menu on Escape key
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [menuOpen, closeMenu]);

  return (
    <header
      className={clsx(
        'flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3',
        'safe-area-top',
        className,
      )}
    >
      {/* Back button */}
      {onBack && (
        <button
          onClick={onBack}
          className="shrink-0 rounded-full p-2 text-[var(--color-primary)] transition-colors hover:bg-[var(--color-surface-light)]"
          aria-label="Go back"
        >
          <ArrowLeft className="size-5" />
        </button>
      )}

      {/* Sessions button */}
      {onOpenSessions && sessionCount > 1 && (
        <button
          onClick={onOpenSessions}
          className="relative rounded-full p-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
          aria-label="Open sessions"
        >
          <Layers className="size-5" />
          {totalUnread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-[1rem] items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[9px] font-bold leading-4 text-white">
              {totalUnread > 9 ? '9+' : totalUnread}
            </span>
          )}
        </button>
      )}

      {/* Session info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate font-medium text-[var(--color-text)]">
            {formatSessionName(session.name || 'Claude Session')}
          </h1>
          <ConnectionIndicator status={session.connectionStatus} />
        </div>
        <div className="flex items-center gap-2">
          <AgentStatusIndicator status={session.status} />
          {session.cwd && (
            <>
              <span className="text-[var(--color-text-muted)]">|</span>
              <span className="truncate text-xs text-[var(--color-text-muted)]">{session.cwd}</span>
            </>
          )}
        </div>
      </div>

      {/* Detach/Resume button */}
      {onDetach && (
        <button
          onClick={onDetach}
          className="rounded-full p-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-warning)]"
          aria-label="Detach session"
          title="Detach session"
        >
          <LogOut className="size-4" />
        </button>
      )}

      {/* More button with dropdown */}
      {hasMenuActions && (
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="rounded-full p-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
            aria-label="More options"
          >
            <MoreVertical className="size-5" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] py-1 shadow-lg">
              {onCopyConversation && (
                <button
                  onClick={() => {
                    onCopyConversation();
                    closeMenu();
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-light)]"
                >
                  <Copy className="size-4 text-[var(--color-text-muted)]" />
                  Copy conversation
                </button>
              )}
              {onExportText && (
                <button
                  onClick={() => {
                    onExportText();
                    closeMenu();
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-light)]"
                >
                  <FileText className="size-4 text-[var(--color-text-muted)]" />
                  Export as text
                </button>
              )}
              {onDetach && (
                <>
                  <div className="my-1 h-px bg-[var(--color-border)]" />
                  <button
                    onClick={() => {
                      onDetach();
                      closeMenu();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-sm text-[var(--color-warning)] transition-colors hover:bg-[var(--color-surface-light)]"
                  >
                    <LogOut className="size-4" />
                    Detach session
                  </button>
                </>
              )}
              {onClearMessages && (
                <>
                  <div className="my-1 h-px bg-[var(--color-border)]" />
                  <button
                    onClick={() => {
                      onClearMessages();
                      closeMenu();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-sm text-[var(--color-error)] transition-colors hover:bg-[var(--color-surface-light)]"
                  >
                    <Trash2 className="size-4" />
                    Clear messages
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
