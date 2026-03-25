/**
 * Haptic feedback utilities.
 *
 * Wraps @capacitor/haptics with safe no-ops on web.
 * Import and call directly; no need to check platform first.
 * All errors are caught and logged since haptics are non-critical.
 */

import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { isNative } from './platform';

export type ImpactWeight = 'light' | 'medium' | 'heavy';
export type NotificationFeedback = 'success' | 'warning' | 'error';

const IMPACT_MAP: Record<ImpactWeight, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
};

const NOTIFICATION_MAP: Record<NotificationFeedback, NotificationType> = {
  success: NotificationType.Success,
  warning: NotificationType.Warning,
  error: NotificationType.Error,
};

/** Trigger impact haptic feedback (button taps, interactions) */
export async function hapticImpact(style: ImpactWeight = 'medium'): Promise<void> {
  if (!isNative()) return;
  try {
    await Haptics.impact({ style: IMPACT_MAP[style] });
  } catch (err) {
    console.warn('[Haptics] impact failed:', err);
  }
}

/** Trigger notification haptic feedback (success, warning, error events) */
export async function hapticNotification(type: NotificationFeedback = 'success'): Promise<void> {
  if (!isNative()) return;
  try {
    await Haptics.notification({ type: NOTIFICATION_MAP[type] });
  } catch (err) {
    console.warn('[Haptics] notification failed:', err);
  }
}

/** Trigger selection haptic feedback (picker changes, selections) */
export async function hapticSelection(): Promise<void> {
  if (!isNative()) return;
  try {
    await Haptics.selectionStart();
    await Haptics.selectionChanged();
    await Haptics.selectionEnd();
  } catch (err) {
    console.warn('[Haptics] selection failed:', err);
  }
}
