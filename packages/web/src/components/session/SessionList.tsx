/**
 * SessionList component.
 *
 * Shows active sessions (from connected daemons) at the top.
 * "Show recent" expander reveals historical/transcript sessions below.
 * Each connection has a disconnect button. Reconnect shown when dropped.
 */

import type { ConnectionId, ConnectionState, UISession } from '@/types';
import type { UUID } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, Link2, Link2Off, Plus, RefreshCw, Settings, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SessionCard } from './SessionCard';

/** Status dot for connection state */
function StatusDot({ status }: { readonly status: ConnectionState['status'] }) {
  const colorClass =
    status === 'connected'
      ? 'bg-green-500'
      : status === 'connecting' || status === 'authenticating' || status === 'reconnecting'
        ? 'bg-yellow-500 animate-pulse'
        : status === 'error'
          ? 'bg-red-500'
          : 'bg-gray-400';

  return <span className={clsx('inline-block size-2 rounded-full', colorClass)} />;
}

interface SessionListProps {
  readonly sessions: readonly UISession[];
  readonly activeSessionId: UUID | null;
  readonly connections?: readonly ConnectionState[];
  readonly connectedHost?: string | null;
  readonly onSelectSession: (id: UUID) => void;
  readonly onResumeSession?: ((sessionId: string) => void) | undefined;
  readonly resumingSessionId?: string | null;
  readonly onConnect?: () => void;
  readonly onAddConnection?: () => void;
  readonly onDisconnect?: (connectionId: ConnectionId) => void;
  readonly onDisconnectAll?: () => void;
  readonly onSettings?: () => void;
  readonly className?: string;
}

export function SessionList({
  sessions,
  activeSessionId,
  connections = [],
  onSelectSession,
  onResumeSession,
  resumingSessionId,
  onConnect,
  onAddConnection,
  onDisconnect,
  onDisconnectAll,
  onSettings,
  className,
}: SessionListProps) {
  const [showRecent, setShowRecent] = useState(false);

  // Split sessions into active (from daemon, connected) and recent (transcript/disconnected)
  const { activeSessions, recentSessions } = useMemo(() => {
    const active: UISession[] = [];
    const recent: UISession[] = [];
    for (const session of sessions) {
      if (session.source === 'daemon' || session.connectionStatus === 'connected') {
        active.push(session);
      } else {
        recent.push(session);
      }
    }
    return { activeSessions: active, recentSessions: recent };
  }, [sessions]);

  const hasConnections = connections.length > 0;

  return (
    <div className={clsx('flex h-full flex-col bg-[var(--color-surface)]', className)}>
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 safe-area-top">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Remi</h1>
        <div className="flex items-center gap-1">
          {/* Connect (chain) or Disconnect (broken chain) */}
          {hasConnections ? (
            <>
              {(onAddConnection || onConnect) && (
                <button
                  onClick={onAddConnection ?? onConnect}
                  className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
                  aria-label="Add connection"
                >
                  <Plus className="size-5" />
                </button>
              )}
              {onDisconnectAll && (
                <button
                  onClick={onDisconnectAll}
                  className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-error)]"
                  aria-label="Disconnect all"
                >
                  <Link2Off className="size-5" />
                </button>
              )}
            </>
          ) : (
            onConnect && (
              <button
                onClick={onConnect}
                className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
                aria-label="Connect to daemon"
              >
                <Link2 className="size-5" />
              </button>
            )
          )}
          {onSettings && (
            <button
              onClick={onSettings}
              className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
              aria-label="Settings"
            >
              <Settings className="size-5" />
            </button>
          )}
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto safe-area-bottom">
        {/* No connections state */}
        {!hasConnections && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="mb-4 rounded-full bg-[var(--color-surface-light)] p-4">
              <Link2 className="size-8 text-[var(--color-text-muted)]" />
            </div>
            <h2 className="mb-1 font-medium text-[var(--color-text)]">No Active Sessions</h2>
            <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
              Connect to a host to discover Claude sessions
            </p>
            {onConnect && (
              <button
                onClick={onConnect}
                className="flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)]"
              >
                <Link2 className="size-4" />
                Connect
              </button>
            )}
          </div>
        )}

        {/* Connected state */}
        {hasConnections && (
          <div className="p-2">
            {/* Connection headers with disconnect */}
            {connections.map((conn) => (
              <div key={conn.connectionId} className="mb-1 flex items-center gap-2 px-2 py-1">
                <StatusDot status={conn.status} />
                <span className="text-xs font-medium text-[var(--color-text-muted)]">
                  {conn.connectionId}
                </span>
                {conn.status === 'error' && onConnect && (
                  <button
                    onClick={onConnect}
                    className="ml-auto flex items-center gap-1 text-xs text-[var(--color-warning)]"
                  >
                    <RefreshCw className="size-3" />
                    Reconnect
                  </button>
                )}
                {onDisconnect && conn.status !== 'error' && (
                  <button
                    onClick={() => onDisconnect(conn.connectionId)}
                    className="ml-auto flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)]"
                  >
                    <X className="size-3" />
                    Disconnect
                  </button>
                )}
              </div>
            ))}

            {/* Active sessions */}
            {activeSessions.length > 0 && (
              <div className="space-y-1">
                {activeSessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    onClick={() => onSelectSession(session.id)}
                    onResume={onResumeSession}
                    isResuming={resumingSessionId === session.id}
                  />
                ))}
              </div>
            )}

            {activeSessions.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-[var(--color-text-muted)]">
                No active sessions on connected daemons
              </p>
            )}

            {/* Recent sessions expander */}
            {recentSessions.length > 0 && (
              <div className="mt-3 border-t border-[var(--color-border)] pt-2">
                <button
                  onClick={() => setShowRecent(!showRecent)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                >
                  {showRecent ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  Recent sessions ({recentSessions.length})
                </button>
                {showRecent && (
                  <div className="space-y-1">
                    {recentSessions.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        isActive={session.id === activeSessionId}
                        onClick={() => onSelectSession(session.id)}
                        onResume={onResumeSession}
                        isResuming={resumingSessionId === session.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
