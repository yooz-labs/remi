/**
 * Test-only Worker entry: the REAL worker and the REAL ConnectionRoom, plus a
 * subclass of the room with debug seams. Nothing here changes how the room
 * behaves on any route a client can reach; the seams are:
 *
 * - a clock: the room reads time through `now()`, and `/__clock` moves it, so a
 *   test ages a session by minutes without waiting;
 * - the alarm: `/__alarm` runs the room's `alarm()` now, at the room's clock;
 * - storage: `/__state` dumps storage, the pending alarm, every socket's
 *   attachment and a boot id (new when the object is rebuilt); `/__seed` writes keys;
 * - a tap: every message the object receives is recorded (role, stage and the
 *   raw bytes), which is how a test asserts what the Worker could see;
 * - `/__legacy`: accepts a socket with the attachment the pre-R2 room kept, as a
 *   deploy over a live legacy room would leave one behind.
 *
 * Routes are reached through `/__room/<rid>/__name`, which this entry forwards
 * to the room named `<rid>`.
 */

import type { RoomSocket } from '../../src/connection-room.ts';
import worker, { ConnectionRoom as RealRoom } from '../../src/index.ts';

interface Seen {
  readonly role: string;
  readonly stage: string;
  readonly kind: 'text' | 'binary';
  /** base64 of the bytes the object received */
  readonly bytes: string;
}

function base64(b: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < b.length; i += 8192) {
    binary += String.fromCharCode(...b.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export class ConnectionRoom extends RealRoom {
  /** New on every construction, so a test can see that the object was evicted and rebuilt. */
  private readonly boot = crypto.randomUUID();
  private skewMs = 0;
  private readonly seen: Seen[] = [];

  protected override now(): number {
    return Date.now() + this.skewMs;
  }

  override async webSocketMessage(ws: RoomSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as { r?: string; st?: string } | null;
    this.seen.push({
      role: att?.r ?? '?',
      stage: att?.st ?? '?',
      kind: typeof data === 'string' ? 'text' : 'binary',
      bytes: base64(
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data),
      ),
    });
    return super.webSocketMessage(ws, data);
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/__state')) {
      return Response.json({
        storage: Object.fromEntries(await this.state.storage.list({ prefix: '' })),
        alarm: await this.state.storage.getAlarm(),
        sockets: this.state.getWebSockets().map((ws) => ws.deserializeAttachment()),
        boot: this.boot,
        skewMs: this.skewMs,
      });
    }
    if (path.endsWith('/__seen')) return Response.json(this.seen);
    if (path.endsWith('/__legacy')) {
      const Pair = (
        globalThis as unknown as { WebSocketPair: new () => Record<number, RoomSocket> }
      ).WebSocketPair;
      const pair = new Pair();
      const [clientSide, serverSide] = [pair[0] as RoomSocket, pair[1] as RoomSocket];
      this.state.acceptWebSocket(serverSide, ['host']);
      serverSide.serializeAttachment({ role: 'host', urlCode: 'ABCD-2345' });
      return new Response(null, { status: 101, webSocket: clientSide } as ResponseInit);
    }
    if (path.endsWith('/__seed') && request.method === 'POST') {
      for (const [k, v] of Object.entries((await request.json()) as Record<string, unknown>)) {
        await this.state.storage.put(k, v);
      }
      return new Response('seeded');
    }
    if (path.endsWith('/__clock') && request.method === 'POST') {
      this.skewMs += ((await request.json()) as { advanceMs: number }).advanceMs;
      return new Response('advanced');
    }
    if (path.endsWith('/__alarm') && request.method === 'POST') {
      await this.alarm();
      return new Response('alarm ran');
    }
    return super.fetch(request);
  }
}

export { GlobalLimiter } from '../../src/index.ts';

export default {
  fetch(request: Request, env: { CONNECTIONS: unknown }): Promise<Response> | Response {
    const m = new URL(request.url).pathname.match(/^\/__room\/([0-9a-f]{32})(\/__[a-z]+)$/);
    if (m) {
      // biome-ignore lint/suspicious/noExplicitAny: Cloudflare namespace type
      const ns = env.CONNECTIONS as any;
      return ns.get(ns.idFromName(m[1])).fetch(request);
    }
    return worker.fetch(request, env as never);
  },
};
