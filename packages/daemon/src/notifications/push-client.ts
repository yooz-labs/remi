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

/** The fixed codes `sendPushTrigger` throws; a message is never anything else (#1200). */
export type LegacyPushCode =
  | 'LEGACY_PUSH_INVALID_CONTENT'
  | 'LEGACY_PUSH_DISABLED'
  | 'LEGACY_PUSH_SECRET_REQUIRED'
  | 'LEGACY_PUSH_INVALID_URL'
  | 'LEGACY_PUSH_NOT_ELIGIBLE'
  | 'LEGACY_PUSH_REJECTED'
  | 'LEGACY_PUSH_UNCERTAIN';

/**
 * What `sendPushTrigger` throws. `message` is one fixed code, so a log line or a child's output
 * never carries a token, content or a receiver's text. What a caller must decide on rides in
 * fields instead: the HTTP `status` of a `LEGACY_PUSH_REJECTED` and the Worker's structured
 * `tokenInvalid` flag (a permanent APNS token rejection), the only two facts read from the
 * receiver's response (#1200, B6).
 */
export class LegacyPushError extends Error {
  constructor(
    readonly code: LegacyPushCode,
    readonly status?: number,
    readonly tokenInvalid = false,
  ) {
    super(code);
    this.name = 'LegacyPushError';
  }
}

/**
 * The secure activation latch refused the plaintext sender: the expected state of a relay-paired
 * machine, never a push failure to report (#1200). Every legacy sender checks this before it
 * reports an error.
 */
export function isLegacyPushRetired(error: unknown): boolean {
  return error instanceof LegacyPushError && error.code === 'LEGACY_PUSH_NOT_ELIGIBLE';
}

/** The Worker's error body is a few dozen bytes; anything past this is not read. */
const MAX_ERROR_BODY_BYTES = 4096;

/** Only the Worker's `tokenInvalid: true` is taken from a refusal; the text is discarded. */
async function readTokenInvalid(response: Response): Promise<boolean> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    void reader.cancel().catch(() => {});
    if (size > MAX_ERROR_BODY_BYTES) return false;
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { tokenInvalid?: unknown }).tokenInvalid === true
    );
  } catch {
    return false;
  }
}

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
    throw new LegacyPushError('LEGACY_PUSH_INVALID_CONTENT');
  }
  if (opts.legacyEnabled !== true) throw new LegacyPushError('LEGACY_PUSH_DISABLED');
  if (typeof opts.pushSecret !== 'string' || opts.pushSecret.trim().length === 0)
    throw new LegacyPushError('LEGACY_PUSH_SECRET_REQUIRED');
  let url: string;
  try {
    const base = (signalingUrl || DEFAULT_SIGNALING_URL)
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://');
    url = `${new URL(base).origin}/push`;
  } catch {
    throw new LegacyPushError('LEGACY_PUSH_INVALID_URL');
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
    if (!invoked.allowed) throw new LegacyPushError('LEGACY_PUSH_NOT_ELIGIBLE');
    let response: Response;
    try {
      response = await invoked.result;
    } catch {
      throw new LegacyPushError('LEGACY_PUSH_UNCERTAIN');
    }
    // Arbitrary response bodies and tokens never enter diagnostics: a refusal keeps its status
    // and the Worker's structured token verdict, and nothing else.
    if (!response.ok)
      throw new LegacyPushError(
        'LEGACY_PUSH_REJECTED',
        response.status,
        await readTokenInvalid(response),
      );
    void response.body?.cancel().catch(() => {});
  } catch (error) {
    if (
      error instanceof LegacyPushError &&
      ['LEGACY_PUSH_NOT_ELIGIBLE', 'LEGACY_PUSH_REJECTED', 'LEGACY_PUSH_UNCERTAIN'].includes(
        error.code,
      )
    )
      throw error;
    throw new LegacyPushError('LEGACY_PUSH_UNCERTAIN');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
