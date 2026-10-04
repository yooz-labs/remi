/**
 * Test-only Worker entry: the REAL worker and the REAL ConnectionRoom, plus a
 * subclass of the room that adds debug routes so a test can inspect and seed
 * Durable Object storage over HTTP and fire the alarm on demand. Nothing here
 * changes how the room behaves on any other route.
 *
 * Routes (reached through `/__room/<name>/...`, which the entry forwards to the
 * room named `<name>`):
 * - GET  /__state  storage contents, pending alarm, socket count and a boot id
 * - POST /__seed   write the JSON body's keys into storage
 * - POST /__alarm  run the room's `alarm()` now
 */

import worker, { ConnectionRoom as RealRoom } from '../../src/index.ts';

export class ConnectionRoom extends RealRoom {
  /** New on every construction, so a test can see that the object was evicted and rebuilt. */
  private readonly boot = crypto.randomUUID();

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // biome-ignore lint/suspicious/noExplicitAny: reach the Durable Object state for the debug routes
    const state = (this as any).state;
    if (path.endsWith('/__state')) {
      return Response.json({
        storage: Object.fromEntries(await state.storage.list()),
        alarm: await state.storage.getAlarm(),
        sockets: state.getWebSockets().length,
        boot: this.boot,
      });
    }
    if (path.endsWith('/__seed') && request.method === 'POST') {
      await state.storage.put((await request.json()) as Record<string, unknown>);
      return new Response('seeded');
    }
    if (path.endsWith('/__alarm') && request.method === 'POST') {
      await this.alarm();
      return new Response('alarm ran');
    }
    return super.fetch(request);
  }
}

export default {
  fetch(request: Request, env: { CONNECTIONS: unknown }): Promise<Response> | Response {
    const m = new URL(request.url).pathname.match(/^\/__room\/([A-Za-z0-9-]+)(\/__[a-z]+)$/);
    if (m) {
      // biome-ignore lint/suspicious/noExplicitAny: Cloudflare namespace type
      const ns = env.CONNECTIONS as any;
      return ns.get(ns.idFromName(m[1])).fetch(request);
    }
    return worker.fetch(request, env as never);
  },
};
