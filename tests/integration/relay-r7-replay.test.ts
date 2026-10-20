/** Actual HubRelay + local Worker; replays captured encrypted DATA, not admission metadata. */
import { expect, test } from 'bun:test';
import { createPing, deserialize, relayV2, serialize } from '@remi/shared';
import { roomCloses, roomSeen } from '../../packages/signaling/tests/e2e/endpoints';
import { resumed } from './relay-r3-fixture';

test('actual DATA replay fails uniformly and cannot produce a second semantic pong', async () => {
  const running = await resumed();
  try {
    await running.channel.send(new TextEncoder().encode(serialize(createPing())));
    const plaintext = await running.channel.receive(await running.socket.binary());
    expect(plaintext && deserialize(new TextDecoder().decode(plaintext))?.type).toBe('pong');
    const rid = new URL(running.socket.ws.url).pathname.split('/').at(-1);
    if (!rid) throw new Error('Owned client room missing');
    const captured = (await roomSeen(running.worker, rid))
      .filter(
        (frame) => frame.role === 'client' && frame.stage === 'open' && frame.kind === 'binary',
      )
      .at(-1);
    if (!captured) throw new Error('Actual accepted DATA frame was not captured');
    const frame = new Uint8Array(Buffer.from(captured.bytes, 'base64'));
    expect(frame[0]).toBe(relayV2.TYPE_DATA);
    running.socket.sendBinary(frame);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([
        running.socket.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Replayed DATA was not refused')), 1500);
        }),
      ]);
      expect(closed.code).toBe(relayV2.FAILURE_CLOSE.code);
      // Carry R3's measured Bun 1.3.11 close defect (#1225): an immediate
      // failure close can lose its reason or reset. Require both real endpoints'
      // records before accepting either exception, never just an empty reason.
      const deadline = Date.now() + 1500;
      let pipe: string | undefined;
      while (Date.now() < deadline) {
        pipe = (await roomCloses(running.worker, rid))[0];
        if (pipe && running.logs.some((line) => line.startsWith('Relay pipe closed by '))) break;
        await Bun.sleep(10);
      }
      expect(running.logs.filter((line) => line.startsWith('Relay pipe closed by '))).toEqual([
        `Relay pipe closed by the hub (${relayV2.FAILURE_CLOSE.code})`,
      ]);
      if (Bun.version === '1.3.11' && pipe === 'close 4400 ""')
        expect(closed).toEqual({ code: relayV2.FAILURE_CLOSE.code, reason: '' });
      else {
        if (!(Bun.version === '1.3.11' && pipe?.startsWith('close 1006 ')))
          expect(pipe).toBe('close 4400 "closed"');
        expect(closed).toEqual(relayV2.FAILURE_CLOSE);
      }
      expect(await running.socket.quiet(50)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await running.cleanup();
  }
}, 15000);
