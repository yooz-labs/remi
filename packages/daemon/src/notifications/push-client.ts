/**
 * Plaintext legacy sender (#1200). It refuses unless the caller passes
 * `legacyEnabled: true`; the daemon passes `notifications.legacy_push_enabled`,
 * which is ON by default until secure push ships end to end (the default flips
 * at the R7 gate). An enabled caller needs a secret and an untouched
 * secure-authority directory: once any device enrolls over the relay the
 * activation latch refuses this sender for good.
 * Signed sealed delivery uses SecurePushTransport; this sender never falls back.
 */

import { remiHome } from '../config/remi-home.ts';
import { withLegacyPushEligibility } from '../storage/secure-push-activation.ts';

const DEFAULT_SIGNALING_URL = 'https://remi-signaling.yooz.workers.dev';

/**
 * What class of push this is (#968).
 *
 * Before this existed, the classes were told apart only by a NEGATIVE test —
 * "no questionId, no category" — which could not distinguish a turn-complete
 * push from a subagent alert at all: on the wire they were byte-identical
 * `{token, title, body}`. The `": turn complete"` title suffix is display text,
 * not a discriminator. Naming the class explicitly is what lets both the daemon
 * (per-device filtering, `push-preferences.ts`) and the client (labelling,
 * routing) act on it.
 */
export type PushKind =
  | 'question'
  | 'turn_complete'
  | 'subagent_alert'
  /** Claude Code's auto-mode classifier blocked a tool call (#1126), never a
   *  card: nothing waits for an answer. */
  | 'harness_denied'
  /** A turn ended on an API error (usage or rate limit, authentication, and
   *  similar; Claude Code's `StopFailure`, #1153), never a card: nothing
   *  waits for an answer. */
  | 'turn_failed'
  | 'dismiss';

/** Options for sendPushTrigger */
export interface PushTriggerOptions {
  /** Must be true or the sender throws `LEGACY_PUSH_DISABLED` before any I/O (#1200). */
  legacyEnabled?: boolean;
  /** Authority state directory; tests must supply their owned disposable directory. */
  authorityDirectory?: string;
  /**
   * Which class of push this is. Forwarded to the Worker, which passes it
   * through into the APNS payload's custom data as `kind`.
   *
   * Purely additive: every field that previously distinguished these classes
   * (`category`, `questionId`, `dismiss`) is still sent exactly as before, so an
   * older Worker or client that ignores `kind` behaves identically.
   */
  kind?: PushKind;
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
   * Hint for the iOS Notification Service Extension (#719): when true (and
   * `options` carries 2-4 real labels), the signaling worker sets
   * `mutable-content: 1` so the NSE runs and can register a per-notification
   * dynamic category showing the real labels as action titles. Purely
   * additive — `category` above is still sent unconditionally as the static
   * fallback for a missing/failed/racing NSE.
   */
  dynOptions?: boolean;
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
  if (opts.dynOptions) {
    payload['dynOptions'] = true;
  }
  if (opts.dismiss) {
    payload['dismiss'] = true;
  }
  if (opts.kind) {
    payload['kind'] = opts.kind;
  }
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    throw new Error('LEGACY_PUSH_INVALID_CONTENT');
  }
  if (opts.legacyEnabled !== true) throw new Error('LEGACY_PUSH_DISABLED');
  if (typeof opts.pushSecret !== 'string' || opts.pushSecret.trim().length === 0)
    throw new Error('LEGACY_PUSH_SECRET_REQUIRED');
  let url: string;
  try {
    const base = (signalingUrl || DEFAULT_SIGNALING_URL)
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://');
    url = `${new URL(base).origin}/push`;
  } catch {
    throw new Error('LEGACY_PUSH_INVALID_URL');
  }
  const directory = opts.authorityDirectory ?? remiHome();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const invoked = withLegacyPushEligibility(directory, () => {
      // Fetch is invoked under the authorization lock; await only after releasing it.
      timer = setTimeout(() => controller.abort(), 12000);
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.pushSecret}` },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
    });
    if (!invoked.allowed) throw new Error('LEGACY_PUSH_NOT_ELIGIBLE');
    let response: Response;
    try {
      response = await invoked.result;
    } catch {
      throw new Error('LEGACY_PUSH_UNCERTAIN');
    }
    // Arbitrary response bodies and tokens never enter diagnostics.
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error('LEGACY_PUSH_REJECTED');
  } catch (error) {
    if (
      error instanceof Error &&
      ['LEGACY_PUSH_NOT_ELIGIBLE', 'LEGACY_PUSH_REJECTED', 'LEGACY_PUSH_UNCERTAIN'].includes(
        error.message,
      )
    )
      throw error;
    throw new Error('LEGACY_PUSH_UNCERTAIN');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
