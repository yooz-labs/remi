/**
 * StatusPill component.
 *
 * Renders one of five session states (asking / working / idle / connecting /
 * offline). Kept framework-light with inline styles so the exact palette from
 * the design system is honored regardless of Tailwind purge. State derivation
 * + name splitting live in `@/lib/session-display`.
 */

import type { PillState } from '@/lib/session-display';

interface PillConfig {
  readonly label: string;
  // `dot` and `fg` are separate fields (currently always equal) so a future
  // design can tint the dot independently of the label text.
  readonly dot: string;
  readonly fg: string;
  readonly bg: string;
  readonly pulse: boolean;
}

const PILL: Record<PillState, PillConfig> = {
  asking: {
    label: 'Needs you',
    dot: 'var(--color-primary)',
    fg: 'var(--color-accent-text)',
    bg: 'var(--color-accent-soft)',
    pulse: false,
  },
  working: {
    label: 'Working',
    dot: 'var(--color-text-secondary)',
    fg: 'var(--color-text-secondary)',
    bg: 'var(--color-surface-elevated)',
    pulse: true,
  },
  connecting: {
    label: 'Connecting',
    dot: 'var(--color-warning)',
    fg: 'var(--color-warning)',
    bg: 'transparent',
    pulse: true,
  },
  offline: {
    label: 'Offline',
    dot: 'var(--color-error)',
    fg: 'var(--color-error)',
    bg: 'transparent',
    pulse: false,
  },
  idle: {
    label: 'Idle',
    dot: 'var(--color-text-muted)',
    fg: 'var(--color-text-muted)',
    bg: 'transparent',
    pulse: false,
  },
};

export function StatusPill({
  state,
  className,
}: {
  readonly state: PillState;
  readonly className?: string;
}) {
  const c = PILL[state];
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px 3px 8px',
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        height: 20,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: c.dot,
          // currentColor drives the pulse-dot box-shadow ring.
          color: c.dot,
          animation: c.pulse ? 'pulse-dot 1.6s ease-out infinite' : undefined,
        }}
      />
      {c.label}
    </span>
  );
}
