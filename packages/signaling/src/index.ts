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
}

/** Per-IP rate limiter: 10 WebSocket upgrades per 60 seconds */
const rateLimiter = new RateLimiter(10, 60_000);

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
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

      // Rate limit per client IP
      const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!rateLimiter.check(clientIp)) {
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

    return new Response('Not found', { status: 404 });
  },
};

// Export the Durable Object class
export { ConnectionRoom };
