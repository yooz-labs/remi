/**
 * Notification utilities for Remi.
 *
 * Two notification paths:
 * 1. Local notifications (@capacitor/local-notifications) - when app is in
 *    foreground/briefly backgrounded and a question arrives for another session
 * 2. APNS push notifications (@capacitor/push-notifications) - registers the
 *    device token with the daemon so it can send push notifications via the
 *    signaling server when the app is fully suspended
 *
 * The daemon stores the device token and triggers a push through the signaling
 * server when a question arrives with no client connected.
 */

import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { isNative } from './platform';

let localPermissionGranted = false;
let soundEnabled = true;
/** When true, foreground push notifications are suppressed (the question is
 *  already visible in the chat UI via the WebSocket connection). */
let suppressForegroundPush = false;
/** Use timestamp-based IDs to avoid collisions across app restarts */
function nextNotificationId(): number {
  return (Date.now() % 2_000_000_000) + Math.floor(Math.random() * 1000);
}
let deviceToken: string | null = null;

/** Callback for when device token is received */
type TokenCallback = (token: string) => void;
let onTokenReceived: TokenCallback | null = null;

/**
 * Request notification permissions and register for push notifications.
 * Call once on app startup. The onToken callback fires when the APNS
 * device token is available (may be immediate or after user grants permission).
 */
export async function initNotifications(onToken?: TokenCallback): Promise<boolean> {
  if (!isNative()) return false;
  onTokenReceived = onToken ?? null;

  // Request local notification permission
  try {
    const result = await LocalNotifications.requestPermissions();
    localPermissionGranted = result.display === 'granted';
  } catch (err) {
    console.warn('[Notifications] Local permission request failed:', err);
  }

  // Register local notification action types. These mirror the UNNotificationCategory
  // objects in AppDelegate.swift so that local notifications (including foreground
  // re-creations of push notifications) show the same action buttons.
  try {
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: 'REMI_YN',
          actions: [
            { id: 'OPT_0', title: 'Yes' },
            { id: 'OPT_1', title: 'No', destructive: true },
          ],
        },
        {
          id: 'REMI_YNA',
          actions: [
            { id: 'OPT_0', title: 'Yes' },
            { id: 'OPT_1', title: 'Yes, always' },
            { id: 'OPT_2', title: 'No', destructive: true },
          ],
        },
        {
          id: 'REMI_MULTI',
          actions: [
            { id: 'OPT_0', title: 'Option 1' },
            { id: 'OPT_1', title: 'Option 2' },
            { id: 'OPT_2', title: 'Option 3' },
            { id: 'OPT_3', title: 'Option 4' },
          ],
        },
        {
          id: 'QUESTION',
          actions: [
            { id: 'OPT_0', title: 'Yes' },
            { id: 'OPT_1', title: 'No', destructive: true },
          ],
        },
      ],
    });
  } catch (err) {
    console.warn('[Notifications] Failed to register action types:', err);
  }

  // Register for push notifications (APNS token)
  try {
    const pushResult = await PushNotifications.requestPermissions();
    if (pushResult.receive === 'granted') {
      await PushNotifications.register();
    }

    // Listen for token registration
    await PushNotifications.addListener('registration', (token) => {
      deviceToken = token.value;
      console.debug('[Notifications] Device token registered:', token.value.slice(0, 20) + '...');
      onTokenReceived?.(token.value);
    });

    await PushNotifications.addListener('registrationError', (err) => {
      console.warn('[Notifications] Push registration failed:', err.error);
    });

    // Handle incoming push notifications (when app is in foreground).
    // Re-create as a local notification, forwarding the APNS category and
    // custom data so that action buttons appear and work correctly.
    // When the app is connected via WebSocket, the question already appears
    // in the chat UI, so skip the duplicate banner.
    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      if (!localPermissionGranted || suppressForegroundPush) return;
      const data = (notification.data ?? {}) as Record<string, string>;

      // Determine actionTypeId: prefer the explicit category field mirrored
      // into custom data by the signaling server; fall back to counting opt_N keys.
      let actionTypeId: string | undefined = data['category'];
      if (!actionTypeId) {
        const optCount = Object.keys(data).filter((k) => k.startsWith('opt_')).length;
        if (optCount === 2) actionTypeId = 'REMI_YN';
        else if (optCount === 3) actionTypeId = 'REMI_YNA';
        else if (optCount === 4) actionTypeId = 'REMI_MULTI';
      }

      LocalNotifications.schedule({
        notifications: [
          {
            title: notification.title ?? 'Remi',
            body: notification.body ?? 'Your agent needs attention',
            id: nextNotificationId(),
            schedule: { at: new Date() },
            ...(soundEnabled ? { sound: 'default' } : {}),
            ...(actionTypeId ? { actionTypeId } : {}),
            extra: data,
          },
        ],
      }).catch((err) => console.warn('[Notifications] Failed to show push as local:', err));
    });

    // Handle notification action tap (action buttons or plain tap)
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification.data as Record<string, string>;
      const actionId: string = action.actionId ?? '';
      console.debug('[Notifications] Push notification action:', actionId, data);

      if (actionId.startsWith('OPT_')) {
        // Lock-screen / Apple Watch action button tapped
        const optKey = actionId.toLowerCase(); // 'opt_0', 'opt_1', etc.
        const answerValue = data[optKey];
        if (answerValue !== undefined && data['sessionId'] && data['questionId']) {
          document.dispatchEvent(
            new CustomEvent('push-notification-answer', {
              detail: {
                sessionId: data['sessionId'],
                questionId: data['questionId'],
                answer: answerValue,
              },
            }),
          );
        } else {
          console.warn('[Notifications] Action tap missing data:', { optKey, data });
        }
      } else {
        // Default tap (notification body) — navigate to session
        document.dispatchEvent(new CustomEvent('push-notification-tap', { detail: data }));
      }
    });
  } catch (err) {
    console.warn('[Notifications] Push registration setup failed:', err);
  }

  // Handle action button taps on local notifications (including foreground
  // re-creations of push notifications). Mirrors the push action handler above.
  try {
    await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const data = (action.notification.extra ?? {}) as Record<string, string>;
      const actionId: string = action.actionId ?? '';
      console.debug('[Notifications] Local notification action:', actionId, data);

      if (actionId.startsWith('OPT_')) {
        const optKey = actionId.toLowerCase();
        const answerValue = data[optKey];
        if (answerValue !== undefined && data['sessionId'] && data['questionId']) {
          document.dispatchEvent(
            new CustomEvent('push-notification-answer', {
              detail: {
                sessionId: data['sessionId'],
                questionId: data['questionId'],
                answer: answerValue,
              },
            }),
          );
        } else {
          console.warn('[Notifications] Local action tap missing data:', { optKey, data });
        }
      } else {
        // Default tap (notification body)
        document.dispatchEvent(new CustomEvent('push-notification-tap', { detail: data }));
      }
    });
  } catch (err) {
    console.warn('[Notifications] Local action listener setup failed:', err);
  }

  return localPermissionGranted;
}

/** Get the current device token (null if not yet registered) */
export function getDeviceToken(): string | null {
  return deviceToken;
}

/** Set whether notification sounds are enabled (controls local notification sound field) */
export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
}

/** Suppress foreground push-to-local re-creation when the app is actively
 *  connected via WebSocket (the question already shows in the chat UI). */
export function setSuppressForegroundPush(suppress: boolean): void {
  suppressForegroundPush = suppress;
}

/**
 * Check the current OS-level notification permission state.
 * Returns 'granted', 'denied', or 'prompt' (not yet requested).
 */
export async function checkNotificationPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  if (!isNative()) return 'granted';
  try {
    const result = await PushNotifications.checkPermissions();
    // 'prompt-with-rationale' is an Android state; treat it as 'prompt'
    return result.receive === 'granted'
      ? 'granted'
      : result.receive === 'denied'
        ? 'denied'
        : 'prompt';
  } catch {
    return 'prompt';
  }
}

/** Open the app's iOS Settings page so the user can manage notification permissions */
export function openNotificationSettings(): void {
  window.open('app-settings:', '_system');
}

/** Send a local notification for a question/permission prompt. */
export async function notifyQuestion(sessionName: string, prompt: string): Promise<void> {
  if (!localPermissionGranted) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: `${sessionName} needs input`,
          body: prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt,
          id: nextNotificationId(),
          schedule: { at: new Date() },
          ...(soundEnabled ? { sound: 'default' } : {}),
          actionTypeId: 'QUESTION',
        },
      ],
    });
  } catch (err) {
    console.warn('[Notifications] Failed to schedule question notification:', err);
  }
}

/** Send a local notification for session completion. */
export async function notifySessionComplete(sessionName: string): Promise<void> {
  if (!localPermissionGranted) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: `${sessionName} finished`,
          body: 'The agent has completed its work.',
          id: nextNotificationId(),
          schedule: { at: new Date() },
          ...(soundEnabled ? { sound: 'default' } : {}),
        },
      ],
    });
  } catch (err) {
    console.warn('[Notifications] Failed to schedule completion notification:', err);
  }
}

/** Send a local notification for a session error. */
export async function notifySessionError(sessionName: string, error: string): Promise<void> {
  if (!localPermissionGranted) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: `${sessionName} error`,
          body: error.length > 100 ? `${error.slice(0, 97)}...` : error,
          id: nextNotificationId(),
          schedule: { at: new Date() },
          ...(soundEnabled ? { sound: 'default' } : {}),
        },
      ],
    });
  } catch (err) {
    console.warn('[Notifications] Failed to schedule error notification:', err);
  }
}
