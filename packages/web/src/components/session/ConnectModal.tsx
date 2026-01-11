/**
 * ConnectModal component.
 *
 * Modal for connecting to a daemon via direct URL or connection code.
 */

import { useState, useRef, useEffect, type ChangeEvent } from 'react';
import { clsx } from 'clsx';
import {
  X,
  Wifi,
  Globe,
  Link2,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import type { ConnectionStatus } from '@/types';

interface ConnectModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConnectDirect: (url: string) => void;
  readonly onConnectCode: (code: string) => void;
  readonly connectionStatus: ConnectionStatus;
  readonly error?: string | null;
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
    const formatted =
      raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}` : raw;
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

export function ConnectModal({
  isOpen,
  onClose,
  onConnectDirect,
  onConnectCode,
  connectionStatus,
  error,
}: ConnectModalProps) {
  const [mode, setMode] = useState<ConnectionMode>('direct');
  const [directUrl, setDirectUrl] = useState('ws://localhost:8765/ws');
  const [code, setCode] = useState('');

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setCode('');
      setDirectUrl('ws://localhost:8765/ws');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isConnecting =
    connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
  const isConnected = connectionStatus === 'connected';

  const handleConnect = () => {
    if (mode === 'direct') {
      onConnectDirect(directUrl);
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
          <h2 className="text-lg font-semibold text-[--color-text]">
            Connect to Daemon
          </h2>
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
                <CodeInput
                  value={code}
                  onChange={setCode}
                  disabled={isConnecting}
                />
              </label>
              <p className="text-xs text-[--color-text-muted]">
                Enter the code displayed by the daemon for remote access via
                WebRTC.
              </p>
            </div>
          )}

          {/* Status/Error */}
          {(isConnecting || isConnected || error) && (
            <div
              className={clsx(
                'mt-4 flex items-center gap-2 rounded-lg p-3',
                error && 'bg-[--color-error]/10 text-[--color-error]',
                isConnecting && 'bg-[--color-warning]/10 text-[--color-warning]',
                isConnected && 'bg-[--color-success]/10 text-[--color-success]',
              )}
            >
              {isConnecting && (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span className="text-sm">Connecting...</span>
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
            disabled={!canConnect || isConnecting || isConnected}
            className={clsx(
              'flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white transition-colors',
              canConnect && !isConnecting && !isConnected
                ? 'bg-[--color-primary] hover:bg-[--color-primary-dark]'
                : 'cursor-not-allowed bg-[--color-primary]/50',
            )}
          >
            {isConnecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Link2 className="size-4" />
            )}
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
