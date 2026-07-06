/**
 * Remi Signaling Worker
 *
 * Handles signaling for P2P connections via message relay.
 * Uses Cloudflare Durable Objects for state management.
 *
 * Endpoints:
 * - GET /connect/:code: WebSocket upgrade for host/client (both use same code-based room)
 * - GET /health: Health check
 */

import { errorToString } from '@remi/shared';
import { sendApnsPush } from './apns.ts';
import { normalizeCode } from './code-generator.ts';
import { ConnectionRoom } from './connection-room.ts';
import { RateLimiter } from './rate-limiter.ts';

// Cloudflare-specific types
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type DurableObjectNamespace = any;

/** Environment bindings */
interface Env {
  CONNECTIONS: DurableObjectNamespace;
  MAX_CONNECTIONS_PER_ROOM: string;
  CONNECTION_TIMEOUT_MS: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
  PUSH_SECRET?: string;
  /** Set to 'true' to use APNS sandbox endpoint for development builds */
  APNS_SANDBOX?: string;
}

/** Request body for the /push endpoint */
interface PushRequestBody {
  token?: string;
  title?: string;
  body?: string;
  /** Remi session UUID; included in APNS custom data for notification tap navigation */
  sessionId?: string;
  /** Question UUID so the client can send the right answer back */
  questionId?: string;
  /** APNS notification category identifier for action buttons */
  category?: string;
  /** Answer values for action buttons: mapped to opt_0, opt_1, ... in APNS data */
  options?: string[];
  /**
   * NSE dynamic-category hint (#719): when true and `options` is non-empty,
   * the push sets `mutable-content: 1` and a `dynCategory: "1"` data field so
   * the iOS Notification Service Extension can register a per-notification
   * category with the real option labels as action titles. Additive only —
   * `category` is still sent as the static fallback for a missing/failed NSE.
   */
  dynOptions?: boolean;
  /** Reserved for future per-request sandbox override; daemon does not send this today */
  sandbox?: boolean;
  /**
   * Dismissal trigger (#585, P7). When true, send a QUIET background push (no
   * alert) keyed by `apns-collapse-id` = questionId so the device clears the
   * lock-screen card for an already-resolved question.
   */
  dismiss?: boolean;
}

/** Per-IP rate limiter: 10 WebSocket upgrades per 60 seconds */
const rateLimiter = new RateLimiter(10, 60_000);
/**
 * Push budget (epic #603 Phase 2, R3). The old single per-IP limiter (5/60s)
 * was shared across every daemon behind one NAT and across alert + dismiss
 * pushes, each fanned out per device token — so a power user running several
 * worktree daemons hit 429 and silently dropped notifications. Now:
 *   - AUTHENTICATED callers (they hold PUSH_SECRET, so they are trusted) are
 *     keyed by identity, not IP, with a ceiling well above
 *     (device tokens x concurrent sessions). Sharing a NAT no longer throttles.
 *   - UNAUTHENTICATED callers (only possible when no PUSH_SECRET is configured)
 *     keep the original tight per-IP fallback to limit abuse.
 *   - DISMISS pushes get their own budget so quiet resolutions never starve
 *     alert pushes.
 */
const PUSH_AUTH_LIMIT = 60;
const pushAuthRateLimiter = new RateLimiter(PUSH_AUTH_LIMIT, 60_000);
const pushIpRateLimiter = new RateLimiter(5, 60_000);
const dismissRateLimiter = new RateLimiter(PUSH_AUTH_LIMIT, 60_000);
/** Per-IP rate limiter for the answer relay: 10 answers per 60 seconds */
const answerRateLimiter = new RateLimiter(10, 60_000);

/**
 * A stable, non-secret rate-limit bucket key for an authenticated push identity
 * (epic #603 Phase 2). Hashes the shared secret (djb2) so the key never stores
 * the secret itself, and distinct secrets (multi-tenant) get distinct buckets.
 */
function authBucketKey(secret: string): string {
  let h = 5381;
  for (let i = 0; i < secret.length; i++) {
    h = ((h << 5) + h + secret.charCodeAt(i)) | 0;
  }
  return `auth:${(h >>> 0).toString(36)}`;
}

/** Main worker */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version',
        },
      });
    }

    // Connect to a room by code (WebSocket upgrade for both host and client)
    const connectMatch = url.pathname.match(/^\/connect\/([A-Z0-9-]+)$/i);
    if (connectMatch && request.method === 'GET') {
      const rawCode = connectMatch[1];
      const code = normalizeCode(rawCode ?? '');

      if (!code) {
        return new Response(
          JSON.stringify({ error: 'INVALID_CODE', message: 'Invalid connection code format' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Rate limit per client IP (skip if IP unavailable)
      const clientIp = request.headers.get('CF-Connecting-IP');
      if (clientIp && !rateLimiter.check(clientIp)) {
        return new Response(
          JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many connection attempts' }),
          { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
        );
      }

      // Both host and client connect to the same code-named Durable Object
      const id = env.CONNECTIONS.idFromName(code);
      const room = env.CONNECTIONS.get(id);

      // Forward the WebSocket upgrade request (URL contains the code for the DO to extract)
      return room.fetch(request);
    }

    // Answer relay (#591): phone -> daemon answer for a held permission, used
    // when the phone has no live WebSocket (lock-screen / backgrounded). Forwards
    // the answer into the daemon's room WebSocket. Code-gated like joining the
    // room; the daemon verifies the Ed25519 `auth` signature before acting.
    const answerMatch = url.pathname.match(/^\/answer\/([A-Z0-9-]+)$/i);
    if (answerMatch && request.method === 'POST') {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      };
      const answerCode = normalizeCode(answerMatch[1] ?? '');
      if (!answerCode) {
        return new Response(
          JSON.stringify({ error: 'INVALID_CODE', message: 'Invalid connection code format' }),
          { status: 400, headers: corsHeaders },
        );
      }
      const answerIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!answerRateLimiter.check(answerIp)) {
        return new Response(
          JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many answer requests' }),
          { status: 429, headers: { ...corsHeaders, 'Retry-After': '60' } },
        );
      }
      // Route to the same code-named room the daemon registered; the DO forwards
      // the POST body to the host WebSocket (see ConnectionRoom.handleAnswerRelay).
      const answerRoomId = env.CONNECTIONS.idFromName(answerCode);
      const answerRoom = env.CONNECTIONS.get(answerRoomId);
      return answerRoom.fetch(request);
    }

    // Push notification trigger endpoint (authenticated, rate-limited)
    if (url.pathname === '/push' && request.method === 'POST') {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      };

      // Authenticate: daemon must provide the shared secret
      if (env.PUSH_SECRET) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader !== `Bearer ${env.PUSH_SECRET}`) {
          return new Response(
            JSON.stringify({ error: 'UNAUTHORIZED', message: 'Invalid or missing authorization' }),
            { status: 401, headers: corsHeaders },
          );
        }
      }

      if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
        return new Response(
          JSON.stringify({ error: 'APNS_NOT_CONFIGURED', message: 'APNS credentials not set' }),
          { status: 500, headers: corsHeaders },
        );
      }

      let body: PushRequestBody;
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ error: 'INVALID_JSON', message: 'Request body must be valid JSON' }),
          { status: 400, headers: corsHeaders },
        );
      }

      // A dismissal (#585, P7) is a quiet content-available push with no
      // user-visible text, so title/body are not required for it — only the
      // token (the device) and the questionId (the collapse-id target, validated
      // below by buildApnsRequest's collapse-id handling). An alert push still
      // requires all three.
      const isDismiss = body.dismiss === true;
      if (!body.token || (!isDismiss && (!body.title || !body.body))) {
        return new Response(
          JSON.stringify({
            error: 'MISSING_FIELDS',
            message: isDismiss ? 'token is required' : 'token, title, and body are required',
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Rate limit (epic #603 Phase 2, R3). Authenticated callers are keyed by
      // identity with a generous ceiling (a shared NAT IP no longer throttles
      // them); dismiss pushes draw from a separate budget so they cannot starve
      // alerts. Malformed/auth-failed requests above never reach here, so they
      // do not consume budget.
      // `authed` must mean "this request proved possession of the secret", not
      // merely "a secret is configured" — re-check the bearer so a future
      // refactor of the auth block above cannot silently grant the trusted
      // budget to an unauthenticated caller.
      const authed =
        Boolean(env.PUSH_SECRET) &&
        request.headers.get('Authorization') === `Bearer ${env.PUSH_SECRET}`;
      const pushClientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const rlKey = authed ? authBucketKey(env.PUSH_SECRET as string) : `ip:${pushClientIp}`;
      // Unauthenticated callers (only when no PUSH_SECRET is configured) always
      // use the tight per-IP fallback — INCLUDING dismisses, which must not get
      // the raised budget. Authenticated alert vs dismiss draw from separate
      // raised budgets so a dismiss flood cannot starve alerts.
      const limiter = !authed
        ? pushIpRateLimiter
        : isDismiss
          ? dismissRateLimiter
          : pushAuthRateLimiter;
      if (!limiter.check(rlKey)) {
        return new Response(
          JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many push requests' }),
          { status: 429, headers: corsHeaders },
        );
      }

      // bundleId is always server-controlled (never from client)
      const bundleId = env.APNS_BUNDLE_ID || 'live.yooz.remi';
      // sandbox: the PREFERRED APNS environment to try first (#618 dual-env makes
      // `sendApnsPush` fall back to the other environment on a BadDeviceToken, so
      // this flag only saves a round-trip for the common case — it is no longer a
      // hard gate). body.sandbox is reserved for future per-request override — the
      // daemon does not send it today (payload is Record<string, string>).
      // `.trim()`: a secret set via `echo "true" | wrangler secret put` carries a
      // trailing newline, so an exact `=== 'true'` silently fails — match leniently.
      const sandbox = env.APNS_SANDBOX?.trim() === 'true' || body.sandbox === true;
      // Build custom data for notification payload (sibling to aps).
      // Include sessionId, questionId, and per-option answer values (opt_0, opt_1, ...).
      const data: Record<string, string> = {};
      if (body.sessionId && body.sessionId.length > 0) {
        data['sessionId'] = body.sessionId;
      }
      if (body.questionId && body.questionId.length > 0) {
        data['questionId'] = body.questionId;
      }
      if (Array.isArray(body.options)) {
        body.options.forEach((val, idx) => {
          data[`opt_${idx}`] = String(val);
        });
      }
      // #719: only meaningful alongside real options — a dynCategory hint with
      // nothing in opt_0.. would just make the NSE run for no benefit. The
      // upper bound (6) is an INVARIANT CHAIN shared with the NSE's own
      // option-count ceiling (NotificationService.swift's `0...5` loop) and is
      // deliberately looser than the daemon's current 2-4 gate
      // (notification-dispatcher.ts `selectDynOptions`), so loosening the
      // daemon gate up to 6 needs no worker change. Keep all three in sync if
      // the ceiling itself ever moves.
      const wantsDynCategory =
        body.dynOptions === true &&
        Array.isArray(body.options) &&
        body.options.length >= 2 &&
        body.options.length <= 6;
      if (wantsDynCategory) {
        data['dynCategory'] = '1';
      }
      const category = body.category && body.category.length > 0 ? body.category : undefined;

      let result: { success: boolean; error?: string };
      try {
        result = await sendApnsPush(
          {
            token: body.token,
            // For a dismissal these are absent; buildApnsRequest ignores them in
            // dismiss mode (no alert), so default to empty strings to satisfy the
            // ApnsPayload shape without surfacing any text.
            title: body.title ?? '',
            body: body.body ?? '',
            bundleId,
            sandbox,
            data: Object.keys(data).length > 0 ? data : undefined,
            category,
            // #719: mutable-content lets the NSE intercept and mutate the
            // notification before display (to attach the dynamic category);
            // only set when there is something for it to build actions from.
            ...(wantsDynCategory ? { mutableContent: true } : {}),
            // Collapse repeated pushes for the same question (#575, P4a).
            ...(body.questionId && body.questionId.length > 0
              ? { collapseId: body.questionId }
              : {}),
            // Quiet dismissal of an already-resolved question (#585, P7).
            ...(body.dismiss === true ? { dismiss: true } : {}),
          },
          { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKey: env.APNS_PRIVATE_KEY },
        );
      } catch (err) {
        const msg = errorToString(err);
        result = { success: false, error: `APNS internal error: ${msg}` };
      }

      if (result.success) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      // Surface a PERMANENT token rejection as a structured flag (epic #603
      // Phase 2 -> consumed by Phase 6 token pruning). APNS reports these as a
      // 4xx that the Worker wraps in `result.error`; the daemon prunes the dead
      // token instead of retrying it forever. The reason text is kept in `error`
      // so the daemon's transient-vs-permanent classifier (#603 Phase 1) still
      // works off the message.
      const tokenInvalid = /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/i.test(
        result.error ?? '',
      );
      return new Response(JSON.stringify({ success: false, error: result.error, tokenInvalid }), {
        status: 502,
        headers: corsHeaders,
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

// Export the Durable Object class
export { ConnectionRoom };
