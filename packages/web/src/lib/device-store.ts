/**
 * Device store for paired device persistence.
 *
 * Stores paired device credentials in localStorage so the user
 * can reconnect without entering a code.
 */

const STORAGE_KEY = 'remi-paired-devices';

export interface PairedDevice {
  deviceId: string;
  clientId: string;
  pairingToken: string;
  signalingUrl: string;
  pairedAt: string;
  lastConnectedAt: string;
}

export function getPairedDevices(): PairedDevice[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function savePairedDevice(device: PairedDevice): void {
  const devices = getPairedDevices();
  const idx = devices.findIndex((d) => d.deviceId === device.deviceId);
  if (idx >= 0) {
    devices[idx] = device;
  } else {
    devices.push(device);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
}

export function updateLastConnected(deviceId: string): void {
  const devices = getPairedDevices();
  const device = devices.find((d) => d.deviceId === deviceId);
  if (device) {
    device.lastConnectedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
  }
}

export function removePairedDevice(deviceId: string): void {
  const devices = getPairedDevices().filter((d) => d.deviceId !== deviceId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
}
