/**
 * ChatHeader component.
 *
 * Blurred top bar for the chat screen: back, optional sessions switcher,
 * host/project + branch + a status pill, plus a detach button and a "more"
 * dropdown (copy / export / detach / clear).
 */

import { StatusPill } from '@/components/StatusPill';
import { sessionPillState, splitSessionName } from '@/lib/session-display';
import type { UISession } from '@/types';
import { clsx } from 'clsx';
import {
  ChevronLeft,
  Copy,
  FileText,
  Layers,
  LogOut,
  MoreVertical,
  Square,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** "host:port" -> ":port" for the compact binding indicator. */
function extractDaemonPortLabel(connectionId: string): string {
  const colonIdx = connectionId.lastIndexOf(':');
  if (colonIdx === -1) return connectionId;
  return `:${connectionId.slice(colonIdx + 1)}`;
}

interface ChatHeaderProps {
  readonly session: UISession;
  readonly onBack?: () => void;
  readonly onOpenSessions?: () => void;
  readonly sessionCount?: number;
  readonly totalUnread?: number;
  readonly onCopyConversation?: () => void;
  readonly onClearMessages?: () => void;
  readonly onExportText?: () => void;
  readonly onDetach?: () => void;
  /** Stop (kill) the session entirely (#637). */
  readonly onEndSession?: () => void;
  readonly className?: string;
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
  onEndSession,
  className,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { host, project, branch } = splitSessionName(session);
  const state = sessionPillState(session);
  const hasMenuActions =
    onCopyConversation || onClearMessages || onExportText || onDetach || onEndSession;

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen, closeMenu]);

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
        'safe-area-top sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 pb-2.5',
        'bg-[var(--color-surface)]/90 backdrop-blur-xl',
        className,
      )}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-light)]"
          aria-label="Go back"
        >
          <ChevronLeft className="size-[22px]" />
        </button>
      )}

      {onOpenSessions && sessionCount > 1 && (
        <button
          type="button"
          onClick={onOpenSessions}
          className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
          aria-label="Open sessions"
        >
          <Layers className="size-5" />
          {totalUnread > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-4"
              style={{ background: 'var(--color-primary)', color: 'var(--color-accent-ink)' }}
            >
              {totalUnread > 9 ? '9+' : totalUnread}
            </span>
          )}
        </button>
      )}

      {/* Session identity */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">
          {host}
          <span>/</span>
          {project}
        </div>
        <div className="mt-px flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-base font-bold tracking-tight text-[var(--color-text)]">
            {branch || project}
          </span>
          <StatusPill state={state} className="shrink-0" />
        </div>
        {session.claudeSessionId && (
          <button
            type="button"
            className="mt-0.5 max-w-full truncate text-left font-mono text-[10px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
            title={
              session.transcriptPath
                ? `Claude session ${session.claudeSessionId}\nTranscript: ${session.transcriptPath}\nClick to copy path`
                : `Claude session ${session.claudeSessionId}`
            }
            onClick={() => {
              const value = session.transcriptPath ?? session.claudeSessionId;
              if (!value) return;
              // navigator.clipboard can be undefined in iOS WKWebView
              // non-secure contexts; permission denial and lost-focus
              // rejections also land in this catch. Best-effort copy.
              navigator.clipboard?.writeText(value).catch((err) => {
                console.warn('[ChatHeader] clipboard write failed:', err);
              });
            }}
          >
            {extractDaemonPortLabel(session.connectionId)}
            {' · '}
            {session.claudeSessionId.slice(0, 8)}
          </button>
        )}
      </div>

      {onDetach && (
        <button
          type="button"
          onClick={onDetach}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-warning)]"
          aria-label="Detach session"
          title="Detach session"
        >
          <LogOut className="size-[18px]" />
        </button>
      )}

      {hasMenuActions && (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-light)] text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-elevated)]"
            aria-label="More options"
          >
            <MoreVertical className="size-5" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] py-1 shadow-lg">
              {onCopyConversation && (
                <MenuItem
                  icon={<Copy className="size-4 text-[var(--color-text-muted)]" />}
                  label="Copy conversation"
                  onClick={() => {
                    onCopyConversation();
                    closeMenu();
                  }}
                />
              )}
              {onExportText && (
                <MenuItem
                  icon={<FileText className="size-4 text-[var(--color-text-muted)]" />}
                  label="Export as text"
                  onClick={() => {
                    onExportText();
                    closeMenu();
                  }}
                />
              )}
              {onDetach && (
                <>
                  <div className="my-1 h-px bg-[var(--color-border)]" />
                  <MenuItem
                    icon={<LogOut className="size-4" />}
                    label="Detach session"
                    tone="warning"
                    onClick={() => {
                      onDetach();
                      closeMenu();
                    }}
                  />
                </>
              )}
              {onEndSession && (
                <MenuItem
                  icon={<Square className="size-4" />}
                  label="Stop session"
                  tone="error"
                  onClick={() => {
                    onEndSession();
                    closeMenu();
                  }}
                />
              )}
              {onClearMessages && (
                <>
                  <div className="my-1 h-px bg-[var(--color-border)]" />
                  <MenuItem
                    icon={<Trash2 className="size-4" />}
                    label="Clear messages"
                    tone="error"
                    onClick={() => {
                      onClearMessages();
                      closeMenu();
                    }}
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  tone = 'default',
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly tone?: 'default' | 'warning' | 'error';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-[var(--color-surface-light)]',
        tone === 'default' && 'text-[var(--color-text)]',
        tone === 'warning' && 'text-[var(--color-warning)]',
        tone === 'error' && 'text-[var(--color-error)]',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
