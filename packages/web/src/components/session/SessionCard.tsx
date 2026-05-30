/**
 * SessionCard component.
 *
 * A single session row in the session list. Shows host/project, the branch,
 * a status pill, a two-line preview, and the time + unread badge. Sessions
 * that need the user (a pending question) get a lime attention stripe.
 */

import { StatusPill } from '@/components/StatusPill';
import { formatRelativeTime } from '@/lib/format-time';
import { sessionPillState, splitSessionName } from '@/lib/session-display';
import type { ConnectionId, UISession } from '@/types';
import { clsx } from 'clsx';
import { GitBranch, Link2Off, RotateCcw } from 'lucide-react';

interface SessionCardProps {
  readonly session: UISession;
  readonly isActive: boolean;
  readonly onClick: () => void;
  readonly onResume?: ((sessionId: string) => void) | undefined;
  readonly onDisconnect?: ((connectionId: ConnectionId) => void) | undefined;
  readonly isResuming?: boolean;
  /** When true, the bottom hairline divider is omitted (last row in a group). */
  readonly last?: boolean;
}

export function SessionCard({
  session,
  isActive,
  onClick,
  onResume,
  onDisconnect,
  isResuming,
  last = false,
}: SessionCardProps) {
  const { host, project, branch } = splitSessionName(session);
  const state = sessionPillState(session);
  const isAsking = state === 'asking';
  const isConnected = session.connectionStatus === 'connected';
  const showResume = onResume && session.canResume && session.connectionStatus === 'disconnected';
  const preview = session.preview || getStatusText(state);

  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'relative flex w-full items-start gap-3 py-3.5 pl-[22px] pr-[18px] text-left',
        'transition-colors active:bg-[var(--color-surface-light)]',
        isActive && 'bg-[var(--color-surface-light)]',
        !last && 'border-b border-[var(--color-border)]',
      )}
    >
      {/* Attention stripe for sessions that need the user */}
      {isAsking && (
        <span className="absolute inset-y-3.5 left-0 w-[3px] rounded-sm bg-[var(--color-primary)]" />
      )}

      <div className="min-w-0 flex-1">
        {/* host / project */}
        <div className="mb-1 flex items-center gap-2">
          <span className="truncate font-mono text-xs text-[var(--color-text-secondary)]">
            {host}
            <span className="text-[var(--color-text-muted)]">/</span>
            {project}
          </span>
        </div>

        {/* branch + status pill */}
        <div className="mb-1.5 flex min-w-0 items-center gap-2">
          <GitBranch className="size-3 shrink-0 text-[var(--color-text-muted)]" />
          <span className="truncate font-mono text-[13px] font-medium text-[var(--color-text)]">
            {branch || project}
          </span>
          <StatusPill state={state} className="shrink-0" />
        </div>

        {/* preview (two lines) */}
        <div className="line-clamp-2 text-[13px] leading-snug text-[var(--color-text-secondary)]">
          {isAsking && <span className="font-semibold text-[var(--color-primary)]">· </span>}
          {preview}
        </div>
      </div>

      {/* right column: time + unread + per-row actions */}
      <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
        <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
          {formatRelativeTime(session.lastActiveAt)}
        </span>
        {session.unreadCount > 0 && (
          <span
            className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] font-bold"
            style={{
              background: isAsking ? 'var(--color-primary)' : 'var(--color-surface-elevated)',
              color: isAsking ? 'var(--color-accent-ink)' : 'var(--color-text)',
            }}
          >
            {session.unreadCount > 9 ? '9+' : session.unreadCount}
          </span>
        )}
        {isConnected && onDisconnect && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDisconnect(session.connectionId);
            }}
            className="rounded-full p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-elevated)] hover:text-[var(--color-error)]"
            aria-label="Disconnect"
          >
            <Link2Off className="size-3.5" />
          </button>
        )}
        {showResume && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onResume(session.id);
            }}
            disabled={isResuming}
            className={clsx(
              'rounded-full p-1 transition-colors',
              isResuming
                ? 'cursor-wait text-[var(--color-text-muted)]'
                : 'text-[var(--color-primary)] hover:bg-[var(--color-accent-soft)]',
            )}
            aria-label="Resume"
          >
            <RotateCcw className={clsx('size-3.5', isResuming && 'animate-spin')} />
          </button>
        )}
      </div>
    </button>
  );
}

/** Fallback preview text when the session has no last-output preview. */
function getStatusText(state: ReturnType<typeof sessionPillState>): string {
  switch (state) {
    case 'asking':
      return 'Waiting for your answer';
    case 'working':
      return 'Working...';
    case 'connecting':
      return 'Connecting...';
    case 'offline':
      return 'Disconnected. Reattach to resume.';
    default:
      return 'Idle';
  }
}
