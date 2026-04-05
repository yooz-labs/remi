/**
 * ConnectModal component.
 *
 * Simplified connection flow: enter a host to discover sessions,
 * or use a connection code for remote access via WebRTC.
 */

import type { ConnectionStatus } from '@/types';
import { clsx } from 'clsx';
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Key,
  Loader2,
  Monitor,
  Shield,
  X,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';

interface ConnectModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConnectDirect: (url: string, directory?: string) => void;
  readonly onConnectCode?: (code: string) => void;
  readonly connectionStatus: ConnectionStatus;
  readonly error?: string | null;
  readonly needsPassphrase?: boolean;
  readonly hasIdentity?: boolean;
  readonly serverFingerprint?: string | null;
  readonly onPassphraseSubmit?: (passphrase: string) => Promise<void>;
}

type ConnectionMode = 'local' | 'remote';

const DEFAULT_PORT = 18765;
const LOCALSTORAGE_HOST_KEY = 'remi-last-host';

/** Build WebSocket URL from host and optional port */
function buildWsUrl(host: string): string {
  const trimmed = host.trim();
  // If user entered a full ws:// URL, use it as-is (backward compat)
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed;
  }
  // IPv6 addresses contain multiple colons; don't split on port
  const hasMultipleColons = (trimmed.match(/:/g) || []).length > 1;
  if (hasMultipleColons) {
    // Treat as IPv6 hostname without port
    const hostname = trimmed.startsWith('[') ? trimmed : `[${trimmed}]`;
    return `ws://${hostname}:${DEFAULT_PORT}/ws`;
  }
  // Extract port if provided (e.g., "192.168.1.5:18770")
  const parts = trimmed.split(':');
  const hostname = parts[0];
  let port = DEFAULT_PORT;
  if (parts.length > 1 && parts[1]) {
    const parsed = Number.parseInt(parts[1], 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
      port = parsed;
    }
  }
  return `ws://${hostname}:${port}/ws`;
}

/** Code input with auto-formatting */
function CodeInput({
  value,
  onChange,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}` : raw;
    onChange(formatted);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={handleChange}
      disabled={disabled}
      placeholder="ABCD-1234"
      maxLength={9}
      className={clsx(
        'w-full rounded-xl bg-[var(--color-surface-light)] px-4 py-3',
        'text-center text-2xl font-mono tracking-widest',
        'text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]',
        'outline-none transition-colors',
        'focus:ring-2 focus:ring-[var(--color-primary)]/50',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    />
  );
}

/** Passphrase input view */
function PassphraseView({
  serverFingerprint,
  hasIdentity,
  onSubmit,
}: {
  readonly serverFingerprint?: string | null;
  readonly hasIdentity?: boolean;
  readonly onSubmit: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || isSubmitting) return;

    setIsSubmitting(true);
    setPassphraseError(null);
    try {
      await onSubmit(passphrase);
    } catch (err) {
      setPassphraseError(
        err instanceof Error ? err.message : 'Failed to unlock identity',
      );
      setPassphrase('');
      inputRef.current?.focus();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!hasIdentity) {
    return (
      <div className="space-y-3 text-center">
        <Shield className="mx-auto size-10 text-[var(--color-warning)]" />
        <p className="text-sm text-[var(--color-text)]">
          This daemon requires authentication, but no identity is configured.
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          Generate an identity in Settings, or import one from another device.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg bg-[var(--color-surface-light)] p-3">
        <Shield className="size-5 shrink-0 text-[var(--color-primary)]" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-text)]">Authentication Required</p>
          {serverFingerprint && (
            <p className="truncate text-xs font-mono text-[var(--color-text-muted)]">
              Server: {serverFingerprint}
            </p>
          )}
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm text-[var(--color-text-secondary)]">
          Passphrase
        </span>
        <input
          ref={inputRef}
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={isSubmitting}
          placeholder="Enter your passphrase"
          className={clsx(
            'w-full rounded-xl bg-[var(--color-surface-light)] px-4 py-3',
            'text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]',
            'outline-none transition-colors',
            'focus:ring-2 focus:ring-[var(--color-primary)]/50',
            isSubmitting && 'cursor-not-allowed opacity-50',
          )}
        />
      </label>

      {passphraseError && (
        <div className="flex items-center gap-2 rounded-lg bg-[var(--color-error)]/10 p-3 text-[var(--color-error)]">
          <AlertCircle className="size-4 shrink-0" />
          <span className="text-sm">{passphraseError}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={!passphrase || isSubmitting}
        className={clsx(
          'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white transition-colors',
          passphrase && !isSubmitting
            ? 'bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)]'
            : 'cursor-not-allowed bg-[var(--color-primary)]/50',
        )}
      >
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Key className="size-4" />
        )}
        {isSubmitting ? 'Unlocking...' : 'Unlock & Authenticate'}
      </button>
    </form>
  );
}

export function ConnectModal({
  isOpen,
  onClose,
  onConnectDirect,
  onConnectCode,
  connectionStatus,
  error,
  needsPassphrase,
  hasIdentity: hasId,
  serverFingerprint,
  onPassphraseSubmit,
}: ConnectModalProps) {
  const [mode, setMode] = useState<ConnectionMode>('local');
  const [host, setHost] = useState(() =>
    localStorage.getItem(LOCALSTORAGE_HOST_KEY) || 'localhost',
  );
  const [code, setCode] = useState('');
  const hostInputRef = useRef<HTMLInputElement>(null);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setCode('');
      setHost(localStorage.getItem(LOCALSTORAGE_HOST_KEY) || 'localhost');
    }
  }, [isOpen]);

  // Auto-focus host input when modal opens
  useEffect(() => {
    if (isOpen && mode === 'local') {
      setTimeout(() => hostInputRef.current?.focus(), 100);
    }
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
  const isAuthenticating = connectionStatus === 'authenticating';
  const isConnected = connectionStatus === 'connected';

  // Show passphrase view when auth is needed
  if (needsPassphrase && onPassphraseSubmit) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] shadow-xl border border-[var(--color-border)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
            <h2 className="text-lg font-semibold text-[var(--color-text)]">Authenticate</h2>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
              aria-label="Close"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="p-4">
            <PassphraseView
              serverFingerprint={serverFingerprint}
              hasIdentity={hasId}
              onSubmit={onPassphraseSubmit}
            />
          </div>
        </div>
      </div>
    );
  }

  const handleConnect = () => {
    if (mode === 'local') {
      const wsUrl = buildWsUrl(host);
      localStorage.setItem(LOCALSTORAGE_HOST_KEY, host.trim());
      onConnectDirect(wsUrl);
    } else if (onConnectCode) {
      onConnectCode(code);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canConnect && !isConnecting) {
      e.preventDefault();
      handleConnect();
    }
  };

  const canConnect = mode === 'local' ? host.trim().length > 0 : code.length === 9;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 safe-area-bottom">
      <div className="w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-[var(--color-surface)] shadow-xl border border-[var(--color-border)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Connect</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {/* Mode tabs */}
          <div className="mb-4 flex gap-2 rounded-xl bg-[var(--color-surface-light)] p-1">
            <button
              onClick={() => setMode('local')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors',
                mode === 'local'
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
              )}
            >
              <Monitor className="size-4" />
              Host
            </button>
            {onConnectCode && (
              <button
                onClick={() => setMode('remote')}
                className={clsx(
                  'flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors',
                  mode === 'remote'
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                )}
              >
                <Globe className="size-4" />
                Code
              </button>
            )}
          </div>

          {/* Host connection */}
          {mode === 'local' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm text-[var(--color-text-secondary)]">
                  Hostname or IP
                </span>
                <input
                  ref={hostInputRef}
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isConnecting}
                  placeholder="localhost"
                  className={clsx(
                    'w-full rounded-xl bg-[var(--color-surface-light)] px-4 py-3',
                    'text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]',
                    'outline-none transition-colors',
                    'focus:ring-2 focus:ring-[var(--color-primary)]/50',
                    isConnecting && 'cursor-not-allowed opacity-50',
                  )}
                />
              </label>
              <p className="text-xs text-[var(--color-text-muted)]">
                Connect to discover active Claude sessions on this host.
                Use hostname:port for non-default ports.
              </p>
            </div>
          )}

          {/* Code connection */}
          {mode === 'remote' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm text-[var(--color-text-secondary)]">
                  Connection Code
                </span>
                <CodeInput value={code} onChange={setCode} disabled={isConnecting} />
              </label>
              <p className="text-xs text-[var(--color-text-muted)]">
                Enter the 8-digit code from <span className="font-mono text-[var(--color-text-secondary)]">remi code</span> for remote access.
              </p>
            </div>
          )}

          {/* Status/Error */}
          {(isConnecting || isAuthenticating || isConnected || error) && (
            <div
              className={clsx(
                'mt-4 flex items-center gap-2 rounded-lg p-3',
                error && 'bg-[var(--color-error)]/10 text-[var(--color-error)]',
                (isConnecting || isAuthenticating) && 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]',
                isConnected && 'bg-[var(--color-success)]/10 text-[var(--color-success)]',
              )}
            >
              {(isConnecting || isAuthenticating) && (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span className="text-sm">
                    {isAuthenticating ? 'Authenticating...' : 'Connecting...'}
                  </span>
                </>
              )}
              {isConnected && (
                <>
                  <CheckCircle2 className="size-4" />
                  <span className="text-sm">Connected</span>
                </>
              )}
              {error && (
                <>
                  <AlertCircle className="size-4" />
                  <span className="text-sm">{error}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-[var(--color-border)] p-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-[var(--color-surface-light)] py-2.5 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-elevated)]"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            disabled={!canConnect || isConnecting || isAuthenticating || isConnected}
            className={clsx(
              'flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white transition-colors',
              canConnect && !isConnecting && !isAuthenticating && !isConnected
                ? 'bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)]'
                : 'cursor-not-allowed bg-[var(--color-primary)]/50',
            )}
          >
            {isConnecting || isAuthenticating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Monitor className="size-4" />
            )}
            {isConnecting || isAuthenticating ? 'Discovering...' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
