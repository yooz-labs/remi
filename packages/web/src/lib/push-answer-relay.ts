/**
 * Connection-independent answer relay (#575, P4a).
 *
 * On a cold-start push tap the WebSocket is not warm and the reconnect +
 * Ed25519 handshake can take longer than the answer deadline (or never
 * complete when the identity needs a passphrase). This module delivers the
 * answer over a plain HTTPS POST to the daemon's `/answer` endpoint — the
 * fast path — bypassing the WebSocket entirely.
 *
 * The daemon authenticates the POST with the SAME trust model as the
 * WebSocket: loopback peers are exempt; networked peers must sign the
 * canonical request string with a key already in the daemon's
 * authorized-keys store. The signature is produced here from the locally
 * stored identity. If the identity is encrypted (passphrase) the relay
 * cannot sign without a prompt, so the caller falls back to the WebSocket
 * path (which has the same limitation) or surfaces an "open the app" failure.
 */

import { sign } from '@remi/shared';
import { hasIdentity, isIdentityEncrypted, unlockStoredIdentity } from './identity-client';

/** Outcome of a direct-relay attempt. */
export type RelayResult =
  | { kind: 'delivered' }
  /**
   * The daemon refused the answer as stale (409) or unknown (404). The
   * WebSocket would refuse identically, so the caller should NOT fall back —
   * surface an "open the app" failure instead.
   */
  | { kind: 'rejected'; result: string }
  /**
   * The relay could not be attempted or did not reach the daemon — network
   * error, timeout, or WebRTC-relay-only daemon. The caller MAY fall back to
   * the WebSocket reconnect path.
   */
  | { kind: 'unreachable'; reason: string }
  /**
   * The daemon returned HTTP 401 (the detached signature was missing/invalid,
   * e.g. the /auth-info probe timed out so no signature was sent). This does
   * NOT mean the WebSocket would fail — the WS uses an interactive
   * challenge-response handshake — so the caller should fall back to WS, same
   * as `unreachable`.
   */
  | { kind: 'auth-failed'; result: string }
  /**
   * Auth is required but no usable local identity can sign without a prompt
   * (the identity is passphrase-encrypted, or there is no stored identity at
   * all). The WebSocket path is equally blocked, so the caller should fail fast
   * and tell the user to open the app.
   */
  | { kind: 'needs-passphrase' };

/**
 * Convert a `ws(s)://host:port/path` daemon URL to its `http(s)://host:port/answer`
 * form. Throws if the input cannot be parsed. (Mirrors `authInfoUrl` in
 * auth-probe.ts, kept separate so the two endpoints can diverge.)
 */
export function answerUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  let scheme: string;
  if (u.protocol === 'wss:') scheme = 'https:';
  else if (u.protocol === 'ws:') scheme = 'http:';
  else throw new Error(`Unsupported scheme: ${u.protocol}`);
  return `${scheme}//${u.host}/answer`;
}

/** Default timeout for the direct relay; keep it well under the WS deadline. */
const DEFAULT_TIMEOUT_MS = 6000;

interface RelayInput {
  readonly wsUrl: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly answer: string;
  readonly claudeSessionId?: string | undefined;
  /** When true the daemon will require a signed request (networked, auth on). */
  readonly authRequired: boolean;
  readonly timeoutMs?: number;
}

/**
 * Build the signed auth block for a `/answer` POST when the daemon requires it.
 * Returns null when we cannot sign without a passphrase prompt — either because
 * there is NO stored identity, or the stored identity is encrypted.
 */
async function buildAuth(
  message: string,
): Promise<{ signature: string; clientPublicKey: string; clientFingerprint: string } | null> {
  // No identity at all (isIdentityEncrypted() returns false in this case, so it
  // must be checked separately) OR an encrypted identity: cannot sign here.
  if (!hasIdentity() || isIdentityEncrypted()) return null;
  // `unlockStoredIdentity()` with no passphrase succeeds only for an
  // unencrypted identity (the encrypted/missing cases are filtered above); it
  // returns usable CryptoKey objects, so sign directly.
  const identity = await unlockStoredIdentity();
  const data = new TextEncoder().encode(message).buffer as ArrayBuffer;
  const signature = await sign(identity.privateKey, data);
  return {
    signature,
    clientPublicKey: identity.publicKeyRaw,
    clientFingerprint: identity.fingerprint,
  };
}

/**
 * Attempt to deliver an answer directly to the daemon over HTTPS.
 *
 * Returns:
 *   - `delivered`        — the daemon accepted and routed the answer.
 *   - `delivered`        — the daemon accepted and routed the answer.
 *   - `rejected`         — the daemon refused as stale (409) / unknown (404); the
 *                          WebSocket would refuse identically, so do NOT retry.
 *   - `auth-failed`      — HTTP 401 (missing/invalid detached signature); the WS
 *                          handshake may still succeed, so the caller MAY fall back.
 *   - `unreachable`      — network error / not directly reachable; caller may fall
 *                          back to the WebSocket reconnect path.
 *   - `needs-passphrase` — auth required but no usable (unlocked) identity to sign.
 */
export async function relayAnswerDirect(input: RelayInput): Promise<RelayResult> {
  const { wsUrl, sessionId, questionId, answer, claudeSessionId, authRequired } = input;

  let httpUrl: string;
  try {
    httpUrl = answerUrl(wsUrl);
  } catch {
    return { kind: 'unreachable', reason: 'bad daemon url' };
  }

  // Canonical message the daemon binds the signature to.
  const message = `${sessionId}|${questionId}|${answer}`;

  let auth: { signature: string; clientPublicKey: string; clientFingerprint: string } | undefined;
  if (authRequired) {
    let built: Awaited<ReturnType<typeof buildAuth>>;
    try {
      built = await buildAuth(message);
    } catch (err) {
      return { kind: 'unreachable', reason: `sign failed: ${(err as Error).message ?? err}` };
    }
    if (built === null) {
      // Encrypted identity: cannot sign without a passphrase prompt.
      return { kind: 'needs-passphrase' };
    }
    auth = built;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        questionId,
        answer,
        ...(claudeSessionId ? { claudeSessionId } : {}),
        ...(auth ? { auth } : {}),
      }),
      signal: controller.signal,
    });

    let parsed: { result?: string } = {};
    try {
      parsed = (await res.json()) as { result?: string };
    } catch {
      // Non-JSON body; fall through to status-based handling.
    }

    if (res.ok && parsed.result === 'delivered') {
      return { kind: 'delivered' };
    }
    // HTTP 401: the detached signature was missing/invalid (e.g. the /auth-info
    // probe timed out so no signature was sent). The WebSocket uses an
    // interactive challenge-response, so it may still succeed — let the caller
    // fall back to WS rather than giving up.
    if (res.status === 401) {
      return { kind: 'auth-failed', result: parsed.result ?? 'unauthorized' };
    }
    // A definitive refusal (stale=409, session-not-found=404, bad-request=400)
    // means the WebSocket would refuse identically — do not fall back.
    return { kind: 'rejected', result: parsed.result ?? `http ${res.status}` };
  } catch (err) {
    // Network error / timeout / daemon not directly reachable (e.g. WebRTC-only).
    const reason = (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network error';
    return { kind: 'unreachable', reason };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Convert the signaling base URL + room code to its `https://host/answer/{code}`
 * form (#591). Accepts `ws(s)://` or `http(s)://`. Throws on an unsupported scheme.
 */
export function signalingAnswerUrl(signalingUrl: string, code: string): string {
  const u = new URL(signalingUrl);
  let scheme: string;
  if (u.protocol === 'wss:') scheme = 'https:';
  else if (u.protocol === 'ws:') scheme = 'http:';
  else if (u.protocol === 'https:' || u.protocol === 'http:') scheme = u.protocol;
  else throw new Error(`Unsupported scheme: ${u.protocol}`);
  return `${scheme}//${u.host}/answer/${encodeURIComponent(code)}`;
}

interface SignalingRelayInput {
  /** Signaling base URL (`wss://…workers.dev` or `https://…`). */
  readonly signalingUrl: string;
  /** Connection code naming the daemon's room. */
  readonly code: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly answer: string;
  readonly claudeSessionId?: string | undefined;
  /** When true, sign the request (the daemon verifies it on the relay path). */
  readonly authRequired: boolean;
  readonly timeoutMs?: number;
}

/**
 * Deliver an answer via the signaling Worker's reverse relay (#591) — the path
 * for a remote phone whose daemon is not directly reachable (WebRTC-relay case),
 * where `relayAnswerDirect` returns `unreachable`. The Worker forwards the signed
 * answer into the daemon's room WebSocket; the daemon verifies the signature, so
 * we sign whenever an identity is available.
 *
 * Returns the same `RelayResult` shape as `relayAnswerDirect`. A 503 (`no-peer`,
 * the daemon is not connected to the room) is reported as `unreachable` so the
 * caller can still fall back to a WebSocket reconnect.
 */
export async function relayAnswerViaSignaling(input: SignalingRelayInput): Promise<RelayResult> {
  let httpUrl: string;
  try {
    httpUrl = signalingAnswerUrl(input.signalingUrl, input.code);
  } catch {
    return { kind: 'unreachable', reason: 'bad signaling url' };
  }

  const message = `${input.sessionId}|${input.questionId}|${input.answer}`;
  let auth: { signature: string; clientPublicKey: string; clientFingerprint: string } | undefined;
  if (input.authRequired) {
    let built: Awaited<ReturnType<typeof buildAuth>>;
    try {
      built = await buildAuth(message);
    } catch (err) {
      const detail = err instanceof Error ? err.message || err.name : String(err);
      return { kind: 'unreachable', reason: `sign failed: ${detail}` };
    }
    if (built === null) {
      return { kind: 'needs-passphrase' };
    }
    auth = built;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.sessionId,
        questionId: input.questionId,
        answer: input.answer,
        ...(input.claudeSessionId ? { claudeSessionId: input.claudeSessionId } : {}),
        ...(auth ? { auth } : {}),
      }),
      signal: controller.signal,
    });

    let parsed: { result?: string } = {};
    try {
      parsed = (await res.json()) as { result?: string };
    } catch {
      // Non-JSON body; fall through to status-based handling.
    }

    if (res.ok && parsed.result === 'delivered') {
      return { kind: 'delivered' };
    }
    // 503 no-peer (daemon not connected to the room) or 502 send-failed (the
    // daemon's room WS dropped at the moment of the relay) may still resolve via a
    // WebSocket reconnect, so report as unreachable (caller MAY fall back).
    if (res.status === 503 || res.status === 502) {
      return { kind: 'unreachable', reason: parsed.result ?? `http ${res.status}` };
    }
    // 410 room-expired: the connection code is stale; a reconnect won't help, so
    // surface as a definitive refusal like a stale answer.
    if (res.status === 410) {
      return { kind: 'rejected', result: parsed.result ?? 'room-expired' };
    }
    return { kind: 'rejected', result: parsed.result ?? `http ${res.status}` };
  } catch (err) {
    const reason = (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network error';
    return { kind: 'unreachable', reason };
  } finally {
    clearTimeout(timeoutId);
  }
}
