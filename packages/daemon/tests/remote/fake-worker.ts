/**
 * A local stand-in for the signaling Worker: a real Bun WebSocket server on
 * 127.0.0.1 that records how many sockets connect and which frames the daemon
 * sends, and lets a test push frames back. It never touches the network
 * beyond loopback, and never the live Worker.
 *
 * The frame shapes mirror `packages/signaling/src/connection-room.ts`: the host
 * registers with `{type:"register"}`, the Worker answers `registered`, and
 * reports a client with `peer-connected` (role `client`) and a closing socket
 * with `peer-disconnected` carrying that socket's role.
 */

import type { ServerWebSocket } from 'bun';

export interface FakeWorker {
  /** `ws://127.0.0.1:<port>/connect`, the form `--signaling-url` takes. */
  readonly url: string;
  /** Sockets upgraded so far (the daemon opens one per registration attempt). */
  readonly connections: () => number;
  /** Request paths of those upgrades, in order (`/connect/<code>`). */
  readonly paths: () => string[];
  /** Text frames the daemon sent, parsed as JSON. */
  readonly received: () => Array<Record<string, unknown>>;
  /** Send one frame to the most recently connected socket. */
  send(frame: Record<string, unknown>): void;
  stop(): void;
}

export function startFakeWorker(
  onFrame?: (frame: Record<string, unknown>, worker: FakeWorker) => void,
): FakeWorker {
  const sockets: ServerWebSocket<unknown>[] = [];
  const paths: string[] = [];
  const received: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      paths.push(new URL(req.url).pathname);
      if (srv.upgrade(req)) return undefined;
      return new Response('expected a WebSocket', { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
      },
      message(_ws, message) {
        const frame = JSON.parse(String(message)) as Record<string, unknown>;
        received.push(frame);
        onFrame?.(frame, worker);
      },
    },
  });
  const worker: FakeWorker = {
    url: `ws://127.0.0.1:${server.port}/connect`,
    connections: () => paths.length,
    paths: () => [...paths],
    received: () => [...received],
    send: (frame) => {
      sockets.at(-1)?.send(JSON.stringify(frame));
    },
    stop: () => server.stop(true),
  };
  return worker;
}

/** Poll for an effect (events, not fixed sleeps); throws with `what` on timeout. */
export async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
