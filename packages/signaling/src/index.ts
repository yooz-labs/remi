/**
 * Remi Signaling Worker
 *
 * Handles WebRTC signaling for P2P connections.
 * Uses Cloudflare Durable Objects for state management.
 *
 * Endpoints:
 * - POST /rooms: Create a new signaling room (returns room ID)
 * - GET /rooms/:id: WebSocket upgrade for joining a room
 * - GET /health: Health check
 */

import { normalizeCode } from './code-generator.ts';
import { ConnectionRoom } from './connection-room.ts';

// Cloudflare-specific types
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type DurableObjectNamespace = any;

/** Environment bindings */
interface Env {
  CONNECTIONS: DurableObjectNamespace;
  MAX_CONNECTIONS_PER_ROOM: string;
  CONNECTION_TIMEOUT_MS: string;
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

    // Create new room (host connects)
    if (url.pathname === '/connect' && request.method === 'GET') {
      // Generate a unique room ID
      const roomId = crypto.randomUUID();

      // Get the Durable Object stub
      const id = env.CONNECTIONS.idFromName(roomId);
      const room = env.CONNECTIONS.get(id);

      // Forward the WebSocket upgrade request
      return room.fetch(request);
    }

    // Join existing room (client connects with code)
    const codeMatch = url.pathname.match(/^\/join\/([A-Z0-9-]+)$/i);
    if (codeMatch && request.method === 'GET') {
      const rawCode = codeMatch[1];
      const code = normalizeCode(rawCode ?? '');

      if (!code) {
        return new Response(
          JSON.stringify({ error: 'INVALID_CODE', message: 'Invalid connection code format' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Use the code as the room ID to find the right Durable Object
      // This requires the host to register with a specific code
      // For now, we'll use a simple approach where the code IS the room identifier
      const id = env.CONNECTIONS.idFromName(code);
      const room = env.CONNECTIONS.get(id);

      // Forward the WebSocket upgrade request
      return room.fetch(request);
    }

    // Register a new connection code (REST endpoint for hosts)
    if (url.pathname === '/register' && request.method === 'POST') {
      // Generate a code and create a room for it
      const { generateCode } = await import('./code-generator.ts');
      const code = generateCode();

      // Create Durable Object with code as ID
      const _id = env.CONNECTIONS.idFromName(code);

      // Return the code to the caller
      const timeoutMs = Number.parseInt(env.CONNECTION_TIMEOUT_MS) || 300000;
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

      return new Response(
        JSON.stringify({
          code,
          wsUrl: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/connect/${code}`,
          expiresAt,
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );
    }

    // Connect to a room by code (for WebSocket)
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

      // Get the room Durable Object
      const id = env.CONNECTIONS.idFromName(code);
      const room = env.CONNECTIONS.get(id);

      // Forward the WebSocket upgrade request
      return room.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};

// Export the Durable Object class
export { ConnectionRoom };
