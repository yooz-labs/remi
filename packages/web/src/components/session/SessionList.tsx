/**
 * SessionList component.
 *
 * Displays the daemon's session (one session per daemon).
 */

import type { UISession } from '@/types';
import type { UUID } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import { Link2, Settings } from 'lucide-react';
import { SessionCard } from './SessionCard';

interface SessionListProps {
  readonly sessions: readonly UISession[];
  readonly activeSessionId: UUID | null;
  readonly connectedHost?: string | null;
  readonly onSelectSession: (id: UUID) => void;
  readonly onResumeSession?: ((sessionId: string) => void) | undefined;
  readonly resumingSessionId?: string | null;
  readonly onConnect?: () => void;
  readonly onSettings?: () => void;
  readonly className?: string;
}

export function SessionList({
  sessions,
  activeSessionId,
  connectedHost,
  onSelectSession,
  onResumeSession,
  resumingSessionId,
  onConnect,
  onSettings,
  className,
}: SessionListProps) {
  return (
    <div className={clsx('flex h-full flex-col bg-[var(--color-surface)]', className)}>
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 safe-area-top">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">
          Remi{connectedHost ? <span className="font-normal text-[var(--color-text-muted)]"> on {connectedHost}</span> : ''}
        </h1>
        <div className="flex items-center gap-1">
          {onConnect && (
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

      {/* Session list */}
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
        ) : (
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
