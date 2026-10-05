import { expect, test } from 'bun:test';
import { createRawPtyOutput, createSessionUpdate } from '@remi/shared';
import { AdapterRegistry } from '../../packages/daemon/src/adapters/adapter-registry.ts';
import { HubRelay } from '../../packages/daemon/src/remote/hub-relay.ts';
import { resumed } from './relay-r3-fixture.ts';

test('registry refuses raw PTY before invoking the actual relay adapter, which also refuses it', async () => {
  const running = await resumed();
  try {
    const registry = new AdapterRegistry();
    registry.register(running.relay);
    registry.trackConnection(running.cid, 'relay');
    let sends = 0;
    let broadcasts = 0;
    const send = running.relay.sendRaw.bind(running.relay);
    const broadcast = running.relay.broadcast.bind(running.relay);
    running.relay.sendRaw = (...args) => {
      sends++;
      return send(...args);
    };
    running.relay.broadcast = (...args) => {
      broadcasts++;
      return broadcast(...args);
    };
    const raw = createRawPtyOutput('owned-session', 'PRIVATE_RAW_BOUNDARY_SENTINEL');
    expect(registry.sendRaw(running.cid, raw)).toBe(false);
    registry.broadcast(raw);
    expect(sends).toBe(0);
    expect(broadcasts).toBe(0);
    expect(send(running.cid, raw)).toBe(false);
    broadcast(raw);
    expect(await running.socket.quiet(80)).toBe(true);
  } finally {
    await running.cleanup();
  }
}, 10000);

test('external revoke after enqueue prevents asynchronous encryption from emitting session content', async () => {
  const running = await resumed();
  try {
    const frames: Uint8Array[] = [];
    running.socket.tap((frame) => {
      if (typeof frame !== 'string') frames.push(frame);
    });
    expect(running.relay.sendRaw(running.cid, createSessionUpdate('owned-session', 'idle'))).toBe(
      true,
    );
    expect(running.trust.removeAuthorizedKey(running.device.fingerprint)).toBe(true);
    await Bun.sleep(80);
    expect(frames.filter((frame) => frame[0] === relayV2.TYPE_DATA)).toHaveLength(0);
    expect(running.socket.isClosed).toBe(true);
    expect(running.relay.connectionCount).toBe(0);
  } finally {
    await running.cleanup();
  }
}, 10000);

test('production hub refuses non-system RNG and injected ephemeral crypto before admission', async () => {
  const running = await resumed();
  try {
    const cfg = (running.relay as unknown as { cfg: ConstructorParameters<typeof HubRelay>[0] })
      .cfg;
    expect(() => new HubRelay({ ...cfg, random: () => new Uint8Array(32) })).toThrow(
      'RELAY_PRODUCTION_CRYPTO_REQUIRED',
    );
    expect(
      () =>
        new HubRelay({
          ...cfg,
          ephemeral: async () => {
            throw new Error('unused');
          },
        }),
    ).toThrow('RELAY_PRODUCTION_CRYPTO_REQUIRED');
  } finally {
    await running.cleanup();
  }
}, 10000);
