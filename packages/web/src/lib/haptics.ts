/**
 * Haptic feedback utilities.
 *
 * Wraps @capacitor/haptics with safe no-ops on web.
 * Import and call directly; no need to check platform first.
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
  await Haptics.impact({ style: IMPACT_MAP[style] });
}

/** Trigger notification haptic feedback (success, warning, error events) */
export async function hapticNotification(type: NotificationFeedback = 'success'): Promise<void> {
  if (!isNative()) return;
  await Haptics.notification({ type: NOTIFICATION_MAP[type] });
}

/** Trigger selection haptic feedback (picker changes, selections) */
export async function hapticSelection(): Promise<void> {
  if (!isNative()) return;
  await Haptics.selectionStart();
  await Haptics.selectionChanged();
  await Haptics.selectionEnd();
}
