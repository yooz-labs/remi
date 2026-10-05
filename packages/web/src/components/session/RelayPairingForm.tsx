import { usesNativeIdentity } from '@/lib/native-identity';
import { readNativePairingQR } from '@/lib/native-pairing-qr';
import type { ConnectionState } from '@/types';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  readonly connection?: ConnectionState;
  readonly onPair: (token: string, signal: AbortSignal) => Promise<void>;
  readonly needsUnlock: boolean;
  readonly onUnlockNative?: () => Promise<void>;
  readonly onUnlock?: (passphrase: string) => Promise<void>;
}
interface QRDetector {
  detect(source: HTMLVideoElement): Promise<readonly { rawValue: string }[]>;
}
type QRConstructor = new (options: { formats: string[] }) => QRDetector;

/** Ticket text lives only in this open form and its one pending handshake. */
export function RelayPairingForm({
  connection,
  onPair,
  needsUnlock,
  onUnlock,
  onUnlockNative,
}: Props) {
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const controller = useRef<AbortController | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const qrController = useRef<AbortController | null>(null);
  const [selectingQR, setSelectingQR] = useState(false);
  const scanGeneration = useRef(0);
  const stopCamera = useCallback(() => {
    ++scanGeneration.current;
    qrController.current?.abort();
    qrController.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);
  useEffect(
    () => () => {
      controller.current?.abort();
      stopCamera();
    },
    [stopCamera],
  );

  const scan = async () => {
    stopCamera();
    setError(null);
    const generation = scanGeneration.current;
    if (usesNativeIdentity()) {
      const attempt = new AbortController();
      qrController.current = attempt;
      setSelectingQR(true);
      try {
        const selected = await readNativePairingQR(attempt.signal);
        if (selected && generation === scanGeneration.current) setToken(selected);
      } catch (cause) {
        if (!attempt.signal.aborted && generation === scanGeneration.current)
          setError(
            cause instanceof Error ? cause.message : 'QR image unavailable. Paste the token.',
          );
      } finally {
        if (generation === scanGeneration.current) {
          qrController.current = null;
          setSelectingQR(false);
        }
      }
      return;
    }
    const Detector = (window as Window & { BarcodeDetector?: QRConstructor }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setError('QR scanning is unavailable here. Paste the pairing token from the daemon.');
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      if (generation !== scanGeneration.current) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream.current = media;
      setScanning(true);
      const detector = new Detector({ formats: ['qr_code'] });
      // Wait for React to mount the video after the explicit camera action.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!video.current || generation !== scanGeneration.current) return;
      video.current.srcObject = media;
      await video.current.play();
      while (generation === scanGeneration.current && video.current) {
        const codes = await detector.detect(video.current);
        if (generation !== scanGeneration.current) return;
        const value = codes.find((code) => code.rawValue.startsWith('remi-pair2:'))?.rawValue;
        if (value) {
          setToken(value);
          stopCamera();
          setScanning(false);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      }
    } catch {
      if (generation === scanGeneration.current)
        setError('Camera or QR scan unavailable. Paste the pairing token.');
    } finally {
      if (generation === scanGeneration.current) {
        stopCamera();
        setScanning(false);
      }
    }
  };
  const submit = async () => {
    if (busy || !token.trim()) return;
    controller.current?.abort();
    const attempt = new AbortController();
    controller.current = attempt;
    setBusy(true);
    setError(null);
    stopCamera();
    setScanning(false);
    try {
      if (needsUnlock) {
        if (onUnlockNative) await onUnlockNative();
        else if (onUnlock) {
          await onUnlock(passphrase);
          setPassphrase('');
        } else throw new Error('Unlock your identity before pairing.');
      }
      if (attempt.signal.aborted) return;
      const text = token.trim();
      setToken('');
      await onPair(text, attempt.signal);
    } catch (cause) {
      if (!attempt.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Pairing failed.');
    } finally {
      if (!attempt.signal.aborted) setBusy(false);
    }
  };
  const waiting =
    connection && ['connecting', 'authenticating', 'reconnecting'].includes(connection.status);
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Run <code>remi pair</code> on the daemon machine. Scan its QR or paste the complete token.
        Approval happens on that machine.
      </p>
      {!waiting && (
        <>
          <label className="block text-sm">
            Pairing token
            <textarea
              aria-label="Pairing token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              rows={3}
              maxLength={4096}
              placeholder="remi-pair2:…"
              className="mt-1 w-full rounded-lg bg-[var(--color-surface-light)] p-3 font-mono text-xs break-all"
            />
          </label>
          {needsUnlock && !onUnlockNative && (
            <label className="block text-sm">
              Identity passphrase
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-lg bg-[var(--color-surface-light)] p-3"
              />
            </label>
          )}
          {needsUnlock && onUnlockNative && (
            <button
              type="button"
              onClick={() =>
                void onUnlockNative().catch(() => setError('Native identity unlock failed.'))
              }
            >
              Unlock Identity
            </button>
          )}
          <button
            type="button"
            onClick={() => void scan()}
            disabled={busy || selectingQR}
            className="rounded-lg bg-[var(--color-surface-light)] px-4 py-2 text-sm"
          >
            {usesNativeIdentity() ? 'Choose QR image' : 'Scan QR'}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !token.trim() || (needsUnlock && !onUnlockNative && !passphrase)}
            className="ml-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm text-[var(--color-accent-ink)] disabled:opacity-50"
          >
            {busy ? 'Pairing…' : 'Start pairing'}
          </button>
        </>
      )}
      {selectingQR && (
        <button
          type="button"
          onClick={() => {
            stopCamera();
            setSelectingQR(false);
          }}
        >
          Cancel QR selection
        </button>
      )}
      {scanning && (
        <div>
          <video ref={video} muted playsInline className="w-full rounded-lg" />
          <button
            type="button"
            onClick={() => {
              stopCamera();
              setScanning(false);
            }}
          >
            Stop camera
          </button>
        </div>
      )}
      {connection?.relayConfirmation && (
        <div className="rounded-lg bg-[var(--color-surface-light)] p-3">
          <p className="font-medium">Compare on the daemon machine</p>
          <p className="break-all font-mono text-sm">{connection.relayConfirmation}</p>
          <p className="text-xs">
            Verify this fingerprint matches exactly, then approve locally. This client cannot
            approve itself.
          </p>
        </div>
      )}
      {waiting && !connection.relayConfirmation && <p>Connecting securely…</p>}
      {(error || connection?.error) && (
        <p role="alert" className="text-sm text-[var(--color-error)]">
          {error ?? connection?.error}
        </p>
      )}
      {connection?.status === 'disconnected' && (
        <p className="text-sm">
          Pairing or connection ended. An unconfirmed token is never retried automatically. Generate
          a new token if needed.
        </p>
      )}
    </div>
  );
}
