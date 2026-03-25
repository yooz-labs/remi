/**
 * React hook for platform detection.
 *
 * Returns platform info that can be used to conditionally
 * render iOS-specific or web-specific UI.
 */

import { useMemo } from 'react';
import { type Platform, getPlatform, isAndroid, isIOS, isNative, isWeb } from '@/lib/platform';

interface PlatformInfo {
  readonly platform: Platform;
  readonly isIOS: boolean;
  readonly isAndroid: boolean;
  readonly isNative: boolean;
  readonly isWeb: boolean;
}

/** Hook returning current platform info. Values are stable across renders. */
export function usePlatform(): PlatformInfo {
  return useMemo<PlatformInfo>(
    () => ({
      platform: getPlatform(),
      isIOS: isIOS(),
      isAndroid: isAndroid(),
      isNative: isNative(),
      isWeb: isWeb(),
    }),
    [],
  );
}
