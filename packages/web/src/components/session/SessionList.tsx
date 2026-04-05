/**
 * SessionList component.
 *
 * Displays sessions grouped by daemon connection when multiple connections
 * are active. Shows a flat list for single connections.
 */

import type { ConnectionId, ConnectionState, UISession } from '@/types';
import type { UUID } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import { Link2, Plus, Settings } from 'lucide-react';
import { useMemo } from 'react';
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
  readonly onSettings?: () => void;
  readonly className?: string;
}

export function SessionList({
  sessions,
  activeSessionId,
  connections = [],
  connectedHost,
  onSelectSession,
  onResumeSession,
  resumingSessionId,
  onConnect,
  onAddConnection,
  onDisconnect,
  onSettings,
  className,
}: SessionListProps) {
  const isMultiConnection = connections.length > 1;

  // Group sessions by connectionId, ensuring ALL connections appear
  const grouped = useMemo(() => {
    if (!isMultiConnection) return null;
    const groups = new Map<ConnectionId, UISession[]>();
    // Initialize with all connections so empty ones still show headers
    for (const conn of connections) {
      groups.set(conn.connectionId, []);
    }
    for (const session of sessions) {
      const key = session.connectionId;
      const group = groups.get(key) ?? [];
      group.push(session);
      groups.set(key, group);
    }
    return groups;
  }, [sessions, connections, isMultiConnection]);

  return (
    <div className={clsx('flex h-full flex-col bg-[var(--color-surface)]', className)}>
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 safe-area-top">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">
          Remi
          {!isMultiConnection && connectedHost ? (
            <span className="font-normal text-[var(--color-text-muted)]"> on {connectedHost}</span>
          ) : null}
        </h1>
        <div className="flex items-center gap-1">
          {connections.length > 0 && (onAddConnection || onConnect) && (
            <button
              onClick={onAddConnection ?? onConnect}
              className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
              aria-label="Add connection"
            >
              <Plus className="size-5" />
            </button>
          )}
          {connections.length === 0 && onConnect && (
            <button
              onClick={onConnect}
              className="rounded-full p-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
              aria-label="Connect to daemon"
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

      <div className="flex-1 overflow-y-auto p-2 safe-area-bottom">
        {sessions.length === 0 ? (
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
        ) : isMultiConnection && grouped ? (
          // Multi-connection: grouped by daemon
          <div className="space-y-3">
            {Array.from(grouped.entries()).map(([connId, groupSessions]) => {
              const conn = connections.find((c) => c.connectionId === connId);
              return (
                <div key={connId}>
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <StatusDot status={conn?.status ?? 'disconnected'} />
                    <span className="text-xs font-medium text-[var(--color-text-muted)]">
                      {connId}
                    </span>
                    {onDisconnect && conn && (
                      <button
                        onClick={() => onDisconnect(conn.connectionId)}
                        className="ml-auto text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)]"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {groupSessions.map((session) => (
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
                </div>
              );
            })}
          </div>
        ) : (
          // Single connection: flat list
          <div className="space-y-1">
            {sessions.map((session) => (
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
    </div>
  );
}
