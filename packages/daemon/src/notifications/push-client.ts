/**
 * Push notification trigger client.
 * Sends a lightweight HTTP POST to the signaling server,
 * which forwards it to Apple's APNS.
 */

const DEFAULT_SIGNALING_URL = 'https://remi-signaling.yooz.workers.dev';

export async function sendPushTrigger(
  signalingUrl: string | undefined,
  deviceToken: string,
  title: string,
  body: string,
): Promise<void> {
  const baseUrl = signalingUrl || DEFAULT_SIGNALING_URL;
  // Strip any path (e.g. /connect) from the signaling URL since we need the root
  const url = `${new URL(baseUrl).origin}/push`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: deviceToken,
      title,
      body,
      platform: 'ios',
      bundleId: 'live.yooz.remi',
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    throw new Error(`Push trigger failed: ${response.status} ${text}`);
  }
}
