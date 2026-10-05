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
 * - a barrier: `/__barrier` makes the next admissions that present a ticket wait,
 *   just before the window is burned, until that many have arrived, then released
 *   together, so a test races the burn on purpose; a size of zero releases held admissions;
 * - an enrollment-read barrier: `/__readbarrier` holds a real storage read's result after
 *   its input gate has completed, to pin cancellation across an asynchronous admission;
 * - `/__legacy`: accepts a socket with the attachment the pre-R2 room kept, as a
 *   deploy over a live legacy room would leave one behind.
 *
 * Routes are reached through `/__room/<rid>/__name`, which this entry forwards
 * to the room named `<rid>`.
 */

import type { ApnsRequest } from '../../src/apns.ts';
import type { RoomEnv, RoomSocket, RoomState } from '../../src/connection-room.ts';
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
  private barrierSize = 0;
  private readonly held: (() => void)[] = [];
  private readonly readBarrier: {
    key: string | null;
    reached: boolean;
    held: (() => void)[];
  };

  constructor(state: RoomState, env: RoomEnv) {
    const barrier = { key: null as string | null, reached: false, held: [] as (() => void)[] };
    // Delegate every operation to real SQLite storage. Only the delivery of a selected read's
    // result waits: this tests a possible await interleaving, not current workerd scheduling.
    const storage = new Proxy(state.storage, {
      get(target, name) {
        if (name === 'get') {
          return async (key: string) => {
            const value = await target.get(key);
            if (key === barrier.key && value !== undefined) {
              barrier.reached = true;
              await new Promise<void>((resolve) => barrier.held.push(resolve));
            }
            return value;
          };
        }
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const wrapped = new Proxy(state, {
      get(target, name) {
        if (name === 'storage') return storage;
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(wrapped, env);
    this.readBarrier = barrier;
  }

  /** ONLY network destination differs: actual request/JWT/proof/storage logic stays real. */
  protected override sendPushRequest(request: ApnsRequest): Promise<Response> {
    const endpoint = (this.env as unknown as Record<string, string>)['TEST_APNS_ENDPOINT'];
    if (!endpoint) return super.sendPushRequest(request);
    return fetch(`${endpoint}${new URL(request.url).pathname}`, {
      method: 'POST',
      headers: { ...request.headers, 'x-owned-apns-url': request.url },
      body: request.body,
    });
  }

  protected override now(): number {
    return Date.now() + this.skewMs;
  }

  protected override async beforeBurn(): Promise<void> {
    if (this.barrierSize === 0) return;
    if (this.held.length + 1 >= this.barrierSize) {
      this.barrierSize = 0;
      for (const release of this.held.splice(0)) release();
      return;
    }
    await new Promise<void>((resolve) => this.held.push(resolve));
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

  private readonly closes: string[] = [];
  override async webSocketClose(ws: RoomSocket, code: number, reason: string): Promise<void> {
    this.closes.push(`close ${code} ${JSON.stringify(reason)}`);
    return super.webSocketClose(ws, code, reason);
  }
  override async webSocketError(ws: RoomSocket): Promise<void> {
    this.closes.push('error');
    return super.webSocketError(ws);
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
    if (path.endsWith('/__readbarrier')) {
      if (request.method === 'POST') {
        this.readBarrier.key = ((await request.json()) as { key: string | null }).key;
        this.readBarrier.reached = false;
        if (this.readBarrier.key === null) {
          for (const release of this.readBarrier.held.splice(0)) release();
        }
      }
      return Response.json({ reached: this.readBarrier.reached });
    }
    if (path.endsWith('/__closes')) return Response.json(this.closes);
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
    if (path.endsWith('/__barrier') && request.method === 'POST') {
      this.barrierSize = ((await request.json()) as { size: number }).size;
      if (this.barrierSize === 0) {
        for (const release of this.held.splice(0)) release();
      }
      return new Response('barrier set');
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
