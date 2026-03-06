/**
 * SettingsPanel component.
 *
 * Slide-in panel for app settings including identity management.
 */

import {
  exportIdentity,
  generateIdentity,
  getFingerprint,
  importIdentity,
  isIdentityEncrypted,
  removeIdentity,
} from '@/lib/identity-client';
import type { AppSettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';
import { clsx } from 'clsx';
import { Copy, Download, Key, Moon, Monitor, Shield, Sun, Upload, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

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

/** Identity management sub-section */
function IdentitySection() {
  const [fingerprint, setFingerprint] = useState<string | null>(getFingerprint);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [importJson, setImportJson] = useState('');
  const [generating, setGenerating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [encrypted, setEncrypted] = useState(false);

  const passphraseRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    setFingerprint(getFingerprint());
    setEncrypted(isIdentityEncrypted());
  }, []);

  // Check encryption status on mount
  useEffect(() => {
    setEncrypted(isIdentityEncrypted());
  }, []);

  const handleGenerate = async (e: FormEvent) => {
    e.preventDefault();
    if (usePassphrase) {
      if (passphrase.length < 8) {
        setFeedback('Passphrase must be at least 8 characters.');
        return;
      }
      if (passphrase !== confirmPassphrase) {
        setFeedback('Passphrases do not match.');
        return;
      }
    }
    setGenerating(true);
    setFeedback(null);
    try {
      await generateIdentity(usePassphrase ? passphrase : undefined);
      refresh();
      setShowGenerate(false);
      setPassphrase('');
      setConfirmPassphrase('');
      setUsePassphrase(false);
      setFeedback('Identity generated successfully.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to generate identity');
    } finally {
      setGenerating(false);
    }
  };

  const handleImport = (e: FormEvent) => {
    e.preventDefault();
    try {
      importIdentity(importJson);
      refresh();
      setShowImport(false);
      setImportJson('');
      setFeedback('Identity imported successfully.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to import identity');
    }
  };

  const handleExport = () => {
    const json = exportIdentity();
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'remi-identity.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyFingerprint = () => {
    if (fingerprint) {
      navigator.clipboard.writeText(fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const [confirmRemove, setConfirmRemove] = useState(false);

  const handleRemove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      setFeedback('Click Remove again to confirm. This is irreversible.');
      return;
    }
    removeIdentity();
    refresh();
    setConfirmRemove(false);
    setFeedback('Identity removed.');
  };

  return (
    <section>
      <h3 className="mb-3 text-sm font-medium text-[--color-text-secondary]">
        Identity & Security
      </h3>

      {fingerprint ? (
        <div className="space-y-3">
          {/* Fingerprint display */}
          <div className="flex items-center gap-2 rounded-lg bg-[--color-surface-light] p-3">
            <Shield className="size-5 shrink-0 text-[--color-primary]" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-[--color-text-muted]">
                Your fingerprint {encrypted ? '(encrypted)' : '(unencrypted)'}
              </p>
              <p className="truncate font-mono text-sm text-[--color-text]">{fingerprint}</p>
            </div>
            <button
              onClick={handleCopyFingerprint}
              className="shrink-0 rounded p-1 text-[--color-text-muted] hover:text-[--color-text]"
              title="Copy fingerprint"
            >
              <Copy className="size-4" />
            </button>
          </div>
          {copied && (
            <p className="text-xs text-[--color-success]">Copied to clipboard</p>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleExport}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[--color-surface-light] py-2 text-xs text-[--color-text-secondary] hover:bg-[--color-surface-elevated]"
            >
              <Download className="size-3.5" />
              Export
            </button>
            <button
              onClick={handleRemove}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[--color-error]/10 py-2 text-xs text-[--color-error] hover:bg-[--color-error]/20"
            >
              <X className="size-3.5" />
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[--color-text-muted]">
            No identity configured. Generate one or import from another device.
          </p>

          {!showGenerate && !showImport && (
            <div className="flex gap-2">
              <button
                onClick={() => { setShowGenerate(true); setShowImport(false); }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[--color-primary] py-2 text-xs text-white hover:bg-[--color-primary-dark]"
              >
                <Key className="size-3.5" />
                Generate
              </button>
              <button
                onClick={() => { setShowImport(true); setShowGenerate(false); }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[--color-surface-light] py-2 text-xs text-[--color-text-secondary] hover:bg-[--color-surface-elevated]"
              >
                <Upload className="size-3.5" />
                Import
              </button>
            </div>
          )}

          {/* Generate form */}
          {showGenerate && (
            <form onSubmit={handleGenerate} className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-[--color-text-secondary]">
                <input
                  type="checkbox"
                  checked={usePassphrase}
                  onChange={(e) => setUsePassphrase(e.target.checked)}
                  className="rounded"
                />
                Encrypt with passphrase
              </label>
              {usePassphrase && (
                <>
                  <input
                    ref={passphraseRef}
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Passphrase (min 8 chars)"
                    className="w-full rounded-lg bg-[--color-surface-light] px-3 py-2 text-sm text-[--color-text] placeholder:text-[--color-text-muted] outline-none focus:ring-2 focus:ring-[--color-primary]/50"
                  />
                  <input
                    type="password"
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                    placeholder="Confirm passphrase"
                    className="w-full rounded-lg bg-[--color-surface-light] px-3 py-2 text-sm text-[--color-text] placeholder:text-[--color-text-muted] outline-none focus:ring-2 focus:ring-[--color-primary]/50"
                  />
                </>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={generating}
                  className="flex-1 rounded-lg bg-[--color-primary] py-2 text-xs text-white hover:bg-[--color-primary-dark] disabled:opacity-50"
                >
                  {generating ? 'Generating...' : 'Create Identity'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowGenerate(false); setPassphrase(''); setConfirmPassphrase(''); }}
                  className="rounded-lg bg-[--color-surface-light] px-3 py-2 text-xs text-[--color-text-secondary]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Import form */}
          {showImport && (
            <form onSubmit={handleImport} className="space-y-2">
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder="Paste identity JSON here"
                rows={4}
                className="w-full rounded-lg bg-[--color-surface-light] px-3 py-2 text-sm font-mono text-[--color-text] placeholder:text-[--color-text-muted] outline-none focus:ring-2 focus:ring-[--color-primary]/50"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={!importJson.trim()}
                  className="flex-1 rounded-lg bg-[--color-primary] py-2 text-xs text-white hover:bg-[--color-primary-dark] disabled:opacity-50"
                >
                  Import
                </button>
                <button
                  type="button"
                  onClick={() => { setShowImport(false); setImportJson(''); }}
                  className="rounded-lg bg-[--color-surface-light] px-3 py-2 text-xs text-[--color-text-secondary]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {feedback && (
        <p className="mt-2 text-xs text-[--color-text-muted]">{feedback}</p>
      )}
    </section>
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
          {/* Identity & Security */}
          <IdentitySection />

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
