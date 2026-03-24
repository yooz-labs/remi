/**
 * RecentProjects component.
 *
 * Shows recent project directories with a "Start" button to create
 * a new session in that directory, plus a text input for custom paths.
 */

import type { RecentDirectory } from '@remi/shared/protocol.ts';
import { FolderOpen, Play } from 'lucide-react';
import { useState } from 'react';

interface RecentProjectsProps {
  readonly directories: readonly RecentDirectory[];
  readonly onStartSession: (directory: string) => void;
}

function formatAge(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RecentProjects({ directories, onStartSession }: RecentProjectsProps) {
  const [customPath, setCustomPath] = useState('');
  const [expanded, setExpanded] = useState(false);

  const visibleDirs = expanded ? directories : directories.slice(0, 5);

  return (
    <div className="border-t border-[var(--color-border)] px-3 py-2">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Recent Projects
      </h3>

      <div className="space-y-1">
        {visibleDirs.map((dir) => (
          <div
            key={dir.directory}
            className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-light)]"
          >
            <FolderOpen className="size-4 shrink-0 text-[var(--color-text-muted)]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[var(--color-text)]">
                {dir.displayName}
              </div>
              <div className="truncate text-xs text-[var(--color-text-muted)]">
                {formatAge(dir.lastUsed)} - {dir.sessionCount} session
                {dir.sessionCount !== 1 ? 's' : ''}
              </div>
            </div>
            <button
              onClick={() => onStartSession(dir.directory)}
              className="invisible rounded p-1 text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary)]/10 group-hover:visible"
              aria-label={`Start session in ${dir.displayName}`}
            >
              <Play className="size-4" />
            </button>
          </div>
        ))}
      </div>

      {directories.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 w-full text-center text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {expanded ? 'Show less' : `Show ${directories.length - 5} more`}
        </button>
      )}

      {/* Custom directory input */}
      <div className="mt-2 flex gap-1">
        <input
          type="text"
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customPath.trim()) {
              onStartSession(customPath.trim());
              setCustomPath('');
            }
          }}
          placeholder="Custom path..."
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
        />
        <button
          onClick={() => {
            if (customPath.trim()) {
              onStartSession(customPath.trim());
              setCustomPath('');
            }
          }}
          disabled={!customPath.trim()}
          className="rounded bg-[var(--color-primary)] px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          Start
        </button>
      </div>
    </div>
  );
}
