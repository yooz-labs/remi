import type { SessionProfileRef } from '@remi/shared';

interface ProfileBadgeProps {
  readonly profile?: SessionProfileRef | undefined;
  readonly showChangedTitle?: boolean;
}

/** Text-only identity badge for the profile a session started with. */
export function ProfileBadge({ profile, showChangedTitle = false }: ProfileBadgeProps) {
  const label = profile?.label ?? 'Default sign-in';
  const removed = profile?.state === 'removed';
  const changed = profile?.state === 'changed';
  const text = removed ? `${label} (removed)` : label;

  return (
    <span
      className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
      aria-label={removed ? `Profile ${label}, removed` : `Profile ${label}`}
      title={showChangedTitle && changed ? "This profile's settings changed after the session started; the session keeps the settings it started with" : undefined}
    >
      {text}
    </span>
  );
}
