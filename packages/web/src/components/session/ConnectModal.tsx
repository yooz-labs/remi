/**
 * ConnectModal component.
 *
 * Modal for connecting to a daemon via direct URL or connection code.
 * Includes passphrase prompt when daemon requires authentication.
 */

import type { ConnectionStatus } from '@/types';
import { clsx } from 'clsx';
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Key,
  Link2,
  Loader2,
  Shield,
  Wifi,
  X,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';

interface ConnectModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConnectDirect: (url: string, directory?: string) => void;
  readonly onConnectCode: (code: string) => void;
  readonly connectionStatus: ConnectionStatus;
  readonly error?: string | null;
  readonly needsPassphrase?: boolean;
  readonly hasIdentity?: boolean;
  readonly serverFingerprint?: string | null;
  readonly onPassphraseSubmit?: (passphrase: string) => Promise<void>;
}

type ConnectionMode = 'direct' | 'code';

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
    // Format: ABCD-1234
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
        'w-full rounded-xl bg-[--color-surface-light] px-4 py-3',
        'text-center text-2xl font-mono tracking-widest',
        'text-[--color-text] placeholder:text-[--color-text-muted]',
        'outline-none transition-colors',
        'focus:ring-2 focus:ring-[--color-primary]/50',
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
        <Shield className="mx-auto size-10 text-[--color-warning]" />
        <p className="text-sm text-[--color-text]">
          This daemon requires authentication, but no identity is configured.
        </p>
        <p className="text-xs text-[--color-text-muted]">
          Generate an identity in Settings, or import one from another device.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg bg-[--color-surface-light] p-3">
        <Shield className="size-5 shrink-0 text-[--color-primary]" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[--color-text]">Authentication Required</p>
          {serverFingerprint && (
            <p className="truncate text-xs font-mono text-[--color-text-muted]">
              Server: {serverFingerprint}
            </p>
          )}
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm text-[--color-text-secondary]">
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
            'w-full rounded-xl bg-[--color-surface-light] px-4 py-3',
            'text-sm text-[--color-text] placeholder:text-[--color-text-muted]',
            'outline-none transition-colors',
            'focus:ring-2 focus:ring-[--color-primary]/50',
            isSubmitting && 'cursor-not-allowed opacity-50',
          )}
        />
      </label>

      {passphraseError && (
        <div className="flex items-center gap-2 rounded-lg bg-[--color-error]/10 p-3 text-[--color-error]">
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
            ? 'bg-[--color-primary] hover:bg-[--color-primary-dark]'
            : 'cursor-not-allowed bg-[--color-primary]/50',
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
  const [mode, setMode] = useState<ConnectionMode>('direct');
  const [directUrl, setDirectUrl] = useState('ws://localhost:18765/ws');
  const [directory, setDirectory] = useState('');
  const [code, setCode] = useState('');

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setCode('');
      setDirectUrl(localStorage.getItem('remi-last-url') || 'ws://localhost:18765/ws');
      setDirectory('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
  const isAuthenticating = connectionStatus === 'authenticating';
  const isConnected = connectionStatus === 'connected';

  // Show passphrase view when auth is needed
  if (needsPassphrase && onPassphraseSubmit) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-[--color-surface] shadow-xl">
          <div className="flex items-center justify-between border-b border-[--color-border] p-4">
            <h2 className="text-lg font-semibold text-[--color-text]">Authenticate</h2>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text]"
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
    if (mode === 'direct') {
      onConnectDirect(directUrl, directory || undefined);
    } else {
      onConnectCode(code);
    }
  };

  const canConnect = mode === 'direct' ? directUrl.trim() : code.length === 9;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-[--color-surface] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[--color-border] p-4">
          <h2 className="text-lg font-semibold text-[--color-text]">Connect to Daemon</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-[--color-text-secondary] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text]"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {/* Mode tabs */}
          <div className="mb-4 flex gap-2 rounded-xl bg-[--color-surface-light] p-1">
            <button
              onClick={() => setMode('direct')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors',
                mode === 'direct'
                  ? 'bg-[--color-primary] text-white'
                  : 'text-[--color-text-secondary] hover:text-[--color-text]',
              )}
            >
              <Wifi className="size-4" />
              Direct
            </button>
            <button
              onClick={() => setMode('code')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors',
                mode === 'code'
                  ? 'bg-[--color-primary] text-white'
                  : 'text-[--color-text-secondary] hover:text-[--color-text]',
              )}
            >
              <Globe className="size-4" />
              Remote
            </button>
          </div>

          {/* Direct connection */}
          {mode === 'direct' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm text-[--color-text-secondary]">
                  WebSocket URL
                </span>
                <input
                  type="text"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  disabled={isConnecting}
                  placeholder="ws://localhost:3847/ws"
                  className={clsx(
                    'w-full rounded-xl bg-[--color-surface-light] px-4 py-3',
                    'text-sm text-[--color-text] placeholder:text-[--color-text-muted]',
                    'outline-none transition-colors',
                    'focus:ring-2 focus:ring-[--color-primary]/50',
                    isConnecting && 'cursor-not-allowed opacity-50',
                  )}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-[--color-text-secondary]">
                  Working Directory (optional)
                </span>
                <input
                  type="text"
                  value={directory}
                  onChange={(e) => setDirectory(e.target.value)}
                  disabled={isConnecting}
                  placeholder="~/Documents/git/myproject"
                  className={clsx(
                    'w-full rounded-xl bg-[--color-surface-light] px-4 py-3',
                    'text-sm text-[--color-text] placeholder:text-[--color-text-muted]',
                    'outline-none transition-colors',
                    'focus:ring-2 focus:ring-[--color-primary]/50',
                    isConnecting && 'cursor-not-allowed opacity-50',
                  )}
                />
              </label>
              <p className="text-xs text-[--color-text-muted]">
                Connect directly when on the same network as the daemon.
              </p>
            </div>
          )}

          {/* Code connection */}
          {mode === 'code' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm text-[--color-text-secondary]">
                  Connection Code
                </span>
                <CodeInput value={code} onChange={setCode} disabled={isConnecting} />
              </label>
              <p className="text-xs text-[--color-text-muted]">
                Enter the code displayed by the daemon for remote access via WebRTC.
              </p>
            </div>
          )}

          {/* Status/Error */}
          {(isConnecting || isAuthenticating || isConnected || error) && (
            <div
              className={clsx(
                'mt-4 flex items-center gap-2 rounded-lg p-3',
                error && 'bg-[--color-error]/10 text-[--color-error]',
                (isConnecting || isAuthenticating) && 'bg-[--color-warning]/10 text-[--color-warning]',
                isConnected && 'bg-[--color-success]/10 text-[--color-success]',
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
                  <span className="text-sm">Connected!</span>
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
        <div className="flex gap-3 border-t border-[--color-border] p-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-[--color-surface-light] py-2.5 text-sm font-medium text-[--color-text] transition-colors hover:bg-[--color-surface-elevated]"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            disabled={!canConnect || isConnecting || isAuthenticating || isConnected}
            className={clsx(
              'flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white transition-colors',
              canConnect && !isConnecting && !isAuthenticating && !isConnected
                ? 'bg-[--color-primary] hover:bg-[--color-primary-dark]'
                : 'cursor-not-allowed bg-[--color-primary]/50',
            )}
          >
            {isConnecting || isAuthenticating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Link2 className="size-4" />
            )}
            {isConnecting || isAuthenticating ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
