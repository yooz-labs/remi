/**
 * NewSessionModal component.
 *
 * Bottom-sheet for starting a new Claude Code session. Replaces the old
 * window.prompt path-entry (#638): shows recent project directories (from the
 * daemon's session history) with a one-tap start, plus a custom-path input.
 * Mirrors ConnectModal's sheet styling.
 */

import type { RecentDirectory } from '@remi/shared/protocol.ts';
import { X } from 'lucide-react';
import { RecentProjects } from './RecentProjects';

interface NewSessionModalProps {
  readonly open: boolean;
  /** Recent directories are still being fetched from the daemon. */
  readonly loading?: boolean;
  readonly onClose: () => void;
  readonly directories: readonly RecentDirectory[];
  /** Start a session in the given directory (empty string = home/cwd). The
   *  parent closes the sheet once the request is actually sent. */
  readonly onStartSession: (directory: string) => void;
}

export function NewSessionModal({
  open,
  loading = false,
  onClose,
  directories,
  onStartSession,
}: NewSessionModalProps) {
  if (!open) return null;

  return (
    <div
      data-testid="new-session-modal-backdrop"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-[28px] border border-[var(--color-border)] bg-[var(--color-surface)] pb-[max(env(safe-area-inset-bottom),12px)] shadow-2xl animate-[sheet-up_260ms_cubic-bezier(.2,.8,.2,1)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-1 mt-3 h-1 w-9 rounded-full bg-[var(--color-border)]" />
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-2 pt-1">
          <h2 className="text-[22px] font-bold tracking-tight text-[var(--color-text)]">
            New session
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <p className="px-5 pb-1 text-[13px] leading-snug text-[var(--color-text-secondary)]">
          Pick a recent project or enter a path to start Claude Code there.
        </p>

        {loading ? (
          <p className="px-5 pt-2 text-[13px] text-[var(--color-text-muted)]">
            Loading recent projects…
          </p>
        ) : (
          directories.length === 0 && (
            <p className="px-5 pt-2 text-[13px] text-[var(--color-text-muted)]">
              No recent projects yet. Enter a directory path below to start your first session.
            </p>
          )
        )}

        <RecentProjects directories={directories} onStartSession={onStartSession} />
      </div>
    </div>
  );
}
