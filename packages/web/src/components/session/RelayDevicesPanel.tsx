import type { ConnectionState } from '@/types';
import type {
  RelayDevice,
  RelayDeviceRevokeResponseMessage,
  RelayDevicesResponseMessage,
} from '@remi/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  readonly connection: ConnectionState;
  readonly ownFingerprint?: string;
  readonly list: () => Promise<RelayDevicesResponseMessage>;
  readonly revoke: (fingerprint: string) => Promise<RelayDeviceRevokeResponseMessage>;
  readonly onClose: () => void;
  readonly forget: () => void;
}
/** Separate enrolled-key narrowing requests. This view never holds local pairing capability. */
export function RelayDevicesPanel({
  connection,
  ownFingerprint,
  list,
  revoke,
  onClose,
  forget,
}: Props) {
  const [devices, setDevices] = useState<readonly RelayDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const lifetime = useRef(0);
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(
    () => () => {
      ++lifetime.current;
    },
    [],
  );
  const refresh = useCallback(async () => {
    const generation = lifetime.current;
    setBusy(true);
    setNotice('');
    try {
      const response = await listRef.current();
      if (generation === lifetime.current) setDevices(response.devices);
    } catch (error) {
      if (generation === lifetime.current)
        setNotice(error instanceof Error ? error.message : 'Device list unavailable.');
    } finally {
      if (generation === lifetime.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const remove = async (device: RelayDevice) => {
    const self = device.fingerprint === ownFingerprint;
    if (
      !window.confirm(
        self
          ? 'Revoke this device? It will disconnect from this machine.'
          : `Revoke ${device.label || device.fingerprint}?`,
      )
    )
      return;
    const generation = lifetime.current;
    setBusy(true);
    setNotice('');
    try {
      const result = await revoke(device.fingerprint);
      if (generation !== lifetime.current) return;
      if (!result.success) setNotice(`Revocation refused: ${result.error ?? 'unverified'}.`);
      else {
        setDevices((previous) =>
          previous.filter((item) => item.fingerprint !== result.fingerprint),
        );
        setNotice(
          result.edgeAcknowledged
            ? 'Device revoked. Relay edge acknowledgment confirmed.'
            : 'Device revoked locally on the daemon. Relay edge outcome unverified.',
        );
      }
    } catch (error) {
      if (generation !== lifetime.current) return;
      if (self) {
        setNotice(
          'This device disconnected. Daemon revocation and relay edge acknowledgment are unverified. You can forget the machine locally.',
        );
      } else setNotice(error instanceof Error ? error.message : 'Revocation outcome unverified.');
    } finally {
      if (generation === lifetime.current) setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60">
      <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-[var(--color-surface)] p-5 pb-[max(env(safe-area-inset-bottom),20px)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Machine devices</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="mb-3 text-sm">
          Only an enrolled identity can list or revoke devices. Pairing approval stays on the daemon
          machine.
        </p>
        {devices.map((device) => (
          <div
            key={device.fingerprint}
            className="mb-3 rounded-lg border border-[var(--color-border)] p-3"
          >
            <p>
              {device.label || 'Device'}
              {device.fingerprint === ownFingerprint ? ' (this device)' : ''}
            </p>
            <p className="break-all font-mono text-xs">{device.fingerprint}</p>
            <button
              type="button"
              disabled={busy || connection.status !== 'connected'}
              onClick={() => void remove(device)}
              className="mt-2 text-sm text-[var(--color-error)]"
            >
              Revoke device {device.fingerprint}
            </button>
          </div>
        ))}
        {notice && <output className="mb-3 text-sm">{notice}</output>}
        <div className="flex gap-3">
          <button
            type="button"
            disabled={busy || connection.status !== 'connected'}
            onClick={() => void refresh()}
          >
            Refresh devices
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  'Forget this machine on this client? This does not revoke authorization on the daemon.',
                )
              ) {
                forget();
                onClose();
              }
            }}
          >
            Forget machine locally
          </button>
        </div>
      </div>
    </div>
  );
}
