/**
 * SessionList component.
 *
 * Active sessions from connected daemons shown at top.
 * "Recent" expander for historical sessions below.
 * Connection controls: connect, disconnect per machine, disconnect all.
 */

import type { ConnectionId, ConnectionState, UISession } from '@/types';
import type { UUID } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Link2,
  Link2Off,
  Loader2,
  MessageSquarePlus,
  Settings,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { SessionCard } from './SessionCard';

interface SessionListProps {
  readonly sessions: readonly UISession[];
  readonly activeSessionId: UUID | null;
  readonly connections?: readonly ConnectionState[];
  readonly onSelectSession: (id: UUID) => void;
  readonly onResumeSession?: ((sessionId: string) => void) | undefined;
  readonly resumingSessionId?: string | null;
  readonly onConnect: () => void;
  readonly onAddConnection?: () => void;
  readonly onDisconnect: (connectionId: ConnectionId) => void;
  /** Retry a connection that became 'unreachable' (re-runs port discovery). */
  readonly onReconnect?: (connectionId: ConnectionId) => void;
  readonly onDisconnectAll: () => void;
  readonly onNewSession?: (directory?: string) => void;
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
  onDisconnect,
  onReconnect,
  onDisconnectAll,
  onNewSession,
  onSettings,
  className,
}: SessionListProps) {
  const [showRecent, setShowRecent] = useState(false);

  // Active = sessions owned by a running daemon (has a live port behind it).
  // Recent = transcript-discovered sessions with no live daemon.
  const { activeSessions, recentSessions } = useMemo(() => {
    const active: UISession[] = [];
    const recent: UISession[] = [];
    for (const session of sessions) {
      if (session.source === 'daemon') {
        active.push(session);
      } else {
        recent.push(session);
      }
    }
    return { activeSessions: active, recentSessions: recent };
  }, [sessions]);

  const hasConnections = connections.length > 0;
  // Derive display name from first connection (hostname without port)
  const hostLabel = hasConnections ? connections[0].connectionId.replace(/:\d+$/, '') : null;

  return (
    <div className={clsx('flex h-full flex-col bg-[var(--color-surface)]', className)}>
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 safe-area-top">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-[var(--color-text)]">Remi</h1>
          {hostLabel && (
            <span className="text-sm text-[var(--color-text-muted)]">on {hostLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {hasConnections ? (
            <button
              onClick={onDisconnectAll}
              className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-error)]"
              aria-label="Disconnect"
            >
              <Link2Off className="size-5" />
            </button>
          ) : (
            <button
              onClick={onConnect}
              className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
              aria-label="Connect"
            >
              <Link2 className="size-5" />
            </button>
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

      {/* Connection status banners */}
      {hasConnections &&
        connections.some(
          (c) => c.status === 'error' || c.status === 'reconnecting' || c.status === 'unreachable',
        ) && (
          <div className="border-b border-[var(--color-border)] px-3 py-2 space-y-1">
            {connections
              .filter(
                (c) =>
                  c.status === 'error' ||
                  c.status === 'reconnecting' ||
                  c.status === 'unreachable',
              )
              .map((c) => (
                <div
                  key={c.connectionId}
                  className={clsx(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
                    c.status === 'reconnecting'
                      ? 'bg-[var(--color-warning,#f59e0b)]/10 text-[var(--color-warning,#f59e0b)]'
                      : 'bg-[var(--color-error)]/10 text-[var(--color-error)]',
                  )}
                >
                  {c.status === 'reconnecting' ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <AlertTriangle className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">
                    {c.status === 'reconnecting'
                      ? `Reconnecting to ${c.connectionId}...`
                      : c.status === 'unreachable'
                        ? `No daemon found at ${c.connectionId.replace(/:\d+$/, '')}`
                        : c.error || `Connection error: ${c.connectionId}`}
                  </span>
                  {c.status === 'unreachable' && onReconnect && (
                    <button
                      type="button"
                      onClick={() => onReconnect(c.connectionId)}
                      className="ml-auto shrink-0 rounded-md bg-[var(--color-error)]/15 px-2 py-0.5 font-medium hover:bg-[var(--color-error)]/25"
                    >
                      Retry
                    </button>
                  )}
                </div>
              ))}
          </div>
        )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto safe-area-bottom">
        {!hasConnections ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 rounded-full bg-[var(--color-surface-light)] p-4">
              <Link2 className="size-8 text-[var(--color-text-muted)]" />
            </div>
            <h2 className="mb-1 font-medium text-[var(--color-text)]">Connect to your machine</h2>
            <p className="mb-5 text-sm text-[var(--color-text-secondary)]">
              Enter your hostname or IP to see active Claude sessions
            </p>
            <button
              onClick={onConnect}
              className="flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)]"
            >
              <Link2 className="size-4" />
              Connect
            </button>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {/* Active sessions */}
            {activeSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => onSelectSession(session.id)}
                onResume={onResumeSession}
                onDisconnect={onDisconnect}
                isResuming={resumingSessionId === session.id}
              />
            ))}

            {activeSessions.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-[var(--color-text-muted)]">
                No active sessions
              </p>
            )}

            {/* New Session button */}
            {onNewSession && (
              <button
                onClick={() => {
                  const dir = prompt('Project directory (leave empty for home):');
                  onNewSession(dir || undefined);
                }}
                className={clsx(
                  'flex w-full items-center gap-3 rounded-xl px-4 py-3 mt-1',
                  'border border-dashed border-[var(--color-border)]',
                  'text-sm text-[var(--color-text-secondary)]',
                  'transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
                )}
              >
                <MessageSquarePlus className="size-5" />
                New Session
              </button>
            )}

            {/* Recent sessions */}
            {recentSessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
                <button
                  onClick={() => setShowRecent(!showRecent)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--color-text-muted)]"
                >
                  {showRecent ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  Recent ({recentSessions.length})
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
