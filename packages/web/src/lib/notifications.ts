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

    // Handle incoming push notifications (when app is in foreground)
    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      // Show as local notification since the app is in foreground
      if (localPermissionGranted) {
        LocalNotifications.schedule({
          notifications: [{
            title: notification.title ?? 'Remi',
            body: notification.body ?? 'Your agent needs attention',
            id: nextNotificationId(),
            schedule: { at: new Date() },
            sound: 'default',
          }],
        }).catch((err) => console.warn('[Notifications] Failed to show push as local:', err));
      }
    });
  } catch (err) {
    console.warn('[Notifications] Push registration setup failed:', err);
  }

  return localPermissionGranted;
}

/** Get the current device token (null if not yet registered) */
export function getDeviceToken(): string | null {
  return deviceToken;
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
          sound: 'default',
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
          sound: 'default',
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
          sound: 'default',
        },
      ],
    });
  } catch (err) {
    console.warn('[Notifications] Failed to schedule error notification:', err);
  }
}
