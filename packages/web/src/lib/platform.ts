/**
 * Platform detection utilities.
 *
 * Wraps Capacitor's platform API with convenient helpers.
 * All functions are safe to call on web (non-native).
 */

import { Capacitor } from '@capacitor/core';

export type Platform = 'ios' | 'android' | 'web';

/** Get the current platform */
export function getPlatform(): Platform {
  return Capacitor.getPlatform() as Platform;
}

/** Check if running on a specific platform */
export function isPlatform(platform: Platform): boolean {
  return getPlatform() === platform;
}

/** Check if running on iOS (native app) */
export function isIOS(): boolean {
  return isPlatform('ios');
}

/** Check if running on Android (native app) */
export function isAndroid(): boolean {
  return isPlatform('android');
}

/** Check if running as a native app (iOS or Android) */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Check if running in a web browser */
export function isWeb(): boolean {
  return !isNative();
}
