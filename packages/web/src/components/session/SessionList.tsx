/**
 * SessionList component.
 *
 * Displays a list of active sessions.
 */

import { clsx } from 'clsx';
import { Plus, Link2, Settings } from 'lucide-react';
import { SessionCard } from './SessionCard';
import type { UISession } from '@/types';
import type { UUID } from '@remi/shared/types.ts';

interface SessionListProps {
  readonly sessions: readonly UISession[];
  readonly activeSessionId: UUID | null;
  readonly onSelectSession: (id: UUID) => void;
  readonly onNewSession?: () => void;
  readonly onConnect?: () => void;
  readonly onSettings?: () => void;
  readonly className?: string;
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onConnect,
  onSettings,
  className,
}: SessionListProps) {
  return (
    <div
      className={clsx(
        'flex h-full flex-col bg-[--color-surface]',
        className,
      )}
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[--color-border] px-4 py-3 safe-area-top">
        <h1 className="text-lg font-semibold text-[--color-text]">Sessions</h1>
        <div className="flex items-center gap-1">
          {onConnect && (
            <button
              onClick={onConnect}
              className="rounded-full p-2 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text]"
              aria-label="Connect to daemon"
            >
              <Link2 className="size-5" />
            </button>
          )}
          {onSettings && (
            <button
              onClick={onSettings}
              className="rounded-full p-2 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text]"
              aria-label="Settings"
            >
              <Settings className="size-5" />
            </button>
          )}
        </div>
      </header>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="mb-4 rounded-full bg-[--color-surface-light] p-4">
              <Link2 className="size-8 text-[--color-text-muted]" />
            </div>
            <h2 className="mb-1 font-medium text-[--color-text]">
              No Sessions
            </h2>
            <p className="mb-4 text-sm text-[--color-text-secondary]">
              Connect to a Claude daemon to start monitoring
            </p>
            {onConnect && (
              <button
                onClick={onConnect}
                className="flex items-center gap-2 rounded-full bg-[--color-primary] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[--color-primary-dark]"
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
              />
            ))}
          </div>
        )}
      </div>

      {/* New session button (floating) */}
      {onNewSession && sessions.length > 0 && (
        <div className="absolute bottom-20 right-4 safe-area-bottom">
          <button
            onClick={onNewSession}
            className="flex size-14 items-center justify-center rounded-full bg-[--color-primary] text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
            aria-label="New session"
          >
            <Plus className="size-6" />
          </button>
        </div>
      )}
    </div>
  );
}
