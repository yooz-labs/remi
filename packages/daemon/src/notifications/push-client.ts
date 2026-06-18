/**
 * Push notification trigger client.
 * Sends a lightweight HTTP POST to the signaling server,
 * which forwards it to Apple's APNS.
 */

const DEFAULT_SIGNALING_URL = 'https://remi-signaling.yooz.workers.dev';

/** Options for sendPushTrigger */
export interface PushTriggerOptions {
  /** Title shown in the notification banner. Optional only for a `dismiss`
   *  push (#585, P7), which is silent (content-available) and has no text. */
  title?: string;
  /** Body text shown in the notification banner. Optional only for a `dismiss`
   *  push (#585, P7). */
  body?: string;
  /** Bearer token for signaling server auth (REMI_PUSH_SECRET) */
  pushSecret?: string;
  /** Remi session UUID included in APNS custom data for tap-to-navigate */
  sessionId?: string;
  /** Question UUID so the client can send the right answer back */
  questionId?: string;
  /** APNS notification category ('REMI_YN' | 'REMI_YNA' | 'REMI_MULTI') for action buttons */
  category?: string;
  /** Answer values for action buttons: opt_0, opt_1, ... */
  options?: string[];
  /**
   * Dismissal trigger (#585, P7). When true the signaling server sends a QUIET
   * `content-available` push (no alert) carrying the same `apns-collapse-id` =
   * questionId, so the device replaces/clears the lock-screen card for an
   * already-resolved question instead of buzzing again. The relay skips the
   * title/body requirement for a dismiss, so the dispatcher omits them entirely.
   */
  dismiss?: boolean;
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
  // Normalize wss:// → https:// and ws:// → http:// so fetch works
  const rawUrl = signalingUrl || DEFAULT_SIGNALING_URL;
  const baseUrl = rawUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  // Strip any path (e.g. /connect) from the signaling URL since we need the root
  const url = `${new URL(baseUrl).origin}/push`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.pushSecret) {
    headers['Authorization'] = `Bearer ${opts.pushSecret}`;
  }
  const payload: Record<string, unknown> = {
    token: deviceToken,
    // Omitted for a dismiss push (#585, P7): silent, no user-visible text.
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  };
  if (opts.sessionId) {
    payload['sessionId'] = opts.sessionId;
  }
  if (opts.questionId) {
    payload['questionId'] = opts.questionId;
  }
  if (opts.category) {
    payload['category'] = opts.category;
  }
  if (opts.options && opts.options.length > 0) {
    payload['options'] = opts.options;
  }
  if (opts.dismiss) {
    payload['dismiss'] = true;
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
