/**
 * Local notification utilities for Remi.
 *
 * Wraps @capacitor/local-notifications to send notifications when:
 * - A question/permission prompt arrives from the agent
 * - A session completes or errors
 *
 * Notifications are only sent when the app is in the background
 * or the user is viewing a different session.
 */

import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from './platform';

let permissionGranted = false;
let notificationIdCounter = 1;

/** Request notification permission. Call once on app startup. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const result = await LocalNotifications.requestPermissions();
    permissionGranted = result.display === 'granted';
    return permissionGranted;
  } catch (err) {
    console.warn('[Notifications] Permission request failed:', err);
    return false;
  }
}

/** Check if notifications are enabled (permission granted + user setting). */
export function canNotify(): boolean {
  return permissionGranted;
}

/** Send a notification for a question/permission prompt. */
export async function notifyQuestion(sessionName: string, prompt: string): Promise<void> {
  if (!permissionGranted) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: `${sessionName} needs input`,
          body: prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt,
          id: notificationIdCounter++,
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

/** Send a notification for session completion. */
export async function notifySessionComplete(sessionName: string): Promise<void> {
  if (!permissionGranted) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: `${sessionName} finished`,
          body: 'The agent has completed its work.',
          id: notificationIdCounter++,
          schedule: { at: new Date() },
          sound: 'default',
        },
      ],
    });
  } catch (err) {
    console.warn('[Notifications] Failed to schedule completion notification:', err);
  }
}

/** Send a notification for a session error. */
export async function notifySessionError(sessionName: string, error: string): Promise<void> {
  if (!permissionGranted) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: `${sessionName} error`,
          body: error.length > 100 ? `${error.slice(0, 97)}...` : error,
          id: notificationIdCounter++,
          schedule: { at: new Date() },
          sound: 'default',
        },
      ],
    });
  } catch (err) {
    console.warn('[Notifications] Failed to schedule error notification:', err);
  }
}
