/**
 * Remi relay Worker (R2, #1197, ADR 0034).
 *
 * A courier for end-to-end encrypted frames between a machine (the host) and
 * the devices enrolled with it. It admits sockets, pairs a client with the
 * host's pipe and forwards bytes it never parses; it never sees a session id, a
 * device name, a pairing secret, a key or any frame content.
 *
 * Routes (the version is part of the path and is never negotiated):
 * - GET /v2/host/<rid>: the machine's control socket (WebSocket upgrade)
 * - GET /v2/client/<rid>: an enrolled device, or one pairing with a ticket
 * - GET /v2/pipe/<rid>/<cid>: the host's socket for one client connection
 * - GET /health: health check
 * - POST /push: the LEGACY plaintext push, unchanged until push privacy (R5) ships
 *
 * Deleted by R2: the code-named room `/connect/<code>`, the `/answer/<code>`
 * relay and the offer, answer and ice-candidate forwarding.
 */

import { errorToString } from '@remi/shared';
import { parseWorkerPath } from '@remi/shared/relay/index.ts';
import { sendApnsPush } from './apns.ts';
import { ConnectionRoom } from './connection-room.ts';
import { GlobalLimiter, withinBudget } from './limiter.ts';
import { type LimitEnv, limit } from './limits.ts';
import { RateLimiter } from './rate-limiter.ts';

// Cloudflare-specific types
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type DurableObjectNamespace = any;

/** Environment bindings */
interface Env extends LimitEnv {
  /** One room per machine, named by the room id. */
  CONNECTIONS: DurableObjectNamespace;
  /** The global rate limiter. */
  LIMITER: DurableObjectNamespace;
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
  /**
   * Which class of push this is (#968): 'question' | 'turn_complete' |
   * 'subagent_alert' | 'harness_denied' (#1126) | 'turn_failed' (#1153) |
   * 'dismiss'. Passed through verbatim into APNS custom data as `kind` so the
   * client can label and route by class instead of inferring
   * it from the ABSENCE of `questionId`/`category` — an inference that could
   * never tell a turn-complete push from a subagent alert, since those two are
   * identical on the wire.
   *
   * Not validated against the known set: the worker only forwards it, and
   * rejecting an unrecognized value here would mean a daemon adding a new class
   * needs a worker redeploy before its pushes work at all.
   */
  kind?: string;
}

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
/**
 * Dismiss ceiling (#723). Sharing PUSH_AUTH_LIMIT starved dismissals in
 * practice: ALL of a machine's daemons share one identity bucket, and every
 * resolved question fans a dismissal out per device token, so a multi-session
 * agent-team soak (4+ sessions x 2 tokens) blew through 60/min and left
 * already-answered cards on the lock screen. Dismisses are quiet
 * content-available pushes with no alert cost, so the ceiling is only a
 * runaway-loop backstop — sized ~5x the alert budget rather than removed.
 */
const DISMISS_AUTH_LIMIT = 300;
const pushAuthRateLimiter = new RateLimiter(PUSH_AUTH_LIMIT, 60_000);
const pushIpRateLimiter = new RateLimiter(5, 60_000);
const dismissRateLimiter = new RateLimiter(DISMISS_AUTH_LIMIT, 60_000);

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

    // The relay: a WebSocket upgrade to a host, client or pipe route.
    const route = request.method === 'GET' ? parseWorkerPath(url.pathname) : null;
    if (route) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      // Limits are global (one Durable Object counts for every isolate) and fail closed: a
      // request that cannot be counted is refused. A request with no address header shares the
      // key `unknown` instead of skipping the check.
      const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const perAddress = {
        client: limit(env, 'LIMIT_IP_CLIENT'),
        host: limit(env, 'LIMIT_IP_HOST'),
        pipe: limit(env, 'LIMIT_IP_PIPE'),
      }[route.role];
      const windowMs = limit(env, 'LIMIT_WINDOW_MS');
      try {
        const allowed =
          (await withinBudget(env.LIMITER, `ip:${route.role}:${address}`, perAddress, windowMs)) &&
          (await withinBudget(
            env.LIMITER,
            `rid:${route.ridHex}`,
            limit(env, 'LIMIT_RID'),
            windowMs,
          ));
        if (!allowed) {
          return new Response(
            JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many connection attempts' }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
          );
        }
      } catch {
        return new Response(
          JSON.stringify({ error: 'LIMITER_UNAVAILABLE', message: 'Try again shortly' }),
          { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } },
        );
      }
      // One Durable Object per machine, named by the room id. The room checks the route again.
      return env.CONNECTIONS.get(env.CONNECTIONS.idFromName(route.ridHex)).fetch(request);
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
      // #968: forwarded verbatim, capped so a malformed value cannot bloat the
      // APNS payload (Apple caps an alert payload at 4KB).
      if (typeof body.kind === 'string' && body.kind.length > 0) {
        data['kind'] = body.kind.slice(0, 32);
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
            // `data`/`category` are optional-without-`| undefined` on
            // ApnsPayload; spread instead of assigning `undefined` so an
            // absent value omits the key rather than tripping
            // exactOptionalPropertyTypes (#946).
            ...(Object.keys(data).length > 0 ? { data } : {}),
            ...(category ? { category } : {}),
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

// Export the Durable Object classes
export { ConnectionRoom, GlobalLimiter };
