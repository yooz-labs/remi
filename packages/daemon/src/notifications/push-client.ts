/**
 * Push notification trigger client.
 * Sends a lightweight HTTP POST to the signaling server,
 * which forwards it to Apple's APNS.
 */

const DEFAULT_SIGNALING_URL = 'https://remi-signaling.yooz.workers.dev';

/** Options for sendPushTrigger */
export interface PushTriggerOptions {
  /** Title shown in the notification banner */
  title: string;
  /** Body text shown in the notification banner */
  body: string;
  /** Bearer token for signaling server auth (REMI_PUSH_SECRET) */
  pushSecret?: string;
  /** Remi session UUID included in APNS custom data for tap-to-navigate */
  sessionId?: string;
}

/**
 * Send a push notification trigger to the signaling server.
 *
 * @param signalingUrl - Base URL of the signaling server (defaults to remi-signaling.yooz.workers.dev)
 * @param deviceToken  - APNS device token registered by the iOS client
 * @param opts         - Notification content and optional auth/routing metadata
 */
export async function sendPushTrigger(
  signalingUrl: string | undefined,
  deviceToken: string,
  opts: PushTriggerOptions,
): Promise<void> {
  const baseUrl = signalingUrl || DEFAULT_SIGNALING_URL;
  // Strip any path (e.g. /connect) from the signaling URL since we need the root
  const url = `${new URL(baseUrl).origin}/push`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.pushSecret) {
    headers['Authorization'] = `Bearer ${opts.pushSecret}`;
  }
  const payload: Record<string, string> = {
    token: deviceToken,
    title: opts.title,
    body: opts.body,
  };
  if (opts.sessionId) {
    payload['sessionId'] = opts.sessionId;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    throw new Error(`Push trigger failed: ${response.status} ${text}`);
  }

  // Read response body for diagnostics; body not consumed earlier on the success path
  try {
    const resultText = await response.text();
    console.log(`[Push] Sent for token ${deviceToken.slice(0, 20)}...: ${resultText}`);
  } catch (err) {
    console.log(
      `[Push] Sent for token ${deviceToken.slice(0, 20)}... (could not read response: ${err})`,
    );
  }
}
