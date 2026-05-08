/**
 * ConnectModal component.
 *
 * Simplified connection flow: enter a host to discover sessions,
 * or use a connection code for remote access via WebRTC.
 */

import { useKeyboard } from '@/hooks/useKeyboard';
import { probeAuthInfo } from '@/lib/auth-probe';
import { isIdentityEncrypted } from '@/lib/identity-client';
import { keyboardBackdropStyle } from '@/lib/keyboard-style';
import {
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
  buildWsUrl,
  discoverDaemonPort,
  parseHostInput,
} from '@/lib/port-discovery';
import type { ConnectionStatus } from '@/types';
import { clsx } from 'clsx';
import { AlertCircle, CheckCircle2, Globe, Key, Loader2, Monitor, Shield, X } from 'lucide-react';
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
  /**
   * True if the parent already holds an unlocked identity for this session.
   * When set, the inline pre-flight prompt is skipped because the daemon
   * challenge will be answered silently from the cache (#257).
   */
  readonly hasUnlockedIdentity?: boolean;
}

type ConnectionMode = 'local' | 'remote';

const LOCALSTORAGE_HOST_KEY = 'remi-last-host';

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
      // Connection codes are uppercase alphanumerics — strip iOS dictation
      // and predictive entry the same way the host field does (#266).
      autoCorrect="off"
      autoCapitalize="characters"
      spellCheck={false}
      autoComplete="off"
      inputMode="text"
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
      setPassphraseError(err instanceof Error ? err.message : 'Failed to unlock identity');
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
        <span className="mb-1 block text-sm text-[var(--color-text-secondary)]">Passphrase</span>
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
        {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Key className="size-4" />}
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
  hasUnlockedIdentity = false,
}: ConnectModalProps) {
  const [mode, setMode] = useState<ConnectionMode>('local');
  const [host, setHost] = useState(
    () => localStorage.getItem(LOCALSTORAGE_HOST_KEY) || 'localhost',
  );
  const [code, setCode] = useState('');
  const hostInputRef = useRef<HTMLInputElement>(null);
  // Track the iOS keyboard so we can lift the modal above it (#226 part 1).
  // Capacitor's keyboardWillShow fires synchronously enough that the modal
  // reflows before the OS animates the keyboard in, avoiding the "input
  // disappears behind the keyboard" flash. Style derivation is in
  // keyboardBackdropStyle so it can be unit-tested.
  const keyboard = useKeyboard();
  const backdropStyle = keyboardBackdropStyle(keyboard);

  // Pre-flight passphrase state (#257):
  //   When the daemon advertises authRequired=true via /auth-info, surface
  //   the passphrase prompt INSIDE the connect modal before opening the
  //   WebSocket. This avoids the "connecting then suddenly asking for a
  //   passphrase" jolt and makes auth feel like part of the connect step.
  const [preflightPending, setPreflightPending] = useState<{
    wsUrl: string;
    fingerprint: string | null;
  } | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  // Active when the user typed only a hostname and we're scanning the
  // daemon port range to find a responder (#393). Distinct from `isProbing`
  // (the auth pre-flight probe) so the UI can surface a different message.
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setCode('');
      setHost(localStorage.getItem(LOCALSTORAGE_HOST_KEY) || 'localhost');
      setPreflightPending(null);
      setIsProbing(false);
      setIsScanning(false);
      setScanError(null);
    }
  }, [isOpen]);

  // Auto-focus host input when modal opens
  useEffect(() => {
    if (isOpen && mode === 'local' && !preflightPending) {
      setTimeout(() => hostInputRef.current?.focus(), 100);
    }
  }, [isOpen, mode, preflightPending]);

  if (!isOpen) return null;

  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
  const isAuthenticating = connectionStatus === 'authenticating';
  const isConnected = connectionStatus === 'connected';

  // Show passphrase view when auth is needed: either the WebSocket is
  // already mid-handshake and got an auth_challenge (post-connect), or the
  // pre-flight probe surfaced auth required up-front.
  const showPassphraseView =
    (needsPassphrase || preflightPending != null) && onPassphraseSubmit != null;
  const passphraseFingerprint = serverFingerprint ?? preflightPending?.fingerprint ?? null;

  if (showPassphraseView && onPassphraseSubmit) {
    return (
      <div
        data-testid="connect-modal-backdrop"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        style={backdropStyle}
      >
        <div className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] shadow-xl border border-[var(--color-border)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
            <h2 className="text-lg font-semibold text-[var(--color-text)]">Authenticate</h2>
            <button
              onClick={() => {
                setPreflightPending(null);
                onClose();
              }}
              className="rounded-full p-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)]"
              aria-label="Close"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="p-4">
            <PassphraseView
              serverFingerprint={passphraseFingerprint}
              hasIdentity={hasId}
              onSubmit={async (passphrase) => {
                await onPassphraseSubmit(passphrase);
                // Pre-flight: now that the identity is unlocked, open the
                // WebSocket. The daemon will challenge, but the cached
                // identity signs silently — no second prompt.
                if (preflightPending) {
                  const { wsUrl } = preflightPending;
                  setPreflightPending(null);
                  onConnectDirect(wsUrl);
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  const handleConnect = async () => {
    if (mode === 'local') {
      setScanError(null);
      const parsed = parseHostInput(host);
      localStorage.setItem(LOCALSTORAGE_HOST_KEY, host.trim());

      // Resolve a concrete port. If the user typed only a hostname (no
      // explicit port), scan the daemon range so we still find a sibling
      // when 18765 itself is empty (#393). User-supplied ports always win.
      let wsUrl: string;
      if (parsed.kind === 'wsurl') {
        wsUrl = parsed.url;
      } else if (parsed.explicitPort != null) {
        wsUrl = buildWsUrl(parsed, parsed.explicitPort);
      } else {
        if (!parsed.hostname) {
          setScanError('Hostname is required');
          return;
        }
        setIsScanning(true);
        let discovered: number | null = null;
        try {
          discovered = await discoverDaemonPort(parsed.hostname);
        } finally {
          setIsScanning(false);
        }
        if (discovered === null) {
          const last = DEFAULT_BASE_PORT + DEFAULT_PORT_RANGE - 1;
          setScanError(
            `No remi daemon found on ${parsed.hostname}:${DEFAULT_BASE_PORT}–${last}. ` +
              `Is the daemon running? You can also try host:port directly.`,
          );
          return;
        }
        wsUrl = buildWsUrl(parsed, discovered);
      }

      // Pre-flight probe (#257). When the local identity is encrypted and
      // the user hasn't already unlocked it this session, ask the daemon
      // whether it will challenge us. If yes, surface PassphraseView inside
      // this modal BEFORE opening the WebSocket. Best-effort: any probe
      // failure falls back to the legacy post-connect auth flow.
      let identityEncrypted = false;
      try {
        identityEncrypted = isIdentityEncrypted();
      } catch {
        identityEncrypted = false;
      }

      if (identityEncrypted && !hasUnlockedIdentity && onPassphraseSubmit) {
        setIsProbing(true);
        let info: Awaited<ReturnType<typeof probeAuthInfo>> = null;
        try {
          info = await probeAuthInfo(wsUrl);
        } finally {
          setIsProbing(false);
        }
        if (info?.authRequired) {
          setPreflightPending({ wsUrl, fingerprint: info.fingerprint });
          return;
        }
      }

      onConnectDirect(wsUrl);
    } else if (onConnectCode) {
      onConnectCode(code);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canConnect && !isConnecting && !isProbing && !isScanning) {
      e.preventDefault();
      void handleConnect();
    }
  };

  const canConnect = mode === 'local' ? host.trim().length > 0 : code.length === 9;

  return (
    <div
      data-testid="connect-modal-backdrop"
      className={clsx(
        'fixed inset-0 z-50 flex justify-center bg-black/60 p-4',
        // When the keyboard is open, anchor the modal to the top of the
        // remaining visible area (paired with backdropStyle's padding-bottom
        // equal to the keyboard height) so the input never sits behind the
        // keyboard on short screens.
        keyboard.isVisible ? 'items-start pt-8' : 'items-center',
      )}
      style={backdropStyle}
    >
      <div className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl bg-[var(--color-surface)] shadow-xl border border-[var(--color-border)]">
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
                  // iOS WKWebView keyboards otherwise insert dictation
                  // suggestions alongside the typed string, producing the
                  // doubled-text seen in #266 ("localhostlocalhost"). For a
                  // hostname these affordances are pure noise; turn them off
                  // and ask for the URL keyboard.
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="url"
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
                Connect to discover active Claude sessions on this host. Use hostname:port for
                non-default ports.
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
                Enter the 8-digit code from{' '}
                <span className="font-mono text-[var(--color-text-secondary)]">remi code</span> for
                remote access.
              </p>
            </div>
          )}

          {/* Status/Error */}
          {(isScanning ||
            isConnecting ||
            isAuthenticating ||
            isConnected ||
            error ||
            scanError) && (
            <div
              className={clsx(
                'mt-4 flex items-center gap-2 rounded-lg p-3',
                (error || scanError) && 'bg-[var(--color-error)]/10 text-[var(--color-error)]',
                (isScanning || isConnecting || isAuthenticating) &&
                  'bg-[var(--color-warning)]/10 text-[var(--color-warning)]',
                isConnected && 'bg-[var(--color-success)]/10 text-[var(--color-success)]',
              )}
            >
              {isScanning && (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span className="text-sm">Searching for daemon...</span>
                </>
              )}
              {!isScanning && (isConnecting || isAuthenticating) && (
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
              {(error || scanError) && (
                <>
                  <AlertCircle className="size-4" />
                  <span className="text-sm">{error ?? scanError}</span>
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
            onClick={() => {
              void handleConnect();
            }}
            disabled={
              !canConnect ||
              isConnecting ||
              isAuthenticating ||
              isConnected ||
              isProbing ||
              isScanning
            }
            className={clsx(
              'flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white transition-colors',
              canConnect &&
                !isConnecting &&
                !isAuthenticating &&
                !isConnected &&
                !isProbing &&
                !isScanning
                ? 'bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)]'
                : 'cursor-not-allowed bg-[var(--color-primary)]/50',
            )}
          >
            {isConnecting || isAuthenticating || isProbing || isScanning ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Monitor className="size-4" />
            )}
            {isScanning
              ? 'Scanning...'
              : isProbing
                ? 'Checking...'
                : isConnecting || isAuthenticating
                  ? 'Discovering...'
                  : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
