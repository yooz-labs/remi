/**
 * ConnectModal component.
 *
 * Modal for connecting to a daemon via direct URL or connection code.
 * Warm conversational design with mobile-first touch targets.
 */

import { type PairedDevice, getPairedDevices, removePairedDevice } from '@/lib/device-store';
import type { ConnectionStatus } from '@/types';
import { clsx } from 'clsx';
import { AlertCircle, CheckCircle2, Globe, Loader2, Trash2, Wifi, X } from 'lucide-react';
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';

interface ConnectModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConnectDirect: (url: string, directory?: string) => void;
  readonly onConnectCode: (code: string) => void;
  readonly onConnectDevice?: (device: PairedDevice) => void;
  readonly connectionStatus: ConnectionStatus;
  readonly error?: string | null;
}

type ConnectionMode = 'direct' | 'code';

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Split code input: 4 letter boxes + dash + 4 number boxes */
function SplitCodeInput({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Strip the dash for internal tracking
  const raw = value.replace(/-/g, '');
  const chars = raw.split('');

  const focusInput = (index: number) => {
    if (index >= 0 && index < 8) {
      inputRefs.current[index]?.focus();
    }
  };

  const handleInput = (index: number, e: ChangeEvent<HTMLInputElement>) => {
    const char = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!char) return;

    const newChars = [...chars];
    // Pad with empty if needed
    while (newChars.length < index) newChars.push('');
    newChars[index] = char[0] ?? '';

    const newRaw = newChars.join('').slice(0, 8);
    const formatted =
      newRaw.length > 4 ? `${newRaw.slice(0, 4)}-${newRaw.slice(4)}` : newRaw;
    onChange(formatted);

    // Auto-advance
    if (index < 7) {
      focusInput(index + 1);
    }

    // Auto-submit when complete
    if (newRaw.length === 8 && index === 7) {
      onSubmit();
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const newChars = [...chars];
      if (newChars[index]) {
        newChars[index] = '';
      } else if (index > 0) {
        newChars[index - 1] = '';
        focusInput(index - 1);
      }
      const newRaw = newChars.join('');
      const formatted =
        newRaw.length > 4 ? `${newRaw.slice(0, 4)}-${newRaw.slice(4)}` : newRaw;
      onChange(formatted);
    } else if (e.key === 'ArrowLeft') {
      focusInput(index - 1);
    } else if (e.key === 'ArrowRight') {
      focusInput(index + 1);
    } else if (e.key === 'Enter' && raw.length === 8) {
      onSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData
      .getData('text')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    const formatted =
      pasted.length > 4 ? `${pasted.slice(0, 4)}-${pasted.slice(4)}` : pasted;
    onChange(formatted);
    focusInput(Math.min(pasted.length, 7));
    if (pasted.length === 8) {
      onSubmit();
    }
  };

  return (
    <div className="flex items-center justify-center gap-[5px] sm:gap-1.5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={`code-box-${i}`} className="contents">
          {i === 4 && (
            <span className="text-base font-bold text-[--color-text-muted] select-none">
              -
            </span>
          )}
          <input
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type="text"
            inputMode={i >= 4 ? 'numeric' : 'text'}
            value={chars[i] ?? ''}
            onChange={(e) => handleInput(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            disabled={disabled}
            maxLength={1}
            aria-label={`Code character ${i + 1}`}
            className={clsx(
              'h-11 w-9 sm:size-11 rounded-lg sm:rounded-xl text-center text-lg font-mono font-bold',
              'bg-[--color-surface-light] text-[--color-text]',
              'border border-[--color-border]',
              'outline-none transition-all duration-150',
              'focus:bg-[--color-surface-elevated] focus:ring-2 focus:ring-[--color-primary]/60 focus:scale-105 focus:border-[--color-primary]/40',
              disabled && 'cursor-not-allowed opacity-40',
              chars[i] && 'bg-[--color-surface-elevated] border-[--color-primary]/30',
            )}
          />
        </div>
      ))}
    </div>
  );
}

export function ConnectModal({
  isOpen,
  onClose,
  onConnectDirect,
  onConnectCode,
  onConnectDevice,
  connectionStatus,
  error,
}: ConnectModalProps) {
  const [mode, setMode] = useState<ConnectionMode>('code');
  const [directUrl, setDirectUrl] = useState('ws://localhost:18765/ws');
  const [directory, setDirectory] = useState('');
  const [code, setCode] = useState('');
  const [isVisible, setIsVisible] = useState(false);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);

  // Animate in
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  // Load paired devices and reset on open/close
  useEffect(() => {
    if (isOpen) {
      setPairedDevices(getPairedDevices());
    } else {
      setCode('');
      setDirectUrl(localStorage.getItem('remi-last-url') || 'ws://localhost:18765/ws');
      setDirectory('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
  const isConnected = connectionStatus === 'connected';

  const handleConnect = () => {
    if (mode === 'direct') {
      onConnectDirect(directUrl, directory || undefined);
    } else {
      onConnectCode(code);
    }
  };

  const canConnect = mode === 'direct' ? directUrl.trim() : code.replace(/-/g, '').length === 8;

  return (
    <div
      className={clsx(
        'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4',
        'transition-colors duration-300',
        isVisible ? 'bg-black/40 backdrop-blur-sm' : 'bg-black/0',
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={() => {}}
      role="presentation"
    >
      <div
        className={clsx(
          'w-full sm:max-w-sm',
          'rounded-t-3xl sm:rounded-3xl',
          'bg-[--color-surface] shadow-2xl border border-[--color-border]/50',
          'transition-all duration-300 ease-out',
          isVisible
            ? 'translate-y-0 opacity-100 scale-100'
            : 'translate-y-8 opacity-0 scale-[0.97]',
        )}
      >
        {/* Pull indicator (mobile) */}
        <div className="flex justify-center pt-3 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-[--color-border]" />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-1">
          <div>
            <h2 className="text-xl font-bold text-[--color-text]">
              {isConnected ? 'Connected' : 'Connect'}
            </h2>
            <p className="mt-0.5 text-sm text-[--color-text-muted]">
              {isConnected
                ? 'Your agent is linked'
                : mode === 'code'
                  ? 'Enter the code from your terminal'
                  : 'Connect to a daemon on your network'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-0.5 rounded-full p-2 text-[--color-text-muted] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text] active:scale-95"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Paired devices */}
        {pairedDevices.length > 0 && onConnectDevice && (
          <div className="px-6 pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[--color-text-muted]">
              Your Devices
            </p>
            <div className="space-y-1.5">
              {pairedDevices.map((device) => (
                <div
                  key={device.deviceId}
                  className="flex items-center justify-between rounded-2xl border border-[--color-border]/50 bg-[--color-surface-light] px-4 py-3"
                >
                  <button
                    type="button"
                    onClick={() => onConnectDevice(device)}
                    disabled={isConnecting || isConnected}
                    className="flex-1 text-left"
                  >
                    <span className="block text-sm font-semibold text-[--color-text]">
                      {device.deviceId}
                    </span>
                    <span className="text-xs text-[--color-text-muted]">
                      Last connected {formatRelativeTime(device.lastConnectedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removePairedDevice(device.deviceId);
                      setPairedDevices(getPairedDevices());
                    }}
                    className="ml-2 rounded-full p-1.5 text-[--color-text-muted] transition-colors hover:bg-[--color-surface-elevated] hover:text-[--color-error]"
                    aria-label={`Forget ${device.deviceId}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-[--color-border]/50" />
              <span className="text-xs text-[--color-text-muted]">or pair a new device</span>
              <div className="h-px flex-1 bg-[--color-border]/50" />
            </div>
          </div>
        )}

        {/* Content */}
        <div className={clsx('px-6 pb-2', pairedDevices.length > 0 ? 'pt-0' : 'pt-4')}>
          {/* Mode toggle */}
          <div className="mb-5 flex rounded-2xl bg-[--color-surface-light] border border-[--color-border]/50 p-1">
            <button
              type="button"
              onClick={() => setMode('code')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold',
                'transition-all duration-200',
                mode === 'code'
                  ? 'bg-[--color-primary] text-white shadow-md shadow-[--color-primary]/25'
                  : 'text-[--color-text-muted] hover:text-[--color-text] active:scale-[0.97]',
              )}
            >
              <Globe className="size-4" />
              Remote
            </button>
            <button
              type="button"
              onClick={() => setMode('direct')}
              className={clsx(
                'flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold',
                'transition-all duration-200',
                mode === 'direct'
                  ? 'bg-[--color-primary] text-white shadow-md shadow-[--color-primary]/25'
                  : 'text-[--color-text-muted] hover:text-[--color-text] active:scale-[0.97]',
              )}
            >
              <Wifi className="size-4" />
              Local
            </button>
          </div>

          {/* Code connection */}
          {mode === 'code' && (
            <div className="space-y-4">
              <SplitCodeInput
                value={code}
                onChange={setCode}
                onSubmit={handleConnect}
                disabled={isConnecting || isConnected}
              />
              <p className="text-center text-xs text-[--color-text-muted]">
                Run <code className="rounded bg-[--color-surface-light] px-1.5 py-0.5 font-mono text-[--color-text-secondary]">remi --remote</code> to get a code
              </p>
            </div>
          )}

          {/* Direct connection */}
          {mode === 'direct' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[--color-text-muted]">
                  Daemon URL
                </span>
                <input
                  type="text"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && canConnect && handleConnect()}
                  disabled={isConnecting}
                  placeholder="ws://localhost:3847/ws"
                  className={clsx(
                    'w-full rounded-2xl bg-[--color-surface-light] px-4 py-3.5',
                    'text-sm text-[--color-text] placeholder:text-[--color-text-muted]',
                    'border border-[--color-border]',
                    'outline-none transition-all duration-150',
                    'focus:bg-[--color-surface-elevated] focus:ring-2 focus:ring-[--color-primary]/50 focus:border-[--color-primary]/40',
                    isConnecting && 'cursor-not-allowed opacity-40',
                  )}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[--color-text-muted]">
                  Directory <span className="normal-case tracking-normal font-normal">(optional)</span>
                </span>
                <input
                  type="text"
                  value={directory}
                  onChange={(e) => setDirectory(e.target.value)}
                  disabled={isConnecting}
                  placeholder="~/my-project"
                  className={clsx(
                    'w-full rounded-2xl bg-[--color-surface-light] px-4 py-3.5',
                    'text-sm text-[--color-text] placeholder:text-[--color-text-muted]',
                    'border border-[--color-border]',
                    'outline-none transition-all duration-150',
                    'focus:bg-[--color-surface-elevated] focus:ring-2 focus:ring-[--color-primary]/50 focus:border-[--color-primary]/40',
                    isConnecting && 'cursor-not-allowed opacity-40',
                  )}
                />
              </label>
            </div>
          )}

          {/* Status/Error */}
          {(isConnecting || isConnected || error) && (
            <div
              className={clsx(
                'mt-4 flex items-center gap-2.5 rounded-2xl px-4 py-3',
                'transition-all duration-200',
                error && 'bg-[--color-error]/10 text-[--color-error]',
                isConnecting && 'bg-[--color-primary]/10 text-[--color-primary]',
                isConnected && 'bg-[--color-success]/10 text-[--color-success]',
              )}
            >
              {isConnecting && (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span className="text-sm font-medium">Reaching your agent...</span>
                </>
              )}
              {isConnected && (
                <>
                  <CheckCircle2 className="size-4" />
                  <span className="text-sm font-medium">You're in</span>
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

        {/* Action */}
        <div className="px-6 pt-3 pb-6">
          <button
            type="button"
            onClick={handleConnect}
            disabled={!canConnect || isConnecting || isConnected}
            className={clsx(
              'w-full rounded-2xl py-4 text-base font-semibold text-white',
              'transition-all duration-200',
              'active:scale-[0.98]',
              canConnect && !isConnecting && !isConnected
                ? 'bg-[--color-primary] shadow-lg shadow-[--color-primary]/25 hover:shadow-xl hover:shadow-[--color-primary]/30 hover:brightness-110'
                : 'cursor-not-allowed bg-[--color-primary]/30',
            )}
          >
            {isConnecting ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="size-5 animate-spin" />
                Connecting...
              </span>
            ) : isConnected ? (
              'Connected'
            ) : mode === 'code' ? (
              'Join Session'
            ) : (
              'Connect'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
