/**
 * SessionCard component.
 *
 * Displays a session preview in the session list.
 */

// Status icons are rendered via StatusDot, not used directly
import type { AgentStatus, ConnectionStatus, UISession } from '@/types';
import { clsx } from 'clsx';

interface SessionCardProps {
  readonly session: UISession;
  readonly isActive: boolean;
  readonly onClick: () => void;
}

/** Format relative time */
function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
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
    return <span className="size-2.5 rounded-full bg-[--color-error]" />;
  }
  if (connectionStatus === 'disconnected') {
    return <span className="size-2.5 rounded-full bg-[--color-text-muted]" />;
  }
  if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
    return <span className="size-2.5 animate-pulse rounded-full bg-[--color-warning]" />;
  }

  // Agent status when connected
  switch (agentStatus) {
    case 'thinking':
    case 'executing':
      return <span className="size-2.5 animate-pulse rounded-full bg-[--color-primary]" />;
    case 'waiting':
      return <span className="size-2.5 rounded-full bg-[--color-success]" />;
    case 'idle':
    default:
      return <span className="size-2.5 rounded-full bg-[--color-text-muted]" />;
  }
}

export function SessionCard({ session, isActive, onClick }: SessionCardProps) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full rounded-xl p-3 text-left transition-colors',
        'hover:bg-[--color-surface-light]',
        isActive && 'bg-[--color-surface-light] ring-1 ring-[--color-primary]/30',
      )}
    >
      <div className="flex items-start gap-3">
        {/* Status indicator */}
        <div className="mt-1.5">
          <StatusDot connectionStatus={session.connectionStatus} agentStatus={session.status} />
        </div>

        {/* Session info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-medium text-[--color-text]">
              {session.name || 'Claude Session'}
            </h3>
            <span className="shrink-0 text-xs text-[--color-text-muted]">
              {formatRelativeTime(session.lastActiveAt)}
            </span>
          </div>

          {/* Preview or status */}
          <p className="mt-0.5 truncate text-sm text-[--color-text-secondary]">
            {session.preview || getStatusText(session.status)}
          </p>

          {/* CWD if available */}
          {session.cwd && (
            <p className="mt-1 truncate text-xs text-[--color-text-muted]">{session.cwd}</p>
          )}
        </div>

        {/* Unread badge */}
        {session.unreadCount > 0 && (
          <span className="flex size-5 items-center justify-center rounded-full bg-[--color-primary] text-xs font-medium text-white">
            {session.unreadCount > 9 ? '9+' : session.unreadCount}
          </span>
        )}
      </div>
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
