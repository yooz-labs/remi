/** Real source relay refuses the unqualified B2 family; NOT terminal transport availability. */
import { expect, test } from 'bun:test';
import { type SessionTerminalSnapshot, type TerminalViewRequest, serialize } from '@remi/shared';
import type { ChildProxy } from '../../packages/daemon/src/remote/child-proxy.ts';
import type { SessionRegistryFile } from '../../packages/daemon/src/session/session-registry-file.ts';
import vectors from '../../packages/shared/tests/fixtures/terminal-view/vectors.json';
import { resumed } from './relay-r3-fixture.ts';

for (const suffix of ['open', 'read', 'close']) {
  test(`B2 ${suffix} cannot allocate a child or cross the actual encrypted relay`, async () => {
    const running = await resumed();
    try {
      const frame = vectors.positive.find((v) => v.expected.type === `session_terminal_${suffix}`)
        ?.expected as TerminalViewRequest | undefined;
      if (!frame) throw new Error('Missing owned terminal control');
      const internals = running.relay as unknown as {
        cfg: { registry: SessionRegistryFile };
        peers: Map<string, { proxy: ChildProxy }>;
      };
      const proxy = [...internals.peers.values()][0]?.proxy;
      if (!proxy) throw new Error('Missing actual child proxy');
      const registry = internals.cfg.registry;
      let reads = 0;
      const original = registry.listLive.bind(registry);
      registry.listLive = (...args) => {
        reads++;
        return original(...args);
      };
      await expect(proxy.send(frame.sessionId, frame)).rejects.toThrow('TERMINAL_VIEW_UNAVAILABLE');
      expect(reads).toBe(0);
      await running.channel.send(new TextEncoder().encode(serialize(frame)));
      const until = Date.now() + 2000;
      while (!running.socket.isClosed && Date.now() < until) await Bun.sleep(10);
      expect(running.socket.isClosed).toBe(true);
      expect(reads).toBe(0);
    } finally {
      await running.cleanup();
    }
  }, 15000);
}

test('actual relay send/broadcast refuses a registered screen snapshot before encryption', async () => {
  const running = await resumed();
  try {
    const frame = vectors.positive.find((v) => v.expected.type === 'session_terminal_snapshot')
      ?.expected as SessionTerminalSnapshot | undefined;
    if (!frame) throw new Error('Missing owned screen control');
    expect(running.relay.sendRaw(running.cid, frame)).toBe(false);
    running.relay.broadcast(frame);
    expect(await running.socket.quiet(80)).toBe(true);
  } finally {
    await running.cleanup();
  }
}, 15000);
