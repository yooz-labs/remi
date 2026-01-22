/**
 * ChatHeader component.
 *
 * Displays session info, status, and actions.
 */

import type { AgentStatus, ConnectionStatus, UISession } from '@/types';
import { clsx } from 'clsx';
import {
  AlertCircle,
  ArrowLeft,
  Brain,
  Clock,
  Loader2,
  MoreVertical,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';

interface ChatHeaderProps {
  readonly session: UISession;
  readonly onBack?: () => void;
  readonly onMore?: () => void;
  readonly className?: string;
}

/** Connection status indicator */
function ConnectionIndicator({
  status,
}: {
  readonly status: ConnectionStatus;
}) {
  switch (status) {
    case 'connected':
      return <Wifi className="size-4 text-[--color-success]" />;
    case 'connecting':
    case 'reconnecting':
      return <Loader2 className="size-4 animate-spin text-[--color-warning]" />;
    case 'error':
      return <AlertCircle className="size-4 text-[--color-error]" />;
    case 'disconnected':
    default:
      return <WifiOff className="size-4 text-[--color-text-muted]" />;
  }
}

/** Agent status indicator */
function AgentStatusIndicator({ status }: { readonly status: AgentStatus }) {
  const statusConfig = {
    idle: {
      icon: Clock,
      label: 'Idle',
      color: 'text-[--color-text-muted]',
    },
    thinking: {
      icon: Brain,
      label: 'Thinking...',
      color: 'text-[--color-warning]',
    },
    executing: {
      icon: Terminal,
      label: 'Executing...',
      color: 'text-[--color-primary]',
    },
    waiting: {
      icon: Clock,
      label: 'Waiting for input',
      color: 'text-[--color-success]',
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={clsx('flex items-center gap-1 text-xs', config.color)}>
      <Icon
        className={clsx(
          'size-3',
          (status === 'thinking' || status === 'executing') && 'animate-pulse',
        )}
      />
      <span>{config.label}</span>
    </div>
  );
}

export function ChatHeader({ session, onBack, onMore, className }: ChatHeaderProps) {
  return (
    <header
      className={clsx(
        'flex items-center gap-3 border-b border-[--color-border] bg-[--color-surface] px-4 py-3',
        'safe-area-top',
        className,
      )}
    >
      {/* Back button (mobile) */}
      {onBack && (
        <button
          onClick={onBack}
          className="rounded-full p-1.5 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text] md:hidden"
          aria-label="Go back"
        >
          <ArrowLeft className="size-5" />
        </button>
      )}

      {/* Session info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate font-medium text-[--color-text]">
            {session.name || 'Claude Session'}
          </h1>
          <ConnectionIndicator status={session.connectionStatus} />
        </div>
        <div className="flex items-center gap-2">
          <AgentStatusIndicator status={session.status} />
          {session.cwd && (
            <>
              <span className="text-[--color-text-muted]">|</span>
              <span className="truncate text-xs text-[--color-text-muted]">{session.cwd}</span>
            </>
          )}
        </div>
      </div>

      {/* More button */}
      {onMore && (
        <button
          onClick={onMore}
          className="rounded-full p-1.5 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text]"
          aria-label="More options"
        >
          <MoreVertical className="size-5" />
        </button>
      )}
    </header>
  );
}
