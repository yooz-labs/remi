/**
 * NewSessionModal component.
 *
 * Bottom-sheet for starting a new Claude Code session. Replaces the old
 * window.prompt path-entry (#638): shows recent project directories (from the
 * daemon's session history) with a one-tap start, plus a custom-path input.
 * Mirrors ConnectModal's sheet styling.
 */

import { createInitialProfileSheetState } from '@/lib/profile-sheet-state';
import type { ProfileSheetAction, ProfileSheetState } from '@/lib/profile-sheet-state';
import type { RecentDirectory } from '@remi/shared/protocol.ts';
import { X } from 'lucide-react';
import { ProfilePicker } from './ProfilePicker';
import { RecentProjects } from './RecentProjects';

interface NewSessionModalProps {
  readonly open: boolean;
  /** Recent directories are still being fetched from the daemon. */
  readonly loading?: boolean;
  readonly onClose: () => void;
  readonly directories: readonly RecentDirectory[];
  readonly profilesEnabled?: boolean;
  readonly profileState?: ProfileSheetState;
  readonly onProfileAction?: (action: ProfileSheetAction) => void;
  readonly onRequestProfiles?: (directory: string) => void;
  /** Start a session in the given directory (empty string = home/cwd). */
  readonly onStartSession: (directory: string, profileId?: string) => void;
}

const NOOP_PROFILE_ACTION = (_action: ProfileSheetAction) => {};

export function NewSessionModal({
  open,
  loading = false,
  onClose,
  directories,
  profilesEnabled = false,
  profileState = createInitialProfileSheetState(),
  onProfileAction = NOOP_PROFILE_ACTION,
  onRequestProfiles,
  onStartSession,
}: NewSessionModalProps) {
  if (!open) return null;

  const creating = profileState.create.status === 'pending';
  const lookup = profileState.lookup;
  const selectedDirectory = profileState.selectedDirectory;

  const chooseDirectory = (directory: string) => {
    if (creating) return;
    if (!profilesEnabled) {
      onStartSession(directory);
      return;
    }
    onProfileAction({ type: 'directory-selected', directory });
    onRequestProfiles?.(directory);
  };

  return (
    <div
      data-testid="new-session-modal-backdrop"
      className="fixed inset-0 z-50 flex items-end justify-center"
    >
      <button
        type="button"
        aria-label="Close new session sheet"
        onClick={onClose}
        className="absolute inset-0 cursor-default border-0 bg-black/60 p-0"
      />
      <div className="relative z-10 max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-[28px] border border-[var(--color-border)] bg-[var(--color-surface)] pb-[max(env(safe-area-inset-bottom),12px)] shadow-2xl animate-[sheet-up_260ms_cubic-bezier(.2,.8,1)]">
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

        <RecentProjects
          directories={directories}
          onStartSession={chooseDirectory}
          profilesEnabled={profilesEnabled}
          disabled={creating}
          onPathEdit={() => onProfileAction({ type: 'path-edited' })}
        />

        {profileState.createError && selectedDirectory === null && (
          <p role="alert" className="px-5 py-2 text-xs text-[var(--color-error)]">
            {profileState.createError}
          </p>
        )}

        {profilesEnabled && selectedDirectory !== null && (
          <ProfilePicker
            directory={selectedDirectory}
            lookup={lookup}
            selectedProfile={profileState.selectedProfile}
            creating={creating}
            error={profileState.createError}
            onSelectProfile={(profileId) =>
              onProfileAction({ type: 'profile-selected', profileId })
            }
            onStart={(profileId) => onStartSession(selectedDirectory, profileId)}
          />
        )}
      </div>
    </div>
  );
}
