/**
 * SessionList component.
 *
 * The "Sessions" screen: a brand + connection-status header, an attention
 * banner when agents need the user, status filter chips, then the rows.
 * Active sessions (live daemon) are shown first; transcript-only sessions
 * live under a collapsible "Recent" group.
 */

import { type PillState, sessionPillState } from '@/lib/session-display';
import type { ConnectionId, ConnectionState, UISession } from '@/types';
import type { UUID } from '@remi/shared/types.ts';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  ChevronRight,
  Link2,
  Link2Off,
  Loader2,
  Plus,
  Settings,
  Wifi,
  WifiOff,
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

type FilterId = 'all' | 'asking' | 'working' | 'idle';

/** Map a pill state to the filter bucket it belongs to. */
function filterBucket(state: PillState): FilterId {
  if (state === 'asking') return 'asking';
  if (state === 'working') return 'working';
  return 'idle';
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
  const [filter, setFilter] = useState<FilterId>('all');

  // Active = sessions owned by a running daemon (has a live port behind it).
  // Recent = transcript-discovered sessions with no live daemon.
  const { activeSessions, recentSessions } = useMemo(() => {
    const active: UISession[] = [];
    const recent: UISession[] = [];
    for (const session of sessions) {
      if (session.source === 'daemon') active.push(session);
      else recent.push(session);
    }
    return { activeSessions: active, recentSessions: recent };
  }, [sessions]);

  // Per-bucket counts drive the chip badges + attention banner.
  const counts = useMemo(() => {
    const c = { all: activeSessions.length, asking: 0, working: 0, idle: 0 };
    for (const s of activeSessions) c[filterBucket(sessionPillState(s))]++;
    return c;
  }, [activeSessions]);

  const filteredActive = useMemo(
    () =>
      filter === 'all'
        ? activeSessions
        : activeSessions.filter((s) => filterBucket(sessionPillState(s)) === filter),
    [activeSessions, filter],
  );

  const askingCount = counts.asking;
  const hasConnections = connections.length > 0;
  const anyConnected = connections.some((c) => c.status === 'connected');
  const anyConnecting = connections.some(
    (c) => c.status === 'connecting' || c.status === 'reconnecting' || c.status === 'authenticating',
  );

  const problemConnections = connections.filter(
    (c) => c.status === 'error' || c.status === 'reconnecting' || c.status === 'unreachable',
  );

  const goToFirstAsking = () => {
    const first = activeSessions.find((s) => sessionPillState(s) === 'asking');
    if (first) onSelectSession(first.id);
  };

  return (
    <div className={clsx('flex h-full flex-col bg-[var(--color-surface)]', className)}>
      {/* Header */}
      <header className="safe-area-top px-[18px] pb-2 pt-3">
        {/* Brand + connection status */}
        <div className="flex items-center gap-2">
          <span className="inline-flex size-[22px] items-center justify-center rounded-[7px] bg-[var(--color-primary)] text-[13px] font-extrabold tracking-tight text-[var(--color-accent-ink)]">
            r
          </span>
          <span className="text-sm font-semibold tracking-tight text-[var(--color-text-secondary)]">
            remi
          </span>
          <span className="ml-1 inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-text-muted)]">
            {anyConnected ? (
              <Wifi className="size-3 text-[var(--color-success)]" />
            ) : anyConnecting ? (
              <Loader2 className="size-3 animate-spin text-[var(--color-warning)]" />
            ) : (
              <WifiOff className="size-3 text-[var(--color-text-muted)]" />
            )}
            {hasConnections
              ? `local · ${connections.length} host${connections.length > 1 ? 's' : ''}`
              : 'not connected'}
          </span>
          {hasConnections && (
            <button
              type="button"
              onClick={onDisconnectAll}
              className="ml-auto rounded-full p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-error)]"
              aria-label="Disconnect all"
            >
              <Link2Off className="size-4" />
            </button>
          )}
        </div>

        {/* Title + actions */}
        <div className="mt-1 flex items-end justify-between">
          <h1 className="text-[30px] font-bold leading-none tracking-[-0.04em] text-[var(--color-text)]">
            Sessions
          </h1>
          <div className="flex items-center gap-2">
            {onSettings && (
              <button
                type="button"
                onClick={onSettings}
                className="inline-flex size-[38px] items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-light)] text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-elevated)]"
                aria-label="Settings"
              >
                <Settings className="size-[18px]" />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (hasConnections && onNewSession) {
                  // Directory selection is preserved here; the richer
                  // new-session sheet (command + options) is a follow-up that
                  // needs daemon-side support.
                  const dir = window.prompt('Project directory (leave empty for home):');
                  if (dir !== null) onNewSession(dir || undefined);
                } else {
                  onConnect();
                }
              }}
              className="inline-flex size-[38px] items-center justify-center rounded-xl bg-[var(--color-primary)] text-[var(--color-accent-ink)] transition-transform active:scale-95"
              style={{ boxShadow: '0 4px 18px -6px var(--color-primary)' }}
              aria-label={hasConnections ? 'New session' : 'Connect'}
            >
              <Plus className="size-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Connection problem banners */}
      {problemConnections.length > 0 && (
        <div className="space-y-1 px-3 pb-2">
          {problemConnections.map((c) => (
            <div
              key={c.connectionId}
              className={clsx(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
                c.status === 'reconnecting'
                  ? 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'
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

      {hasConnections && (
        <>
          {/* Attention banner */}
          {askingCount > 0 && (
            <button
              type="button"
              onClick={goToFirstAsking}
              className="mx-4 mb-3 mt-3 flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left"
              style={{
                background: 'var(--color-accent-soft)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
              }}
            >
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--color-accent-ink)]">
                <Bell className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-[var(--color-text)]">
                  {askingCount} agent{askingCount > 1 ? 's' : ''} need{askingCount > 1 ? '' : 's'} you
                </div>
                <div className="mt-px text-xs text-[var(--color-text-secondary)]">
                  Tap to answer · Y / N / A
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-[var(--color-text-muted)]" />
            </button>
          )}

          {/* Filter chips */}
          <div className={clsx('no-scrollbar flex gap-1.5 overflow-x-auto px-4 pb-3', askingCount === 0 && 'pt-3')}>
            {([
              { id: 'all', label: 'All' },
              { id: 'asking', label: 'Needs you' },
              { id: 'working', label: 'Working' },
              { id: 'idle', label: 'Idle' },
            ] as const).map((chip) => {
              const active = filter === chip.id;
              const count = counts[chip.id];
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => setFilter(chip.id)}
                  className={clsx(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-[7px] text-[13px] font-semibold transition-colors',
                    active
                      ? 'bg-[var(--color-text)] text-[var(--color-surface)]'
                      : 'border border-[var(--color-border)] bg-[var(--color-surface-light)] text-[var(--color-text-secondary)]',
                  )}
                >
                  {chip.label}
                  {chip.id === 'asking' && count > 0 && (
                    <span
                      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
                      style={{
                        background: active ? 'var(--color-surface)' : 'var(--color-primary)',
                        color: active ? 'var(--color-primary)' : 'var(--color-accent-ink)',
                      }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Content */}
      <div className="safe-area-bottom flex-1 overflow-y-auto">
        {!hasConnections ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 rounded-full bg-[var(--color-surface-light)] p-4">
              <Link2 className="size-8 text-[var(--color-text-muted)]" />
            </div>
            <h2 className="mb-1 font-semibold text-[var(--color-text)]">Connect to your machine</h2>
            <p className="mb-5 text-sm text-[var(--color-text-secondary)]">
              Enter your hostname or IP to see active Claude sessions
            </p>
            <button
              type="button"
              onClick={onConnect}
              className="flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--color-accent-ink)] transition-transform active:scale-95"
            >
              <Link2 className="size-4" />
              Connect
            </button>
          </div>
        ) : (
          <>
            {/* Active sessions */}
            {filteredActive.map((session, i) => (
              <SessionCard
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => onSelectSession(session.id)}
                onResume={onResumeSession}
                onDisconnect={onDisconnect}
                isResuming={resumingSessionId === session.id}
                last={i === filteredActive.length - 1 && recentSessions.length === 0}
              />
            ))}

            {filteredActive.length === 0 && (
              <p className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
                {filter === 'all' ? 'No active sessions' : `Nothing ${filter === 'asking' ? 'needs you' : filter}`}
              </p>
            )}

            {/* Recent (transcript-only) sessions */}
            {filter === 'all' && recentSessions.length > 0 && (
              <div className="border-t border-[var(--color-border)]">
                <button
                  type="button"
                  onClick={() => setShowRecent(!showRecent)}
                  className="flex w-full items-center gap-2 px-[22px] py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
                >
                  {showRecent ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  Recent ({recentSessions.length})
                </button>
                {showRecent &&
                  recentSessions.map((session, i) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => onSelectSession(session.id)}
                      onResume={onResumeSession}
                      isResuming={resumingSessionId === session.id}
                      last={i === recentSessions.length - 1}
                    />
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
