/**
 * SessionCard component.
 *
 * Displays a session preview in the session list.
 */

// Status icons are rendered via StatusDot, not used directly
import { formatRelativeTime } from '@/lib/format-time';
import type { AgentStatus, ConnectionStatus, UISession } from '@/types';
import type { ConnectionId } from '@/types';
import { clsx } from 'clsx';
import { Link2, Link2Off, MessageCircleQuestion, RotateCcw } from 'lucide-react';

/** Strip hostname prefix and truncate branch for display.
 *  "yahyas-mcm:remi/develop" -> "remi/develop"
 *  "remi/very-long-branch-name-here" -> "remi/very-long..."
 */
function formatSessionName(name: string): string {
  // Strip hostname: prefix (everything before the first colon that's followed by non-digit)
  let display = name.replace(/^[^:]+:/, '');
  // Truncate branch part if too long (keep folder, limit branch to 10 chars)
  const slashIdx = display.indexOf('/');
  if (slashIdx >= 0 && display.length > slashIdx + 10) {
    display = `${display.slice(0, slashIdx + 10)}...`;
  }
  return display || name;
}

interface SessionCardProps {
  readonly session: UISession;
  readonly isActive: boolean;
  readonly onClick: () => void;
  readonly onResume?: ((sessionId: string) => void) | undefined;
  readonly onDisconnect?: ((connectionId: ConnectionId) => void) | undefined;
  readonly isResuming?: boolean;
}

/** Status dot with color and animation */
function StatusDot({
  connectionStatus,
  agentStatus,
}: {
  readonly connectionStatus: ConnectionStatus;
  readonly agentStatus: AgentStatus;
}) {
  // Connection status takes priority
  if (connectionStatus === 'error') {
    return <span className="size-2.5 rounded-full bg-[var(--color-error)]" />;
  }
  if (connectionStatus === 'disconnected') {
    return <span className="size-2.5 rounded-full bg-[var(--color-text-muted)]" />;
  }
  if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
    return <span className="size-2.5 animate-pulse rounded-full bg-[var(--color-warning)]" />;
  }

  // Agent status when connected
  switch (agentStatus) {
    case 'thinking':
    case 'executing':
      return <span className="size-2.5 animate-pulse rounded-full bg-[var(--color-primary)]" />;
    case 'waiting':
      return <span className="size-2.5 rounded-full bg-[var(--color-success)]" />;
    case 'idle':
    default:
      return <span className="size-2.5 rounded-full bg-[var(--color-text-muted)]" />;
  }
}

export function SessionCard({
  session,
  isActive,
  onClick,
  onResume,
  onDisconnect,
  isResuming,
}: SessionCardProps) {
  const showResume = onResume && session.canResume && session.connectionStatus === 'disconnected';

  const isConnected = session.connectionStatus === 'connected';

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full rounded-xl p-3 text-left transition-colors',
        'hover:bg-[var(--color-surface-light)]',
        isActive && 'bg-[var(--color-surface-light)] ring-1 ring-[var(--color-primary)]/30',
      )}
    >
      {/* Title line: status dot, name, disconnect */}
      <div className="flex items-center gap-2">
        <StatusDot connectionStatus={session.connectionStatus} agentStatus={session.status} />
        <h3 className="flex-1 truncate font-medium text-[var(--color-text)]">
          {formatSessionName(session.name || 'Claude Session')}
        </h3>
        {/* Question and unread badges */}
        {session.questionPending && (
          <MessageCircleQuestion className="size-4 shrink-0 text-[var(--color-warning)]" />
        )}
        {session.unreadCount > 0 && (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-xs font-medium text-white">
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
            className="shrink-0 rounded-full p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-elevated)] hover:text-[var(--color-error)]"
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
              'shrink-0 rounded-full p-1 transition-colors',
              isResuming
                ? 'text-[var(--color-text-muted)] cursor-wait'
                : 'text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10',
            )}
            aria-label="Resume"
          >
            {isResuming ? (
              <RotateCcw className="size-3.5 animate-spin" />
            ) : (
              <Link2 className="size-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Preview line: status/preview + timestamp */}
      <div className="mt-1 flex items-center gap-2 pl-4.5">
        <p
          className={clsx(
            'flex-1 truncate text-sm',
            session.questionPending
              ? 'font-medium text-[var(--color-warning)]'
              : 'text-[var(--color-text-secondary)]',
          )}
        >
          {session.questionPending
            ? 'Needs your input'
            : session.preview || getStatusText(session.status)}
        </p>
        <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
          {formatRelativeTime(session.lastActiveAt)}
        </span>
      </div>

      {/* CWD if available */}
      {session.cwd && (
        <p className="mt-0.5 truncate pl-4.5 text-xs text-[var(--color-text-muted)]">
          {session.cwd}
        </p>
      )}
    </button>
  );
}

function getStatusText(status: AgentStatus): string {
  switch (status) {
    case 'thinking':
      return 'Thinking...';
    case 'executing':
      return 'Executing...';
    case 'waiting':
      return 'Waiting for input';
    case 'idle':
    default:
      return 'Idle';
  }
}
