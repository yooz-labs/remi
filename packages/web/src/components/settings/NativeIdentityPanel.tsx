import type { NativeSigningIdentity } from '@/lib/client-signer';
import {
  type NativeIdentityState,
  chooseNativeIdentity,
  inspectNativeIdentity,
  unlockNativeIdentity,
} from '@/lib/native-identity';
import { useEffect, useRef, useState } from 'react';

/** Runtime migration choices are explicit; neither durable key is silently replaced. */
export function NativeIdentityPanel({
  onReady,
  gate = false,
}: {
  readonly onReady?: (identity: NativeSigningIdentity | null) => void;
  readonly gate?: boolean;
}) {
  const actionRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<NativeIdentityState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const inspect = async () => {
      try {
        const next = await inspectNativeIdentity(controller.signal);
        if (!active) return;
        setState(next);
        onReady?.(next.kind === 'ready' ? next.identity : null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Native identity unavailable.');
        onReady?.(null);
      }
    };
    void inspect();
    window.addEventListener('focus', inspect);
    return () => {
      active = false;
      controller.abort();
      actionRef.current?.abort();
      window.removeEventListener('focus', inspect);
    };
  }, [onReady]);

  const run = async (action: (signal: AbortSignal) => Promise<NativeIdentityState>) => {
    actionRef.current?.abort();
    const controller = new AbortController();
    actionRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const next = await action(controller.signal);
      if (controller.signal.aborted) return;
      setState(next);
      setPassphrase('');
      onReady?.(next.kind === 'ready' ? next.identity : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Native identity request failed.');
    } finally {
      setBusy(false);
    }
  };

  if (gate && state?.kind === 'ready') return null;
  const fingerprint =
    state?.kind === 'ready'
      ? state.identity.fingerprint
      : state && state.kind !== 'migration'
        ? state.native.fingerprint
        : state?.native?.fingerprint;
  return (
    <section
      className={
        gate
          ? 'fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-surface)] p-6'
          : 'space-y-3'
      }
    >
      <div className="max-w-xl space-y-4">
        <h2 className="text-lg font-semibold">Native identity</h2>
        <p>
          The device Keychain holds this signing key. Remi’s web view receives public identity and
          signatures. Private key export is unavailable.
        </p>
        {fingerprint && <p className="break-all font-mono">{fingerprint}</p>}
        {state?.kind === 'migration' && (
          <>
            <p>
              A legacy web identity is still stored on this device. Choose which identity to keep
              before connecting.
            </p>
            {state.native && (
              <p>
                Native fingerprint: <span className="font-mono">{state.native.fingerprint}</span>
              </p>
            )}
            <p>
              Legacy fingerprint: <span className="font-mono">{state.legacyFingerprint}</span>
            </p>
            <p>
              Import stores the key in the device Keychain, replacing passphrase encryption at rest.
              A protected legacy identity retains app unlock and cannot answer from the lock screen.
            </p>
            {state.legacy.salt && (
              <input
                type="password"
                autoComplete="off"
                aria-label="Legacy identity passphrase"
                placeholder="Legacy passphrase to import"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                className="rounded border p-2"
              />
            )}
            <div className="flex flex-wrap gap-3">
              {state.native && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run((signal) => chooseNativeIdentity(state, 'native', undefined, signal))
                  }
                >
                  Use existing native identity (recommended)
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run((signal) =>
                    chooseNativeIdentity(state, 'legacy', passphrase || undefined, signal),
                  )
                }
              >
                Import legacy identity
              </button>
            </div>
          </>
        )}
        {state?.kind === 'locked' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run((signal) => unlockNativeIdentity(state.native, signal))}
          >
            Unlock Identity
          </button>
        )}
        {state?.kind === 'restart' && (
          <p>
            The native identity changed. Restart Remi before connecting; the previous monitor
            connection has stopped.
          </p>
        )}
        {state?.kind === 'ready' && (
          <>
            {state.identity.requiresAppUnlock && (
              <p>App unlock required. Background and lock-screen answers are disabled.</p>
            )}
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(
                  JSON.stringify(
                    {
                      publicKey: state.identity.publicKeyRaw,
                      fingerprint: state.identity.fingerprint,
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              Copy public identity
            </button>
          </>
        )}
        {!state && !error && <p>Loading durable identity…</p>}
        {error && <p role="alert">{error}</p>}
        {busy && <output>Checking durable native storage…</output>}
      </div>
    </section>
  );
}
