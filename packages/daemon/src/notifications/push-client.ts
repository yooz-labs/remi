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
  pushSecret?: string,
  sessionId?: string,
): Promise<void> {
  const baseUrl = signalingUrl || DEFAULT_SIGNALING_URL;
  // Strip any path (e.g. /connect) from the signaling URL since we need the root
  const url = `${new URL(baseUrl).origin}/push`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (pushSecret) {
    headers['Authorization'] = `Bearer ${pushSecret}`;
  }
  const payload: Record<string, string> = { token: deviceToken, title, body };
  if (sessionId) {
    payload['sessionId'] = sessionId;
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
