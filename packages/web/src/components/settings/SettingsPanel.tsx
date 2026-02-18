/**
 * SettingsPanel component.
 *
 * Slide-in panel for app settings.
 */

import type { AppSettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { clsx } from 'clsx';
import { Moon, Sun, Monitor, X } from 'lucide-react';
import { useEffect } from 'react';

interface SettingsPanelProps {
  readonly open: boolean;
  readonly settings: AppSettings;
  readonly onClose: () => void;
  readonly onChange: (settings: AppSettings) => void;
}

function ThemeButton({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex flex-1 flex-col items-center gap-1.5 rounded-lg p-3 text-xs transition-colors',
        active
          ? 'bg-[--color-primary] text-white'
          : 'bg-[--color-surface-light] text-[--color-text-secondary] hover:bg-[--color-surface-elevated]',
      )}
    >
      <Icon className="size-5" />
      {label}
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-2">
      <span className="text-sm text-[--color-text]">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-6 w-11 rounded-full transition-colors',
          checked ? 'bg-[--color-primary]' : 'bg-[--color-border]',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
    </label>
  );
}

export function SettingsPanel({ open, settings, onClose, onChange }: SettingsPanelProps) {
  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const update = (partial: Partial<AppSettings>) => {
    onChange({ ...settings, ...partial });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-sm bg-[--color-surface] shadow-lg animate-[slide-in-right_0.2s_ease-out]">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-[--color-border] px-4 py-3 safe-area-top">
          <h2 className="text-lg font-semibold text-[--color-text]">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light]"
            aria-label="Close settings"
          >
            <X className="size-5" />
          </button>
        </header>

        <div className="overflow-y-auto p-4 space-y-6">
          {/* Theme */}
          <section>
            <h3 className="mb-3 text-sm font-medium text-[--color-text-secondary]">Theme</h3>
            <div className="flex gap-2">
              <ThemeButton
                active={settings.theme === 'system'}
                label="System"
                icon={Monitor}
                onClick={() => update({ theme: 'system' })}
              />
              <ThemeButton
                active={settings.theme === 'light'}
                label="Light"
                icon={Sun}
                onClick={() => update({ theme: 'light' })}
              />
              <ThemeButton
                active={settings.theme === 'dark'}
                label="Dark"
                icon={Moon}
                onClick={() => update({ theme: 'dark' })}
              />
            </div>
          </section>

          {/* Font Size */}
          <section>
            <h3 className="mb-3 text-sm font-medium text-[--color-text-secondary]">Font Size</h3>
            <div className="flex gap-2">
              {(['small', 'medium', 'large'] as const).map((size) => (
                <button
                  key={size}
                  onClick={() => update({ fontSize: size })}
                  className={clsx(
                    'flex-1 rounded-lg py-2 text-sm capitalize transition-colors',
                    settings.fontSize === size
                      ? 'bg-[--color-primary] text-white'
                      : 'bg-[--color-surface-light] text-[--color-text-secondary] hover:bg-[--color-surface-elevated]',
                  )}
                >
                  {size}
                </button>
              ))}
            </div>
          </section>

          {/* Toggles */}
          <section>
            <h3 className="mb-2 text-sm font-medium text-[--color-text-secondary]">Preferences</h3>
            <div className="space-y-1">
              <Toggle
                label="Show timestamps"
                checked={settings.showTimestamps}
                onChange={(v) => update({ showTimestamps: v })}
              />
              <Toggle
                label="Notifications"
                checked={settings.notifications}
                onChange={(v) => update({ notifications: v })}
              />
              <Toggle
                label="Sound"
                checked={settings.sound}
                onChange={(v) => update({ sound: v })}
              />
              <Toggle
                label="Auto-reconnect"
                checked={settings.autoReconnect}
                onChange={(v) => update({ autoReconnect: v })}
              />
            </div>
          </section>

          {/* About */}
          <section>
            <h3 className="mb-2 text-sm font-medium text-[--color-text-secondary]">About</h3>
            <p className="text-sm text-[--color-text-muted]">Remi v0.1.0</p>
          </section>

          {/* Reset */}
          <button
            onClick={() => onChange(DEFAULT_SETTINGS)}
            className="w-full rounded-lg border border-[--color-border] py-2 text-sm text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light]"
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
