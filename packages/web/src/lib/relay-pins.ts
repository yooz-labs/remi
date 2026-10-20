import { relayV2 } from '@remi/shared';
import type { RelayMachinePin } from './relay-machine-channel';

const STORAGE_KEY = 'remi-relay-machines-v2';
/** Only verified public machine pins persist. Pairing tokens and secrets never enter this store. */
export function loadRelayPins(storage: Storage = localStorage): readonly RelayMachinePin[] {
  try {
    const values: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(values) || values.length > 64) return [];
    return values.filter((value): value is RelayMachinePin => {
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).some(
          (k) => !['relayUrl', 'machinePublicKey', 'sealPublicKey'].includes(k),
        )
      )
        return false;
      if (typeof value.relayUrl !== 'string' || typeof value.machinePublicKey !== 'string')
        return false;
      const key = relayV2.fromB64u(value.machinePublicKey);
      return (
        key.length === 32 &&
        !relayV2.isSmallOrderPublicKey(key) &&
        (value.sealPublicKey === undefined ||
          (typeof value.sealPublicKey === 'string' &&
            relayV2.fromB64u(value.sealPublicKey).length === 65))
      );
    });
  } catch {
    return [];
  }
}
export function rememberRelayPin(pin: RelayMachinePin, storage: Storage = localStorage): void {
  const previous = loadRelayPins(storage);
  if (
    previous.length >= 64 &&
    !previous.some((item) => item.machinePublicKey === pin.machinePublicKey)
  ) {
    throw new Error(
      'Saved machine limit reached. Forget a machine locally before pairing another.',
    );
  }
  const publicPin: RelayMachinePin = {
    relayUrl: pin.relayUrl,
    machinePublicKey: pin.machinePublicKey,
    ...(pin.sealPublicKey ? { sealPublicKey: pin.sealPublicKey } : {}),
  };
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      ...previous.filter((p) => p.machinePublicKey !== pin.machinePublicKey),
      publicPin,
    ]),
  );
}
export function forgetRelayPin(machinePublicKey: string, storage: Storage = localStorage): void {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify(loadRelayPins(storage).filter((p) => p.machinePublicKey !== machinePublicKey)),
  );
}
