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
}

/** Per-IP rate limiter: 10 WebSocket upgrades per 60 seconds */
const rateLimiter = new RateLimiter(10, 60_000);
/** Per-IP rate limiter for push: 5 pushes per 60 seconds */
const pushRateLimiter = new RateLimiter(5, 60_000);

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

      // Rate limit per IP
      const pushClientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!pushRateLimiter.check(pushClientIp)) {
        return new Response(
          JSON.stringify({ error: 'RATE_LIMITED', message: 'Too many push requests' }),
          { status: 429, headers: corsHeaders },
        );
      }

      if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
        return new Response(
          JSON.stringify({ error: 'APNS_NOT_CONFIGURED', message: 'APNS credentials not set' }),
          { status: 500, headers: corsHeaders },
        );
      }

      let body: { token?: string; title?: string; body?: string };
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ error: 'INVALID_JSON', message: 'Request body must be valid JSON' }),
          { status: 400, headers: corsHeaders },
        );
      }

      if (!body.token || !body.title || !body.body) {
        return new Response(
          JSON.stringify({
            error: 'MISSING_FIELDS',
            message: 'token, title, and body are required',
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      // bundleId is always server-controlled (never from client)
      const bundleId = env.APNS_BUNDLE_ID || 'live.yooz.remi';

      const result = await sendApnsPush(
        { token: body.token, title: body.title, body: body.body, bundleId },
        { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKey: env.APNS_PRIVATE_KEY },
      );

      if (result.success) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify({ success: false, error: result.error }), {
        status: 502,
        headers: corsHeaders,
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

// Export the Durable Object class
export { ConnectionRoom };
